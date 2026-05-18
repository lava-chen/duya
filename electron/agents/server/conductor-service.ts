import { spawn, fork, ChildProcess } from 'child_process';
import * as http from 'http';
import { randomUUID } from 'crypto';
import {
  ConductorSession,
  ConductorSessionState,
  CanvasState,
  CanvasElement,
  CanvasInfo,
  CanvasPosition,
  VizSpec,
  ConductorAction,
  ConductorSSEEvent,
  SubAgentInfo,
} from './types';
import { WorkerManager } from './worker-manager';
import { workerLogger } from './logger';

type DbRequestFn = (action: string, payload: Record<string, unknown>) => Promise<unknown>;

export class ConductorService {
  private sessions = new Map<string, ConductorSession>();
  private workerManager: WorkerManager;
  private dbRequest: DbRequestFn;
  private maxConcurrentSubAgents: number;

  constructor(
    workerManager: WorkerManager,
    dbRequest: DbRequestFn,
    maxConcurrentSubAgents: number = 8
  ) {
    this.workerManager = workerManager;
    this.dbRequest = dbRequest;
    this.maxConcurrentSubAgents = maxConcurrentSubAgents;
  }

  async createSession(canvasId: string): Promise<ConductorSession> {
    const existing = this.getSessionByCanvasId(canvasId);
    if (existing) {
      return existing;
    }

    const canvasState = await this.loadCanvasState(canvasId);

    const session: ConductorSession = {
      id: `conductor-${canvasId}`,
      canvasId,
      state: ConductorSessionState.IDLE,
      canvasState,
      subAgents: new Map(),
      sseClients: new Set(),
      createdAt: Date.now(),
      lastActionAt: Date.now(),
      eventSeqNum: 0,
    };

    this.sessions.set(session.id, session);
    return session;
  }

  getSession(id: string): ConductorSession | undefined {
    return this.sessions.get(id);
  }

  getSessionByCanvasId(canvasId: string): ConductorSession | undefined {
    for (const session of this.sessions.values()) {
      if (session.canvasId === canvasId) {
        return session;
      }
    }
    return undefined;
  }

  async handleUserAction(sessionId: string, action: ConductorAction): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw new Error(`Conductor session ${sessionId} not found`);
    }

    const now = Date.now();
    this.applyActionToState(session.canvasState, action);
    session.lastActionAt = now;

    await this.persistCanvasState(session);

    this.emitToSSEClients(session, {
      event: 'canvas:update',
      data: {
        action: action.action,
        canvasState: this.serializeCanvasState(session.canvasState),
        timestamp: now,
      },
    });
  }

  async executeTurn(
    sessionId: string,
    prompt: string,
    providerConfig: Record<string, unknown>,
    options?: {
      agentId?: string;
      agentName?: string;
      workingDirectory?: string;
      systemPrompt?: string;
    }
  ): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw new Error(`Conductor session ${sessionId} not found`);
    }

    if (session.state === ConductorSessionState.EXECUTING) {
      throw new Error(`Conductor session ${sessionId} is already executing`);
    }

    const activeCount = this.countActiveSubAgents(session);
    if (activeCount >= this.maxConcurrentSubAgents) {
      throw new Error(
        `Maximum concurrent sub-agents (${this.maxConcurrentSubAgents}) reached`
      );
    }

    const agentId = options?.agentId || randomUUID();
    const agentName = options?.agentName || `Agent-${agentId.substring(0, 8)}`;
    const workerSessionId = `conductor-worker-${agentId}`;

    const subAgent: SubAgentInfo = {
      agentId,
      agentName,
      workerSessionId,
      startedAt: Date.now(),
      status: 'spawning',
    };

    session.subAgents.set(agentId, subAgent);
    session.state = ConductorSessionState.EXECUTING;
    session.lastActionAt = Date.now();

    workerLogger.info('Conductor executeTurn: starting', {
      sessionId,
      agentId,
      agentName,
      workerSessionId,
      promptLength: prompt.length,
      sseClientCount: session.sseClients.size,
      activeSubAgentCount: activeCount,
    });

    this.emitToSSEClients(session, {
      event: 'subagent:spawn',
      data: {
        agentId,
        agentName,
        workerSessionId,
        prompt,
        timestamp: subAgent.startedAt,
      },
    });

    try {
      workerLogger.info('Conductor executeTurn: spawning worker', { sessionId, agentId, workerSessionId });
      const child = this.workerManager.spawnWorker(workerSessionId);

      subAgent.status = 'streaming';
      session.subAgents.set(agentId, subAgent);

      this.setupWorkerEventRouting(session, child, agentId, agentName, workerSessionId);

      if (child.stdin) {
        workerLogger.info('Conductor executeTurn: sending conductor:init', { sessionId, agentId, workerSessionId });
        this.workerManager.sendCommand(workerSessionId, {
          type: 'conductor:init',
          sessionId: workerSessionId,
          providerConfig,
          snapshot: this.buildConductorSnapshot(session),
          workingDirectory: options?.workingDirectory || '',
          systemPrompt: options?.systemPrompt,
        });

        workerLogger.info('Conductor executeTurn: sending conductor:agent:start', { sessionId, agentId, workerSessionId, promptPreview: prompt.substring(0, 100) });
        this.workerManager.sendCommand(workerSessionId, {
          type: 'conductor:agent:start',
          sessionId: workerSessionId,
          prompt,
          snapshot: this.buildConductorSnapshot(session),
        });
      } else {
        workerLogger.warn('Conductor executeTurn: child.stdin is null', { sessionId, agentId, workerSessionId });
      }
    } catch (err) {
      workerLogger.error('Conductor executeTurn: worker spawn failed', err instanceof Error ? err : new Error(String(err)), { sessionId, agentId, workerSessionId });
      subAgent.status = 'error';
      session.subAgents.set(agentId, subAgent);

      const message = err instanceof Error ? err.message : String(err);
      this.emitToSSEClients(session, {
        event: 'subagent:done',
        data: {
          agentId,
          agentName,
          status: 'error',
          error: message,
          timestamp: Date.now(),
        },
      });

      this.checkAndTransitionIdle(session);
    }
  }

  interruptTurn(sessionId: string, agentId?: string): void {
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw new Error(`Conductor session ${sessionId} not found`);
    }

    if (agentId) {
      const subAgent = session.subAgents.get(agentId);
      if (subAgent && (subAgent.status === 'spawning' || subAgent.status === 'streaming')) {
        this.workerManager.killWorker(subAgent.workerSessionId);
        subAgent.status = 'done';
        session.subAgents.set(agentId, subAgent);

        this.emitToSSEClients(session, {
          event: 'subagent:done',
          data: {
            agentId,
            agentName: subAgent.agentName,
            status: 'interrupted',
            timestamp: Date.now(),
          },
        });
      }
    } else {
      for (const [id, subAgent] of session.subAgents) {
        if (subAgent.status === 'spawning' || subAgent.status === 'streaming') {
          this.workerManager.killWorker(subAgent.workerSessionId);
          subAgent.status = 'done';
          session.subAgents.set(id, subAgent);

          this.emitToSSEClients(session, {
            event: 'subagent:done',
            data: {
              agentId: id,
              agentName: subAgent.agentName,
              status: 'interrupted',
              timestamp: Date.now(),
            },
          });
        }
      }
    }

    this.checkAndTransitionIdle(session);
  }

  addSSEClient(sessionId: string, res: http.ServerResponse): void {
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw new Error(`Conductor session ${sessionId} not found`);
    }

    workerLogger.info('Conductor adding SSE client', { sessionId, clientCount: session.sseClients.size + 1 });
    session.sseClients.add(res);

    res.on('close', () => {
      workerLogger.info('Conductor SSE client disconnected', { sessionId, clientCount: session.sseClients.size });
      session.sseClients.delete(res);
    });
  }

  removeSSEClient(sessionId: string, res: http.ServerResponse): void {
    const session = this.sessions.get(sessionId);
    if (session) {
      workerLogger.info('Conductor removing SSE client', { sessionId, clientCount: session.sseClients.size - 1 });
      session.sseClients.delete(res);
    }
  }

  destroySession(sessionId: string): boolean {
    const session = this.sessions.get(sessionId);
    if (!session) return false;

    for (const [, subAgent] of session.subAgents) {
      if (subAgent.status === 'spawning' || subAgent.status === 'streaming') {
        this.workerManager.killWorker(subAgent.workerSessionId);
      }
    }

    for (const client of session.sseClients) {
      if (client.writable) {
        client.end();
      }
    }

    this.sessions.delete(sessionId);
    return true;
  }

  getStatus(sessionId: string): Record<string, unknown> | null {
    const session = this.sessions.get(sessionId);
    if (!session) return null;

    const activeSubAgents: SubAgentInfo[] = [];
    const completedSubAgents: SubAgentInfo[] = [];

    for (const subAgent of session.subAgents.values()) {
      if (subAgent.status === 'spawning' || subAgent.status === 'streaming') {
        activeSubAgents.push(subAgent);
      } else {
        completedSubAgents.push(subAgent);
      }
    }

    return {
      sessionId: session.id,
      canvasId: session.canvasId,
      state: session.state,
      canvasState: this.serializeCanvasState(session.canvasState),
      activeSubAgents: activeSubAgents.map(this.serializeSubAgent),
      completedSubAgents: completedSubAgents.map(this.serializeSubAgent),
      createdAt: session.createdAt,
      lastActionAt: session.lastActionAt,
    };
  }

  listSessions(): Array<{ id: string; canvasId: string; state: ConductorSessionState }> {
    return Array.from(this.sessions.values()).map((s) => ({
      id: s.id,
      canvasId: s.canvasId,
      state: s.state,
    }));
  }

  destroyAll(): void {
    for (const [sessionId] of this.sessions) {
      this.destroySession(sessionId);
    }
  }

  private setupWorkerEventRouting(
    session: ConductorSession,
    child: ChildProcess,
    agentId: string,
    agentName: string,
    workerSessionId: string
  ): void {
    workerLogger.info('Conductor setupWorkerEventRouting: attaching handlers', {
      sessionId: session.id,
      agentId,
      agentName,
      workerSessionId,
      sseClientCount: session.sseClients.size,
    });

    child.stdout!.on('data', (data: Buffer) => {
      const lines = data.toString().split('\n').filter(Boolean);
      for (const line of lines) {
        try {
          const event = JSON.parse(line);
          const eventType = event.type || 'unknown';

          if (eventType === 'conductor:ready') {
            workerLogger.info('Conductor received worker ready', {
              sessionId: session.id,
              agentId,
              workerSessionId,
            });
            continue;
          }

          if (eventType === 'conductor:done') {
            workerLogger.info('Conductor received conductor:done', {
              sessionId: session.id,
              agentId,
              workerSessionId,
            });

            const subAgent = session.subAgents.get(agentId);
            if (subAgent) {
              subAgent.status = 'done';
              session.subAgents.set(agentId, subAgent);
            }

            this.emitToSSEClients(session, {
              event: 'subagent:done',
              data: {
                agentId,
                agentName,
                status: 'done',
                timestamp: Date.now(),
              },
            });

            this.checkAndTransitionIdle(session);
            continue;
          }

          if (eventType === 'conductor:error') {
            workerLogger.error('Conductor received conductor:error', new Error(String(event.message || 'Unknown error')), {
              sessionId: session.id,
              agentId,
              workerSessionId,
            });

            const subAgent = session.subAgents.get(agentId);
            if (subAgent) {
              subAgent.status = 'error';
              session.subAgents.set(agentId, subAgent);
            }

            this.emitToSSEClients(session, {
              event: 'subagent:done',
              data: {
                agentId,
                agentName,
                status: 'error',
                error: event.message || 'Unknown error',
                timestamp: Date.now(),
              },
            });

            this.checkAndTransitionIdle(session);
            continue;
          }

          const sseEventName = this.mapConductorEventToSSE(eventType);
          if (sseEventName) {
            workerLogger.debug('Conductor routing event to SSE', {
              sessionId: session.id,
              agentId,
              eventType,
              sseEventName,
              sseClientCount: session.sseClients.size,
            });

            this.emitToSSEClients(session, {
              event: 'subagent:event',
              data: {
                agentId,
                agentName,
                eventType: sseEventName,
                data: event,
                timestamp: Date.now(),
              },
            });
          } else {
            workerLogger.debug('Conductor unhandled worker event type', {
              sessionId: session.id,
              agentId,
              eventType,
            });
          }

          if (eventType === 'checkpoint' && event.data) {
            this.handleSubAgentCheckpoint(session, event.data);
          }
        } catch (err) {
          workerLogger.warn('Conductor failed to parse worker stdout line', {
            sessionId: session.id,
            agentId,
            error: err instanceof Error ? err.message : String(err),
            rawLine: line.substring(0, 200),
          });
        }
      }
    });

    child.stderr!.on('data', (data: Buffer) => {
      const line = data.toString().trim();
      if (line) {
        workerLogger.warn('Conductor worker stderr', {
          sessionId: session.id,
          agentId,
          workerSessionId,
          stderr: line,
        });
      }
    });

    child.on('exit', (code, signal) => {
      workerLogger.info('Conductor worker exit', {
        sessionId: session.id,
        agentId,
        workerSessionId,
        code,
        signal,
      });

      const subAgent = session.subAgents.get(agentId);
      if (!subAgent) {
        workerLogger.warn('Conductor worker exit but subAgent not found', {
          sessionId: session.id,
          agentId,
          workerSessionId,
        });
        return;
      }

      if (subAgent.status === 'streaming' || subAgent.status === 'spawning') {
        if (code !== 0) {
          subAgent.status = 'crashed';
          session.subAgents.set(agentId, subAgent);

          workerLogger.warn('Conductor worker crashed', {
            sessionId: session.id,
            agentId,
            workerSessionId,
            exitCode: code,
            exitSignal: signal,
          });

          this.emitToSSEClients(session, {
            event: 'subagent:done',
            data: {
              agentId,
              agentName,
              status: 'crashed',
              exitCode: code ?? -1,
              timestamp: Date.now(),
            },
          });
        } else {
          subAgent.status = 'done';
          session.subAgents.set(agentId, subAgent);
        }

        this.checkAndTransitionIdle(session);
      }
    });
  }

  private mapConductorEventToSSE(eventType: string): string | null {
    const mapping: Record<string, string> = {
      'conductor:text': 'text',
      'conductor:thinking': 'thinking',
      'conductor:tool_use': 'tool_use',
      'conductor:tool_result': 'tool_result',
      'conductor:tool_progress': 'tool_progress',
      'conductor:permission': 'permission',
      'conductor:status': 'status',
      'conductor:context_usage': 'context_usage',
      'conductor:token_usage': 'token_usage',
      'checkpoint': 'checkpoint',
    };
    return mapping[eventType] || null;
  }

  private checkAndTransitionIdle(session: ConductorSession): void {
    const hasActive = Array.from(session.subAgents.values()).some(
      (sa) => sa.status === 'spawning' || sa.status === 'streaming'
    );

    if (!hasActive && session.state === ConductorSessionState.EXECUTING) {
      workerLogger.info('Conductor transitioning to IDLE', {
        sessionId: session.id,
        previousState: session.state,
      });
      session.state = ConductorSessionState.IDLE;
    }

    workerLogger.debug('Conductor checkAndTransitionIdle', {
      sessionId: session.id,
      currentState: session.state,
      hasActive,
      subAgentCount: session.subAgents.size,
      activeSubAgents: Array.from(session.subAgents.values())
        .filter(sa => sa.status === 'spawning' || sa.status === 'streaming')
        .map(sa => ({ agentId: sa.agentId, status: sa.status })),
    });
  }

  private countActiveSubAgents(session: ConductorSession): number {
    let count = 0;
    for (const sa of session.subAgents.values()) {
      if (sa.status === 'spawning' || sa.status === 'streaming') {
        count++;
      }
    }
    return count;
  }

  private emitToSSEClients(session: ConductorSession, sseEvent: ConductorSSEEvent): void {
    session.eventSeqNum++;
    const seqId = session.eventSeqNum;

    const deadClients: http.ServerResponse[] = [];
    let successCount = 0;

    for (const client of session.sseClients) {
      if (client.writable && !client.destroyed) {
        try {
          const msg = `event: ${sseEvent.event}\nid: ${seqId}\ndata: ${JSON.stringify(sseEvent.data)}\n\n`;
          client.write(msg);
          successCount++;
        } catch (err) {
          workerLogger.warn('Conductor emitToSSE: failed to write to client', {
            sessionId: session.id,
            event: sseEvent.event,
            error: err instanceof Error ? err.message : String(err),
          });
          deadClients.push(client);
        }
      } else {
        deadClients.push(client);
      }
    }

    for (const dead of deadClients) {
      session.sseClients.delete(dead);
    }

    workerLogger.debug('Conductor emitToSSE: sent event', {
      sessionId: session.id,
      event: sseEvent.event,
      seqId,
      sseClientCount: session.sseClients.size,
      deadClients: deadClients.length,
      successCount,
    });
  }

  private applyActionToState(canvasState: CanvasState, action: ConductorAction): void {
    const now = Date.now();
    const a = action as Record<string, unknown>;
    const actionName = a.action as string;

    switch (actionName) {
      case 'canvas.rename': {
        canvasState.canvas.name = a.name as string;
        canvasState.canvas.updatedAt = now;
        break;
      }
      case 'element.create': {
        const element: CanvasElement = {
          id: randomUUID(),
          canvasId: canvasState.canvas.id,
          elementKind: a.elementKind as string,
          position: a.position as CanvasPosition,
          config: (a.config as Record<string, unknown>) || {},
          state: 'idle',
          dataVersion: 0,
          vizSpec: (a.vizSpec as VizSpec | undefined) || null,
          sourceCode: null,
          permissions: { agentCanRead: true, agentCanWrite: true, agentCanDelete: true },
          metadata: { label: '', tags: [], createdBy: 'user' },
          createdAt: now,
          updatedAt: now,
        };
        canvasState.elements.push(element);
        canvasState.canvas.updatedAt = now;
        break;
      }
      case 'element.update': {
        const idx = canvasState.elements.findIndex((e) => e.id === a.elementId);
        if (idx !== -1) {
          const el = canvasState.elements[idx];
          if (a.vizSpec !== undefined) el.vizSpec = a.vizSpec as VizSpec | null;
          if (a.position) el.position = { ...el.position, ...a.position as Partial<CanvasPosition> };
          if (a.config) el.config = { ...el.config, ...a.config as Record<string, unknown> };
          el.updatedAt = now;
          canvasState.canvas.updatedAt = now;
        }
        break;
      }
      case 'element.delete': {
        canvasState.elements = canvasState.elements.filter((e) => e.id !== a.elementId);
        canvasState.canvas.updatedAt = now;
        break;
      }
      case 'element.move': {
        const moveIdx = canvasState.elements.findIndex((e) => e.id === a.elementId);
        if (moveIdx !== -1) {
          canvasState.elements[moveIdx].position = a.position as CanvasPosition;
          canvasState.elements[moveIdx].updatedAt = now;
          canvasState.canvas.updatedAt = now;
        }
        break;
      }
      case 'element.arrange': {
        const layout = a.layout as Array<{ elementId: string; position: CanvasPosition }>;
        for (const item of layout) {
          const arrIdx = canvasState.elements.findIndex((e) => e.id === item.elementId);
          if (arrIdx !== -1) {
            canvasState.elements[arrIdx].position = item.position;
            canvasState.elements[arrIdx].updatedAt = now;
          }
        }
        canvasState.canvas.updatedAt = now;
        break;
      }
      default: {
        console.warn(`[ConductorService] Unknown action: ${actionName}`);
      }
    }
  }

  private async persistCanvasState(session: ConductorSession): Promise<void> {
    try {
      await this.dbRequest('conductor:canvas:update', {
        id: session.canvasState.canvas.id,
        name: session.canvasState.canvas.name,
        description: session.canvasState.canvas.description,
        layoutConfig: JSON.stringify(session.canvasState.canvas.layoutConfig),
      });

      for (const element of session.canvasState.elements) {
        await this.dbRequest('conductor:element:upsert', {
          id: element.id,
          canvasId: element.canvasId,
          elementKind: element.elementKind,
          position: JSON.stringify(element.position),
          config: JSON.stringify(element.config),
          vizSpec: element.vizSpec ? JSON.stringify(element.vizSpec) : null,
          sourceCode: element.sourceCode,
          state: element.state,
          dataVersion: element.dataVersion,
          permissions: JSON.stringify(element.permissions),
          metadata: JSON.stringify(element.metadata),
        });
      }
    } catch (err) {
      console.error(
        `[ConductorService] Failed to persist canvas state for ${session.id}:`,
        err instanceof Error ? err.message : String(err)
      );
    }
  }

  private async loadCanvasState(canvasId: string): Promise<CanvasState> {
    try {
      const canvasRow = await this.dbRequest('conductor:canvas:get', { id: canvasId }) as Record<string, unknown> | null;
      const elementsRows = await this.dbRequest('conductor:element:list', { canvasId }) as Array<Record<string, unknown>>;

      if (!canvasRow) {
        return this.emptyCanvasState(canvasId);
      }

      const canvas: CanvasInfo = {
        id: canvasRow.id as string,
        name: canvasRow.name as string,
        description: canvasRow.description as string | null,
        layoutConfig: typeof canvasRow.layout_config === 'string'
          ? JSON.parse(canvasRow.layout_config)
          : (canvasRow.layoutConfig as Record<string, unknown>) || {},
        sortOrder: (canvasRow.sort_order as number) ?? (canvasRow.sortOrder as number) ?? 0,
        createdAt: (canvasRow.created_at as number) ?? Date.now(),
        updatedAt: (canvasRow.updated_at as number) ?? Date.now(),
      };

      const elements: CanvasElement[] = (elementsRows || []).map((row) => ({
        id: row.id as string,
        canvasId: (row.canvas_id as string) ?? (row.canvasId as string),
        elementKind: (row.element_kind as string) ?? (row.elementKind as string),
        position: typeof row.position === 'string' ? JSON.parse(row.position) : row.position as CanvasPosition,
        config: typeof row.config === 'string' ? JSON.parse(row.config) : row.config as Record<string, unknown>,
        state: (row.state as string) || 'idle',
        dataVersion: (row.data_version as number) ?? (row.dataVersion as number) ?? 0,
        vizSpec: row.viz_spec ? (typeof row.viz_spec === 'string' ? JSON.parse(row.viz_spec) : row.viz_spec) as VizSpec : (row.vizSpec ? (typeof row.vizSpec === 'string' ? JSON.parse(row.vizSpec) : row.vizSpec) as VizSpec : null),
        sourceCode: (row.source_code as string) ?? (row.sourceCode as string) ?? null,
        permissions: typeof row.permissions === 'string' ? JSON.parse(row.permissions) : row.permissions as Record<string, unknown> || {},
        metadata: typeof row.metadata === 'string' ? JSON.parse(row.metadata) : row.metadata as Record<string, unknown> || {},
        createdAt: (row.created_at as number) ?? Date.now(),
        updatedAt: (row.updated_at as number) ?? Date.now(),
      }));

      return { canvas, elements, conversationHistory: [] };
    } catch (err) {
      console.error(
        `[ConductorService] Failed to load canvas state for ${canvasId}:`,
        err instanceof Error ? err.message : String(err)
      );
      return this.emptyCanvasState(canvasId);
    }
  }

  private emptyCanvasState(canvasId: string): CanvasState {
    return {
      canvas: {
        id: canvasId,
        name: 'Untitled Canvas',
        description: null,
        layoutConfig: {},
        sortOrder: 0,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      },
      elements: [],
      conversationHistory: [],
    };
  }

  private buildConductorSnapshot(session: ConductorSession): Record<string, unknown> {
    return {
      canvasId: session.canvasState.canvas.id,
      canvasName: session.canvasState.canvas.name,
      widgets: [],
      elements: session.canvasState.elements.map((el) => ({
        id: el.id,
        elementKind: el.elementKind,
        vizSpec: el.vizSpec,
        position: el.position,
      })),
      actionCursor: 0,
    };
  }

  private serializeCanvasState(canvasState: CanvasState): Record<string, unknown> {
    return {
      canvas: canvasState.canvas,
      elements: canvasState.elements,
      conversationHistory: canvasState.conversationHistory,
    };
  }

  private serializeSubAgent(subAgent: SubAgentInfo): Record<string, unknown> {
    return {
      agentId: subAgent.agentId,
      agentName: subAgent.agentName,
      workerSessionId: subAgent.workerSessionId,
      startedAt: subAgent.startedAt,
      status: subAgent.status,
    };
  }

  private handleSubAgentCheckpoint(
    session: ConductorSession,
    checkpointData: Record<string, unknown>
  ): void {
    if (checkpointData.messages && Array.isArray(checkpointData.messages)) {
      const lastMsg = checkpointData.messages[checkpointData.messages.length - 1];
      if (lastMsg && typeof lastMsg === 'object' && 'role' in lastMsg && 'content' in lastMsg) {
        session.canvasState.conversationHistory.push({
          role: (lastMsg as Record<string, unknown>).role as string,
          content: (lastMsg as Record<string, unknown>).content as string,
        });
      }
    }
  }
}
