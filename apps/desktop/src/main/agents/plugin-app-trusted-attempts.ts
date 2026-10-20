import type { ChildProcess } from 'node:child_process';

/**
 * The attempt a transport correlated a worker request with.
 *
 * The Agent Server owns the run ledger and the worker supervisor, so it is
 * the only party that can say "this child is the live worker of this session,
 * under this run and epoch". The correlation travels on the transport's own
 * message type and is consumed with the request it belongs to, because the
 * request body belongs to whoever sent it.
 */
export interface PluginAppTrustedAttempt {
  readonly sessionId: string;
  readonly runId: string;
  readonly epoch: number;
}

/**
 * The one-time sideband store on the Main side.
 *
 * ## Why the child is part of the key
 *
 * The announcement and the request it belongs to both arrive over one Agent
 * Server child's IPC channel, so a request id alone would normally be enough.
 * It is not enough in the one case that matters: a replacement Agent Server
 * can be started while the outgoing one is still on its way down. The
 * outgoing child's exit handler would then drop the incoming child's
 * announcements, and the incoming child's request could consume an
 * announcement the outgoing child made. Both are the same bug — a
 * correlation is a fact about ONE process, and it dies with that process.
 *
 * ## Why consumption is one-time
 *
 * A correlation authorises exactly one request. A second request carrying the
 * same id is a retry or a forgery, and either way it must not inherit the
 * first one's authority.
 */
export class PluginAppTrustedAttemptStore {
  readonly #byRequestId = new Map<string, { readonly child: ChildProcess; readonly attempt: PluginAppTrustedAttempt }>();

  /**
   * Record the correlation one child announced for one request.
   *
   * `false` when the announcement does not carry a usable attempt. Nothing is
   * recorded in that case, so the request it belonged to is refused for want
   * of a correlation rather than being answered with a half-formed one.
   */
  announce(child: ChildProcess, requestId: string, attempt: PluginAppTrustedAttempt): boolean {
    if (!attempt.sessionId || !attempt.runId) return false;
    if (!Number.isSafeInteger(attempt.epoch) || attempt.epoch < 0) return false;
    this.#byRequestId.set(requestId, { child, attempt: { ...attempt } });
    return true;
  }

  /**
   * Record the correlation carried by one Agent Server message.
   *
   * The message shape is the transport's, so reading it belongs here rather
   * than in the caller: a malformed announcement is refused here, once, and
   * not once per caller.
   */
  announceFromMessage(child: ChildProcess, message: Record<string, unknown>): boolean {
    if (typeof message.id !== 'string') return false;
    return this.announce(child, message.id, {
      sessionId: typeof message.sessionId === 'string' ? message.sessionId : '',
      runId: typeof message.runId === 'string' ? message.runId : '',
      epoch: typeof message.epoch === 'number' && Number.isSafeInteger(message.epoch) ? message.epoch : -1,
    });
  }

  /**
   * Take the correlation for one request, once.
   *
   * `undefined` when there is none, when it belongs to another child, or when
   * it was already taken.
   *
   * In the "belongs to another child" case the entry is LEFT in place: it is
   * that other child's correlation, and that child's own request may still
   * arrive. Dropping it here would hand the next request a chance to claim
   * it.
   */
  consume(child: ChildProcess, requestId: string): PluginAppTrustedAttempt | undefined {
    const entry = this.#byRequestId.get(requestId);
    if (!entry) return undefined;
    if (entry.child !== child) return undefined;
    this.#byRequestId.delete(requestId);
    return entry.attempt;
  }

  /** Drop every correlation one child announced. That child cannot announce again. */
  release(child: ChildProcess): void {
    for (const [requestId, entry] of this.#byRequestId) {
      if (entry.child === child) this.#byRequestId.delete(requestId);
    }
  }

  /** How many correlations are held. A leak detector. */
  get size(): number {
    return this.#byRequestId.size;
  }
}
