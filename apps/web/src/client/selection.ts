/**
 * Selection scoping for in-flight browser work.
 *
 * ## The failure this exists to prevent
 *
 * A session switch starts several asynchronous things at once — a session
 * record, a message page, a run list, an event stream, an approval poll. Abort
 * handles alone do not close the hole: a response that was already resolved
 * when `abort()` lands will still run its continuation and still write into
 * state. On a fast machine, switching sessions twice in a row lands exactly
 * that response, and the visible result is a header from one session above a
 * transcript from another — with no error anywhere to explain it.
 *
 * So there are two mechanisms and both are needed:
 *
 *  - an `AbortSignal`, which stops work that has not finished, and
 *  - a generation number, which refuses work that finished too late.
 *
 * Every task that touches selection state checks `isCurrent()` immediately
 * before it commits, and `begin()` aborts whatever the previous selection
 * started. A stale task therefore costs one dropped write, not a wrong screen.
 */

export interface SelectionLease {
  /** Monotonic identity of one selection. Never reused. */
  readonly generation: number;
  /** Aborted when this selection is replaced or the scope is torn down. */
  readonly signal: AbortSignal;
  /** False once another selection has begun; checked before every commit. */
  isCurrent(): boolean;
}

export class SelectionScope {
  #controller: AbortController | null = null;
  #lease: SelectionLease | null = null;

  /**
   * Begin a selection, aborting the previous one. The previous lease stays
   * usable for its cleanup path: `isCurrent()` reports false and its signal is
   * already aborted, so an in-flight task stops on whichever it checks first.
   */
  begin(): SelectionLease {
    this.#controller?.abort();
    const scope = this;
    const controller = new AbortController();
    const lease: SelectionLease = {
      generation: (this.#lease?.generation ?? 0) + 1,
      signal: controller.signal,
      isCurrent: () => scope.#lease === lease,
    };
    this.#controller = controller;
    this.#lease = lease;
    return lease;
  }

  /** Abort the current selection without starting another. */
  end(): void {
    this.#controller?.abort();
    this.#controller = null;
    this.#lease = null;
  }

  /** The live lease, or `null` when nothing is selected. */
  current(): SelectionLease | null {
    return this.#lease;
  }
}

/** Wait for `ms`, resolving early with `false` when the signal aborts. */
export function delay(ms: number, signal: AbortSignal): Promise<boolean> {
  if (signal.aborted) return Promise.resolve(false);
  return new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve(true);
    }, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      resolve(false);
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

/** True when an abort means "we asked for it" rather than "it failed". */
export function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
}
