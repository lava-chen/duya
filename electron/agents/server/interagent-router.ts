import { randomUUID } from 'crypto';
import type { ChildProcess } from 'child_process';
import type { WorkerManager } from './worker-manager';
import type { SessionManager } from './session-store';
import { SessionState } from './types';
import { workerLogger } from './logger';
import type { WorkerEvent } from '../../../packages/agent/src/process/worker-protocol';
import type { ApiProvider } from '../../config/provider-types';
import { buildInitProviderConfig, detectReferencesEnabled } from './router';

/**
 * Shared map of pending DB requests, keyed by request id. The agent server
 * (index.ts) owns this map and passes it to both the HTTP router and the
 * interagent router so that either path can forward worker `db:request`
 * IPC messages to the main process and route the `db:response` back.
 */
export type WorkerDbRequests = Map<string, ChildProcess>;

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
  /**
   * Shared map of pending worker DB requests. The interagent router must
   * register target worker `db:request` messages here so the agent server's
   * `db:response` handler can route responses back to the correct worker.
   * Without this, the target worker's DB calls (loadMessages, getJson, etc.)
   * silently hang for 30 seconds until the db-client timeout fires.
   */
  workerDbRequests: WorkerDbRequests;
}

const MAX_CONCURRENT_WORKERS = 16;
// Tool names MUST match the lowercase names registered in the agent
// registry (packages/agent/src/tool/*Tool.ts), since DuyaAgent._resolveTools
// filters with a strict Set.has(t.name) comparison (DuyaAgent.ts:1702).
// Previously this list was uppercase ('Read'/'Grep'/'Glob'), which caused
// the minimal-mode filter to match zero tools, leaving the target agent
// with an empty toolset and triggering a chat:error on first turn. The
// caller surfaced this as "Tool result missing due to internal error".
const MINIMAL_ALLOWED_TOOLS = ['read', 'grep', 'glob'];

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
  private activeInvokes = new Map<string, {
    callerSessionId: string;
    targetSessionId: string;
    timer: ReturnType<typeof setTimeout>;
    child?: ChildProcess;
    onExit?: (code: number | null, signal: NodeJS.Signals | null) => void;
    onDbRequest?: (msg: Record<string, unknown>) => void;
    detachStdout?: () => void;
  }>();
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

    // 1. Load target session row from DB.
    // db-bridge 'session:get' reads p.id (not p.sessionId), so we must pass { id }.
    const sessionRow = await this.deps.dbRequest('session:get', { id: targetSessionId }) as Record<string, unknown> | null;
    if (!sessionRow) {
      this.sendEventToCaller(callerSessionId, id, {
        type: 'chat:error', sessionId: targetSessionId,
        message: 'target session not found in DB', code: 'target_not_found',
      });
      this.cleanup(id);
      return;
    }

    // Resolve provider config the same way the normal chat path does —
    // buildInitProviderConfig maps the DB ApiProvider shape to the worker's
    // expected { apiKey, baseURL, model, provider, authStyle } format.
    // Passing the raw DB row directly causes LLM client init to fail.
    const providerId = typeof sessionRow.provider_id === 'string' ? sessionRow.provider_id : '';
    let apiProvider: ApiProvider | undefined;
    if (providerId && providerId !== 'env') {
      try {
        apiProvider = await this.deps.dbRequest('config:provider:get', { id: providerId }) as ApiProvider | undefined;
      } catch {
        // fall through to active provider
      }
    }
    if (!apiProvider) {
      try {
        apiProvider = await this.deps.dbRequest('config:provider:getActive', {}) as ApiProvider | undefined;
      } catch {
        // no provider available
      }
    }
    const providerConfig = buildInitProviderConfig(sessionRow, apiProvider);
    if (!providerConfig) {
      this.sendEventToCaller(callerSessionId, id, {
        type: 'chat:error', sessionId: targetSessionId,
        message: 'provider config not found', code: 'provider_missing',
      });
      this.cleanup(id);
      return;
    }

    const workingDirectory = typeof sessionRow.working_directory === 'string' ? sessionRow.working_directory : undefined;
    const systemPrompt = typeof sessionRow.system_prompt === 'string' ? sessionRow.system_prompt : undefined;

    // 2. Normalize target session state before spawn.
    // spawnWorker() transitions IDLE → STREAMING, but a previously-failed
    // interagent call leaves the session in ERROR/CRASHED. The state machine
    // only allows ERROR/CRASHED → IDLE, so we must reset to IDLE first
    // or spawnWorker throws "Invalid state transition: ERROR → STREAMING".
    const targetSession = this.deps.sessionManager.getSession(targetSessionId);
    if (targetSession) {
      if (targetSession.state === SessionState.ERROR || targetSession.state === SessionState.CRASHED) {
        try {
          this.deps.sessionManager.transitionState(targetSessionId, SessionState.IDLE);
        } catch {
          // transition may fail if another path raced us to IDLE; safe to ignore
        }
      }
    }

    const child = this.deps.workerManager.spawnWorker(targetSessionId);

    // 3. Attach exit listener so we can notify the caller if the worker
    //    dies before emitting chat:done / chat:error.
    const onExit = (code: number | null, signal: NodeJS.Signals | null): void => {
      if (!this.activeInvokes.has(id)) return;
      workerLogger.warn('Interagent target worker exited unexpectedly', {
        invokeId: id, targetSessionId, exitCode: code, signal: String(signal),
      });
      this.sendEventToCaller(callerSessionId, id, {
        type: 'chat:error',
        sessionId: targetSessionId,
        message: `target worker exited (code=${code}, signal=${signal})`,
        code: 'worker_crashed',
      });
      this.cleanup(id);
    };
    child.once('exit', onExit);

    // 4. Forward `db:request` IPC messages from the target worker to the
    //    main process — the agent server's `process.on('message')` handler
    //    routes `db:response` back via the shared `workerDbRequests` map.
    //    Without this, the target worker's DB calls (loadMessages,
    //    settingDb.getJson, etc.) during init silently hang for 30 seconds
    //    until the db-client timeout fires, causing `ready` to never emit
    //    within the waitForReady timeout window.
    const onDbRequest = (msg: Record<string, unknown>): void => {
      if (msg.type === 'db:request' && typeof msg.id === 'string' && process.send) {
        this.deps.workerDbRequests.set(msg.id, child);
        process.send(msg);
        return;
      }
      if (msg.type === 'conductor:executor:rpc' && typeof msg.requestId === 'string' && process.send) {
        this.deps.workerDbRequests.set(`rpc:${msg.requestId}`, child);
        process.send(msg);
      }
    };
    child.on('message', onDbRequest);

    // Store child + onExit + onDbRequest so cleanup() can detach listeners.
    const entry = this.activeInvokes.get(id);
    if (entry) {
      entry.child = child;
      entry.onExit = onExit;
      entry.onDbRequest = onDbRequest;
    }

    // 4. Send init command — mirror the normal chat path (router.ts) which
    //    includes language, referencesEnabled, etc. Missing these causes
    //    features like .duya/references/ to silently break for the target.
    this.deps.workerManager.sendCommand(targetSessionId, {
      type: 'init',
      sessionId: targetSessionId,
      providerConfig,
      workingDirectory: workingDirectory || '',
      defaultWorkspaceDirectory: '',
      systemPrompt: systemPrompt || undefined,
      language: 'zh',
      referencesEnabled: detectReferencesEnabled(workingDirectory),
    });

    // 5. Wait for ready
    try {
      await this.waitForReady(targetSessionId);
    } catch (err) {
      // Kill the spawned worker on ready timeout so we don't leak it.
      child.removeListener('exit', onExit);
      this.deps.workerManager.killWorker(targetSessionId);
      try {
        this.deps.sessionManager.transitionState(targetSessionId, SessionState.ERROR);
      } catch {
        // state transition may be invalid
      }
      this.sendEventToCaller(callerSessionId, id, {
        type: 'chat:error',
        sessionId: targetSessionId,
        message: `target ready timeout: ${err instanceof Error ? err.message : String(err)}`,
        code: 'ready_timeout',
      });
      this.cleanup(id);
      return;
    }

    // 6. Append caller's message to target session.
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

    // 7. Subscribe to target worker stdout BEFORE sending chat:start so we
    //    don't miss early events (target may emit chat:text immediately).
    this.subscribeToTargetStdout(targetSessionId, id, callerSessionId, child, onExit);

    // 8. Send chat:start with mode-based toolset filtering
    // Pre-flight sanity check: catch a misconfigured MINIMAL_ALLOWED_TOOLS
    // at the server side instead of waiting for the target worker to emit
    // chat:error on first turn. If any entry in the allowlist is not
    // lowercase, the strict Set.has() filter in DuyaAgent._resolveTools
    // (DuyaAgent.ts:1702) will silently drop it, leaving the target with
    // an empty toolset. Warn now so the regression is visible in
    // worker.log without needing to attach a debugger.
    if (mode === 'minimal') {
      const nonLowercase = MINIMAL_ALLOWED_TOOLS.filter((n) => n !== n.toLowerCase());
      if (nonLowercase.length > 0) {
        workerLogger.warn(
          'Interagent minimal mode: MINIMAL_ALLOWED_TOOLS contains non-lowercase entries. ' +
          'These will not match the agent registry (Set.has is case-sensitive). ' +
          'Offending names: ' + nonLowercase.join(', '),
          { invokeId: id, targetSessionId },
        );
      }
    }
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

      // IPC fallback: sendToMain in the worker emits to BOTH stdout and
      // process.send. On Windows + Electron child stdio pipes occasionally
      // drop frames; the IPC channel is reliable.
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

  private subscribeToTargetStdout(
    targetSessionId: string,
    invokeId: string,
    callerSessionId: string,
    child: ChildProcess,
    onExit: (code: number | null, signal: NodeJS.Signals | null) => void,
  ): void {
    // Use IPC (child.on('message')) exclusively for chat:* event delivery.
    // stdout is unreliable on Windows + Electron (pipe buffering, dropped
    // frames). The target worker emits every event on BOTH channels via
    // sendToMain (stdout + process.send), so IPC alone is sufficient.
    // This also avoids the dedup problem of monitoring both channels.
    let detached = false;

    const onIpcEvent = (msg: Record<string, unknown>): void => {
      if (detached) return;
      if (typeof msg.type !== 'string' || !msg.type.startsWith('chat:')) return;

      this.sendEventToCaller(callerSessionId, invokeId, msg as unknown as WorkerEvent);

      if (msg.type === 'chat:done' || msg.type === 'chat:error') {
        detach();
        if (!this.activeInvokes.has(invokeId)) return;
        try {
          this.deps.sessionManager.transitionState(
            targetSessionId,
            msg.type === 'chat:done' ? SessionState.COMPLETED : SessionState.ERROR,
          );
        } catch {
          // state transition may be invalid; safe to ignore
        }
        this.deps.workerManager.killWorker(targetSessionId);
        this.cleanup(invokeId);
      }
    };

    const detach = (): void => {
      if (detached) return;
      detached = true;
      child.removeListener('message', onIpcEvent);
      child.removeListener('exit', onExit);
    };

    const entry = this.activeInvokes.get(invokeId);
    if (entry) {
      entry.detachStdout = detach;
    }

    child.on('message', onIpcEvent);
  }

  private handleTimeout(id: string): void {
    const invoke = this.activeInvokes.get(id);
    if (!invoke) return;
    workerLogger.warn('Interagent invoke timeout', { invokeId: id, caller: invoke.callerSessionId, target: invoke.targetSessionId });
    // Detach stdout + exit + db:request listeners so the kill below doesn't
    // trigger a duplicate chat:error via onExit or leak listeners.
    invoke.detachStdout?.();
    if (invoke.child && invoke.onExit) {
      invoke.child.removeListener('exit', invoke.onExit);
    }
    if (invoke.child && invoke.onDbRequest) {
      invoke.child.removeListener('message', invoke.onDbRequest);
    }
    // Interrupt + kill target worker
    this.deps.workerManager.interruptWorker(invoke.targetSessionId);
    try {
      this.deps.sessionManager.transitionState(invoke.targetSessionId, SessionState.ERROR);
    } catch {
      // state transition may be invalid
    }
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
    // MUST use IPC (child.send) not stdin (sendCommand).
    // The caller worker's main loop (for await ... parseStdin()) blocks
    // while awaiting MessageSessionTool.execute(), so stdin messages pile
    // up unread — including interagent:event — causing a deadlock where
    // chat:done is in the stdin buffer but never processed, and the tool
    // hangs until its 60s local timeout.
    // IPC messages are received by process.on('message') in the caller
    // (agent-process-entry.ts:2849) which runs independently of the stdin
    // loop and synchronously resolves the tool promise via the
    // 'interagent:event' case (agent-process-entry.ts:2736).
    const child = this.deps.workerManager.getWorker(callerSessionId);
    if (!child || child.killed) {
      workerLogger.warn('Cannot send interagent:event: caller worker gone', {
        callerSessionId, invokeId, eventType: event.type,
      });
      return;
    }
    child.send({ type: 'interagent:event', id: invokeId, event }, (err) => {
      if (err) {
        workerLogger.warn('Failed to send interagent:event via IPC', {
          callerSessionId, invokeId, eventType: event.type, error: err.message,
        });
      }
    });
  }

  private cleanup(id: string): void {
    const invoke = this.activeInvokes.get(id);
    if (invoke) {
      clearTimeout(invoke.timer);
      invoke.detachStdout?.();
      if (invoke.child && invoke.onExit) {
        invoke.child.removeListener('exit', invoke.onExit);
      }
      if (invoke.child && invoke.onDbRequest) {
        invoke.child.removeListener('message', invoke.onDbRequest);
      }
    }
    this.activeInvokes.delete(id);
    this.cycleDetector.removeInvoke(id);
  }
}
