/**
 * idle-shutdown.ts — stop a client-scoped Host without destroying a turn.
 *
 * ## Why the drain comes before the close
 *
 * The idle verdict says "no client holds a lease"; it does not say "the turn
 * nobody is watching anymore is worthless". A worker mid-turn still holds the
 * only copy of the answer the user asked for, and `HostSessionHttpServer.close`
 * destroys every run event stream — so closing first shows a healthy turn as
 * `terminated` and then drains a worker whose output can no longer be read.
 * The order here is deliberate: wait for the turn to settle while the event
 * streams are still open, then close.
 *
 * ## Why the verdict can be cancelled
 *
 * The grace period and the drain are both wall-clock waits, and a client that
 * reconnects during either one is present again. An idle verdict is a
 * snapshot, not a state, so a client returning cancels the shutdown instead of
 * being shut down under.
 */

export interface IdleShutdownLogger {
  info(message: string, context?: Record<string, unknown>): void;
  warn(message: string, context?: Record<string, unknown>): void;
}

export interface IdleShutdownOptions {
  /** How long a mid-turn worker gets before the shutdown proceeds anyway. */
  readonly drainTimeoutMs: number;
  readonly isMidTurn: () => boolean;
  readonly waitForSettle: (timeoutMs: number) => Promise<'settled' | 'timeout'>;
  /** Stop the Host. Called at most once. */
  readonly shutdown: () => Promise<void>;
  readonly log: IdleShutdownLogger;
}

export interface IdleShutdownController {
  /** Begin a shutdown. Ignored while one is already waiting or closing. */
  schedule(): void;
  /** A client came back. Returns true when a pending shutdown was cancelled. */
  cancel(): boolean;
  /** True while the controller is waiting for a turn to settle. */
  readonly waiting: boolean;
}

export function createIdleShutdown(options: IdleShutdownOptions): IdleShutdownController {
  let state: 'idle' | 'waiting' | 'closing' = 'idle';
  let generation = 0;
  let interruptWait: (() => void) | null = null;

  const cancel = (): boolean => {
    if (state !== 'waiting') return false;
    state = 'idle';
    generation += 1;
    const interrupt = interruptWait;
    interruptWait = null;
    interrupt?.();
    return true;
  };

  const run = async (attempt: number): Promise<void> => {
    if (options.drainTimeoutMs > 0 && options.isMidTurn()) {
      options.log.info('Idle shutdown: waiting for the in-flight turn to settle', {
        timeoutMs: options.drainTimeoutMs,
      });
      // Whichever happens first decides whether this shutdown is still wanted:
      // the turn settles, or a client comes back.
      const interrupted = new Promise<'interrupted'>((resolve) => {
        interruptWait = () => resolve('interrupted');
      });
      const outcome = await Promise.race([
        options.waitForSettle(options.drainTimeoutMs).then(
          (result) => ({ kind: 'settled' as const, result }),
          (error: unknown) => ({ kind: 'failed' as const, error }),
        ),
        interrupted.then(() => ({ kind: 'interrupted' as const })),
      ]);
      interruptWait = null;
      if (outcome.kind === 'interrupted' || attempt !== generation) {
        options.log.info('Idle shutdown: a client reattached; staying up');
        return;
      }
      if (outcome.kind === 'failed') {
        options.log.warn('Idle shutdown: could not wait for the turn to settle', {
          error: outcome.error instanceof Error ? outcome.error.message : String(outcome.error),
        });
      } else if (outcome.result === 'timeout') {
        options.log.warn('Idle shutdown: the turn is still running after the drain cap', {
          timeoutMs: options.drainTimeoutMs,
        });
      }
    }
    if (attempt !== generation) return;
    state = 'closing';
    try {
      await options.shutdown();
    } catch (error) {
      options.log.warn('Idle shutdown failed', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  };

  return {
    schedule(): void {
      if (state !== 'idle') return;
      state = 'waiting';
      generation += 1;
      void run(generation);
    },
    cancel,
    get waiting(): boolean {
      return state === 'waiting';
    },
  };
}
