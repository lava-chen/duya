import { randomUUID } from 'crypto';
import type { WorkerManager } from './worker-manager';
import type { SessionManager } from './session-store';
import { SessionState } from './types';
import { workerLogger } from './logger';
import type { WorkerEvent } from '../../../packages/agent/src/process/worker-protocol';

/**
 * Tracks active inter-agent invocations as a directed graph.
 * Edges: callerSessionId → targetSessionId.
 * A cycle exists if targetSessionId can reach callerSessionId
 * through existing edges.
 */
export class CycleDetector {
  // invokeId → { caller, target }
  private invokes = new Map<string, { caller: string; target: string }>();

  /**
   * Returns true if adding edge (caller → target) would create a cycle.
   * A self-call (caller === target) always creates a cycle.
   */
  wouldCreateCycle(caller: string, target: string): boolean {
    if (caller === target) return true;
    // BFS/DFS from target: can we reach caller?
    const visited = new Set<string>();
    const queue = [target];
    while (queue.length > 0) {
      const current = queue.shift()!;
      if (current === caller) return true;
      if (visited.has(current)) continue;
      visited.add(current);
      for (const { caller: c, target: t } of this.invokes.values()) {
        if (c === current && !visited.has(t)) {
          queue.push(t);
        }
      }
    }
    return false;
  }

  addInvoke(id: string, caller: string, target: string): void {
    this.invokes.set(id, { caller, target });
  }

  removeInvoke(id: string): void {
    this.invokes.delete(id);
  }
}

export interface InteragentRouterDeps {
  workerManager: WorkerManager;
  sessionManager: SessionManager;
  dbRequest: (action: string, payload: Record<string, unknown>) => Promise<unknown>;
}

const MAX_CONCURRENT_WORKERS = 16;
const MINIMAL_ALLOWED_TOOLS = ['Read', 'Grep', 'Glob'];

export interface InvokeParams {
  id: string;
  callerSessionId: string;
  callerAgentName: string;
  targetSessionId: string;
  message: string;
  mode: 'minimal' | 'full';
  timeout: number;
}

export type InvokeRejectReason =
  | 'self_call'
  | 'cycle_detected'
  | 'target_busy'
  | 'server_busy'
  | 'target_not_found';

export interface InvokeResult {
  ok: boolean;
  reason?: InvokeRejectReason;
}

export class InteragentRouter {
  private cycleDetector = new CycleDetector();
  private activeInvokes = new Map<string, { callerSessionId: string; targetSessionId: string; timer: ReturnType<typeof setTimeout> }>();
  private deps: InteragentRouterDeps;

  constructor(deps: InteragentRouterDeps) {
    this.deps = deps;
  }

  /**
   * Handle an interagent:invoke from a caller worker.
   * Returns { ok: true } if accepted, or { ok: false, reason } if rejected.
   * On acceptance, spawns/drives the target and forwards events to caller.
   */
  async handleInvoke(params: InvokeParams): Promise<InvokeResult> {
    const { id, callerSessionId, targetSessionId, mode, timeout } = params;

    // 1. Self-call
    if (callerSessionId === targetSessionId) {
      return { ok: false, reason: 'self_call' };
    }

    // 2. Cycle detection
    if (this.cycleDetector.wouldCreateCycle(callerSessionId, targetSessionId)) {
      return { ok: false, reason: 'cycle_detected' };
    }

    // 3. Target state check
    const targetSession = this.deps.sessionManager.getSession(targetSessionId);
    if (!targetSession) {
      return { ok: false, reason: 'target_not_found' };
    }
    const allowedStates: SessionState[] = [SessionState.IDLE, SessionState.COMPLETED, SessionState.ERROR, SessionState.CRASHED];
    if (!allowedStates.includes(targetSession.state)) {
      return { ok: false, reason: 'target_busy' };
    }

    // 4. Worker cap
    if (this.deps.workerManager.workerCount >= MAX_CONCURRENT_WORKERS) {
      return { ok: false, reason: 'server_busy' };
    }

    // 5. Register in cycle detector and active invokes
    this.cycleDetector.addInvoke(id, callerSessionId, targetSessionId);

    const timer = setTimeout(() => {
      this.handleTimeout(id);
    }, timeout * 1000);

    this.activeInvokes.set(id, { callerSessionId, targetSessionId, timer });

    // 6. Lazy spawn target worker + drive chat turn (steps 5-11 in spec §6.2)
    try {
      await this.spawnAndDriveTarget(params);
    } catch (err) {
      this.cleanup(id);
      throw err;
    }

    return { ok: true };
  }

  private async spawnAndDriveTarget(params: InvokeParams): Promise<void> {
    const { id, callerSessionId, callerAgentName, targetSessionId, message, mode } = params;

    // 1. Load target session row + provider config from DB (via main process)
    // db-bridge 'session:get' reads p.id (not p.sessionId), so we must pass { id }.
    const sessionRow = await this.deps.dbRequest('session:get', { id: targetSessionId }) as {
      id: string; model: string; system_prompt: string; working_directory: string;
      provider_id: string; agent_profile_id: string | null; permission_profile: string;
    } | null;
    if (!sessionRow) {
      this.sendEventToCaller(callerSessionId, id, {
        type: 'chat:error', sessionId: targetSessionId,
        message: 'target session not found in DB', code: 'target_not_found',
      });
      this.cleanup(id);
      return;
    }

    const providerConfig = await this.deps.dbRequest('config:provider:get', { id: sessionRow.provider_id }) as Record<string, unknown>;
    if (!providerConfig) {
      this.sendEventToCaller(callerSessionId, id, {
        type: 'chat:error', sessionId: targetSessionId,
        message: 'provider config not found', code: 'provider_missing',
      });
      this.cleanup(id);
      return;
    }

    // 2. Spawn target worker
    this.deps.workerManager.spawnWorker(targetSessionId);

    // 3. Send init command
    const initCommand: Record<string, unknown> = {
      type: 'init',
      sessionId: targetSessionId,
      providerConfig,
      workingDirectory: sessionRow.working_directory || undefined,
      systemPrompt: sessionRow.system_prompt || undefined,
    };
    this.deps.workerManager.sendCommand(targetSessionId, initCommand);

    // 4. Wait for ready (reuse the stdout-scanning pattern from router.ts waitForReady)
    await this.waitForReady(targetSessionId);

    // 5. Append caller's message to target session.
    // db-bridge 'message:append' expects { sessionId, messages: [...] }.
    // Each message needs an id (PRIMARY KEY, NOT NULL). The `metadata` field
    // is not a DB column — caller attribution is conveyed via `name`.
    await this.deps.dbRequest('message:append', {
      sessionId: targetSessionId,
      messages: [{
        id: randomUUID(),
        role: 'user',
        content: message,
        name: callerAgentName || 'interagent',
        msg_type: 'text',
      }],
    });

    // 6. Send chat:start with mode-based toolset filtering
    const chatStartCommand: Record<string, unknown> = {
      type: 'chat:start',
      sessionId: targetSessionId,
      id: `interagent-${id}`,
      prompt: message,
      options: {
        permissionModeOverride: mode === 'minimal' ? 'bypassPermissions' : undefined,
        ...(mode === 'minimal' ? { allowedTools: MINIMAL_ALLOWED_TOOLS } : {}),
      },
    };
    this.deps.workerManager.sendCommand(targetSessionId, chatStartCommand);

    // 7. Subscribe to target worker stdout events, forward to caller
    this.subscribeToTargetStdout(targetSessionId, id, callerSessionId);
  }

  private waitForReady(
    targetSessionId: string,
    timeoutMs = 30000,
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      const child = this.deps.workerManager.getWorker(targetSessionId);
      if (!child || !child.stdout) {
        reject(new Error('worker stdout not available'));
        return;
      }

      const startedAt = Date.now();
      // Rolling ~4KB window of recent stdout for diagnostic messages.
      let recentStdout = '';
      let lineBuffer = '';
      let settled = false;
      let timer: ReturnType<typeof setTimeout> | undefined;

      const onStdout = (data: Buffer): void => {
        const text = data.toString();
        recentStdout += text;
        if (recentStdout.length > 4096) {
          recentStdout = recentStdout.slice(-4096);
        }
        lineBuffer += text;
        const lines = lineBuffer.split('\n');
        lineBuffer = lines.pop() || '';
        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed || !trimmed.startsWith('{')) continue;
          try {
            const msg = JSON.parse(trimmed);
            if (
              msg.type === 'ready' &&
              (!msg.sessionId || msg.sessionId === targetSessionId)
            ) {
              workerLogger.info('Interagent target ready via stdout', {
                targetSessionId,
                waitedMs: Date.now() - startedAt,
              });
              finish(resolve);
              return;
            }
          } catch {
            // not JSON, skip
          }
        }
      };

      // IPC fallback: sendToMain in the worker (agent-process-entry.ts:845)
      // emits to BOTH stdout and process.send. On Windows + Electron child
      // stdio pipes occasionally drop frames; the IPC channel is reliable.
      const onIpc = (msg: Record<string, unknown>): void => {
        if (
          msg.type === 'ready' &&
          (!msg.sessionId || msg.sessionId === targetSessionId)
        ) {
          workerLogger.info('Interagent target ready via IPC', {
            targetSessionId,
            waitedMs: Date.now() - startedAt,
          });
          finish(resolve);
        }
      };

      const finish = (fn: () => void): void => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        child.stdout?.removeListener('data', onStdout);
        child.removeListener('message', onIpc);
        fn();
      };

      timer = setTimeout(() => {
        const waitedMs = Date.now() - startedAt;
        const tail = recentStdout.slice(-500).replace(/\s+/g, ' ');
        workerLogger.warn('Interagent target ready timeout', {
          targetSessionId,
          waitedMs,
          recentStdoutTail: recentStdout.slice(-2000),
        });
        finish(() => reject(new Error(
          `interagent target ready timeout after ${waitedMs}ms; last stdout: ${tail}`,
        )));
      }, timeoutMs);

      child.stdout.on('data', onStdout);
      child.on('message', onIpc);
    });
  }

  private subscribeToTargetStdout(targetSessionId: string, invokeId: string, callerSessionId: string): void {
    const child = this.deps.workerManager.getWorker(targetSessionId);
    if (!child || !child.stdout) {
      workerLogger.warn('Cannot subscribe to target stdout', { targetSessionId, invokeId });
      return;
    }

    const handler = (data: Buffer): void => {
      const text = data.toString();
      const lines = text.split('\n');
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || !trimmed.startsWith('{')) continue;
        try {
          const event = JSON.parse(trimmed) as WorkerEvent;
          // Only forward chat:* events (skip ready, pong, db:request, etc.)
          if (typeof event.type === 'string' && event.type.startsWith('chat:')) {
            this.sendEventToCaller(callerSessionId, invokeId, event);
          }
          // On terminal events, cleanup
          if (event.type === 'chat:done' || event.type === 'chat:error') {
            child.stdout?.removeListener('data', handler);
            this.cleanup(invokeId);
          }
        } catch {
          // not JSON, skip
        }
      }
    };

    child.stdout.on('data', handler);
  }

  private handleTimeout(id: string): void {
    const invoke = this.activeInvokes.get(id);
    if (!invoke) return;
    workerLogger.warn('Interagent invoke timeout', { invokeId: id, caller: invoke.callerSessionId, target: invoke.targetSessionId });
    // Interrupt target
    this.deps.workerManager.interruptWorker(invoke.targetSessionId);
    // Send synthetic error to caller
    this.sendEventToCaller(invoke.callerSessionId, id, {
      type: 'chat:error',
      sessionId: invoke.targetSessionId,
      message: 'interagent timeout',
      code: 'timeout',
    });
    this.cleanup(id);
  }

  private sendEventToCaller(callerSessionId: string, invokeId: string, event: WorkerEvent): void {
    this.deps.workerManager.sendCommand(callerSessionId, {
      type: 'interagent:event',
      id: invokeId,
      event,
    });
  }

  private cleanup(id: string): void {
    const invoke = this.activeInvokes.get(id);
    if (invoke) {
      clearTimeout(invoke.timer);
    }
    this.activeInvokes.delete(id);
    this.cycleDetector.removeInvoke(id);
  }
}
