/**
 * The Host's `interagent:invoke` server.
 *
 * ## What this is for
 *
 * The `MessageSession` tool asks another session's agent a question over the
 * worker's process IPC: the caller sends `interagent:invoke`, the Host
 * drives the TARGET session's turn, and the target's `chat:*` frames come
 * back to the caller as `interagent:event`.
 *
 * The Desktop had that server. The standalone Host did not: its worker
 * message handler had no `interagent:invoke` branch, so the invoke was
 * DROPPED, and the caller — whose promise only a terminal event can settle
 * — waited out its watchdog and reported "interagent local timeout". The
 * tool never worked outside the desktop app, and it failed in the one way
 * that hides the cause.
 *
 * ## What this does NOT do
 *
 * It does not open a second control plane and it does not bypass admission.
 * The target's turn goes through the ordinary `startAgentRun`, so it is
 * admitted, recorded and settled exactly like any other run — including the
 * busy check, the permission ceiling and the durable ledger.
 *
 * ## Who the caller is
 *
 * The CALLER is the session whose worker sent the message, as the HOST knows
 * it. The message carries a `callerSessionId`, but a worker that could name
 * a different session in it could make the Host deliver one session's
 * events to another. The Host's own binding is the authority; the message's
 * claim is not used.
 */

import type { RunId, StartAgentRunInput, StartAgentRunResult } from '@duya/agent-protocol';
import type { WorkerEvent } from '@duya/agent-protocol/worker-protocol';

/**
 * The tools a `minimal` invoke may use.
 *
 * Lowercase on purpose: the registry's names are lowercase and the
 * visibility filter compares them exactly.
 */
const MINIMAL_ALLOWED_TOOLS = ['read', 'grep', 'glob'] as const;

export type InteragentRejectReason =
  | 'self_call'
  | 'cycle_detected'
  | 'target_not_found'
  | 'target_busy'
  | 'dispatch_failed'
  | 'timeout';

export interface InteragentInvokeRequest {
  readonly id: string;
  readonly callerSessionId: string;
  readonly callerAgentName: string;
  readonly targetSessionId: string;
  readonly message: string;
  readonly mode: 'minimal' | 'full';
  /** Seconds, as the caller asked for them. */
  readonly timeout: number;
}

/** The part of a worker process this server uses. */
export interface InteragentWorkerChannel {
  send(message: unknown, callback?: (error: Error | null) => void): void;
  killed?: boolean;
}

export interface InteragentServerPorts {
  /** Start the TARGET's turn. Goes through the ordinary admission path. */
  readonly startRun: (input: StartAgentRunInput) => Promise<StartAgentRunResult>;
  /** Is the session already executing a run? */
  readonly isSessionBusy: (sessionId: string) => boolean;
  /** The caller's worker process, for the IPC channel. */
  readonly getWorker: (sessionId: string) => InteragentWorkerChannel | undefined;
  /** Interrupt the target's run when the invoke times out. */
  readonly cancelRun: (runId: RunId, reason: string) => Promise<unknown>;
  readonly log: {
    warn(message: string, context?: Record<string, unknown>): void;
    info(message: string, context?: Record<string, unknown>): void;
  };
}

interface ActiveInvoke {
  readonly id: string;
  readonly callerSessionId: string;
  readonly targetSessionId: string;
  readonly timeoutMs: number;
  timer: ReturnType<typeof setTimeout> | undefined;
  runId: RunId | undefined;
}

export class InteragentServer {
  readonly #ports: InteragentServerPorts;
  /** invoke id -> the invoke. */
  readonly #byInvoke = new Map<string, ActiveInvoke>();
  /** target session -> the invoke that owns it. */
  readonly #byTarget = new Map<string, ActiveInvoke>();
  /** caller session -> the invoke it started. */
  readonly #byCaller = new Map<string, ActiveInvoke>();

  constructor(ports: InteragentServerPorts) {
    this.#ports = ports;
  }

  /**
   * Accept one invoke from the CALLER's worker.
   *
   * Every refusal is reported to the caller as a terminal event. A refusal
   * that is only RETURNED leaves the caller's tool promise unsettled, and
   * the user sees a timeout instead of the reason.
   */
  async handleInvoke(request: InteragentInvokeRequest): Promise<void> {
    const { id, callerSessionId, targetSessionId, message, mode, timeout } = request;

    if (callerSessionId === targetSessionId) {
      this.#reject(request, 'self_call');
      return;
    }
    if (this.#wouldCreateCycle(callerSessionId, targetSessionId)) {
      this.#reject(request, 'cycle_detected');
      return;
    }
    if (this.#ports.isSessionBusy(targetSessionId)) {
      this.#reject(request, 'target_busy');
      return;
    }

    // The edge is registered BEFORE the run starts, so a cycle that forms
    // while this invoke is in flight is visible to the next one.
    const invoke: ActiveInvoke = {
      id,
      callerSessionId,
      targetSessionId,
      timeoutMs: Math.max(1, timeout) * 1000,
      timer: undefined,
      runId: undefined,
    };
    this.#byInvoke.set(id, invoke);
    this.#byTarget.set(targetSessionId, invoke);
    this.#byCaller.set(callerSessionId, invoke);

    let started: StartAgentRunResult;
    try {
      started = await this.#ports.startRun({
        sessionId: targetSessionId,
        prompt: message,
        origin: 'agent',
        ...(mode === 'minimal'
          ? {
            permissionMode: 'bypassPermissions',
            options: { allowedTools: [...MINIMAL_ALLOWED_TOOLS] },
          }
          : {}),
      });
    } catch (error) {
      this.#cleanup(invoke);
      this.#reject(request, 'dispatch_failed', error instanceof Error ? error.message : String(error));
      return;
    }

    if (!started.accepted) {
      this.#cleanup(invoke);
      this.#reject(
        request,
        started.stage === 'refused_no_session' ? 'target_not_found' : 'dispatch_failed',
        started.reason,
      );
      return;
    }

    invoke.runId = started.runId;
    invoke.timer = setTimeout(() => {
      this.#handleTimeout(invoke);
    }, invoke.timeoutMs);
    this.#ports.log.info('Interagent invoke accepted', {
      invokeId: id,
      callerSessionId,
      targetSessionId,
      runId: started.runId,
    });
  }

  /**
   * Forward one frame the TARGET's worker produced to the CALLER.
   *
   * The frame travels RAW, in the worker's own `chat:*` vocabulary, because
   * that is the vocabulary the caller's tool reads: it assembles the
   * answer from `chat:text` frames and settles on `chat:done` /
   * `chat:error`. Re-projecting it here would be a second mapping table
   * competing with the one the caller already has.
   */
  forwardTargetFrame(targetSessionId: string, frame: Record<string, unknown>): void {
    const invoke = this.#byTarget.get(targetSessionId);
    if (invoke === undefined) return;
    this.#sendToCaller(invoke, frame as unknown as WorkerEvent);
    if (frame.type === 'chat:done' || frame.type === 'chat:error') {
      this.#cleanup(invoke);
    }
  }

  /**
   * Would adding the edge caller -> target close a cycle?
   *
   * The edges point the way the calls do, so the question is whether the
   * TARGET can already reach the CALLER. A self-call is the degenerate
   * cycle and is refused here too.
   */
  #wouldCreateCycle(caller: string, target: string): boolean {
    if (caller === target) return true;
    const visited = new Set<string>();
    const queue: string[] = [target];
    while (queue.length > 0) {
      const current = queue.shift() as string;
      if (current === caller) return true;
      if (visited.has(current)) continue;
      visited.add(current);
      const next = this.#byCaller.get(current);
      if (next !== undefined) queue.push(next.targetSessionId);
    }
    return false;
  }

  #handleTimeout(invoke: ActiveInvoke): void {
    // A settled invoke has already been cleaned up.
    if (!this.#byInvoke.has(invoke.id)) return;
    this.#sendToCaller(invoke, {
      type: 'chat:error',
      sessionId: invoke.targetSessionId,
      message: 'interagent timeout',
      code: 'timeout',
    });
    if (invoke.runId !== undefined) {
      void this.#ports.cancelRun(invoke.runId, 'interagent-timeout');
    }
    this.#cleanup(invoke);
  }

  #reject(request: InteragentInvokeRequest, reason: InteragentRejectReason, detail?: string): void {
    const invoke = this.#byInvoke.get(request.id);
    const event: WorkerEvent = {
      type: 'chat:error',
      sessionId: request.targetSessionId,
      message: `interagent invoke rejected: ${reason}${detail === undefined ? '' : ` (${detail})`}`,
      code: reason,
    };
    if (invoke !== undefined) {
      this.#sendToCaller(invoke, event);
      return;
    }
    // The invoke was refused before it was registered, so there is no
    // ActiveInvoke to send through. The caller's worker is still the
    // authority on where the event goes.
    this.#sendEventTo(request.callerSessionId, request.id, event);
  }

  #sendToCaller(invoke: ActiveInvoke, event: WorkerEvent): void {
    this.#sendEventTo(invoke.callerSessionId, invoke.id, event);
  }

  #sendEventTo(callerSessionId: string, invokeId: string, event: WorkerEvent): void {
    const worker = this.#ports.getWorker(callerSessionId);
    if (worker === undefined || worker.killed === true) {
      this.#ports.log.warn('Interagent caller worker is gone', { invokeId, callerSessionId });
      return;
    }
    worker.send({ type: 'interagent:event', id: invokeId, event }, (error) => {
      if (error) {
        this.#ports.log.warn('Failed to send interagent:event over IPC', {
          invokeId,
          callerSessionId,
          error: error.message,
        });
      }
    });
  }

  #cleanup(invoke: ActiveInvoke): void {
    if (invoke.timer !== undefined) clearTimeout(invoke.timer);
    invoke.timer = undefined;
    this.#byInvoke.delete(invoke.id);
    if (this.#byTarget.get(invoke.targetSessionId) === invoke) {
      this.#byTarget.delete(invoke.targetSessionId);
    }
    if (this.#byCaller.get(invoke.callerSessionId) === invoke) {
      this.#byCaller.delete(invoke.callerSessionId);
    }
  }
}
