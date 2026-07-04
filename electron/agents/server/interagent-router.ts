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
    // Implementation in Task 3.3 — lazy spawn, append message, chat:start,
    // subscribe to stdout events, forward to caller.
    // For now this is a stub that will be filled in.
    void params;
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
