/**
 * Bash admission control.
 *
 * Caps the number of concurrent background bash tasks the agent will keep
 * alive at once. Mirrors mcode's `admitBackgroundTask` slot-gate so a single
 * runaway agent loop cannot spawn an unbounded number of detached processes
 * and exhaust the host's process table / file descriptors.
 *
 * Acquisition semantics:
 *   - Explicit `run_in_background: true` requests fail fast with a clear
 *     error if no slot is free (matches mcode's `controller.abort` path).
 *   - Soft-yield foreground promotions are best-effort: if the gate is full
 *     the task still runs to completion in the background and is flagged
 *     `admissionOverflow: true` so the agent can see the overage but the
 *     user never loses a process they were watching.
 *
 * The controller is a process-wide singleton (one agent process owns at
 * most one BashTool runtime), but the constructor takes a `capacity` so
 * tests can pin the value without monkey-patching globals.
 */

export const DEFAULT_BASH_ADMISSION_SLOTS = 8;

/**
 * Opaque admission token. The caller MUST invoke `release()` exactly once
 * when the task reaches a terminal state, otherwise the slot leaks until
 * the process exits. `slot` is exposed for diagnostics / log fields.
 */
export interface BashAdmissionToken {
  readonly slot: number;
  /**
   * Whether this token was acquired above the configured capacity. Always
   * `false` for `tryAcquire()` / `acquire()`; only `acquireOverflow()` sets
   * it to `true`. Useful for tagging soft-yield promotions that bypass the
   * gate because a slot was not available at promote time.
   */
  readonly overflow: boolean;
  release(): void;
}

type Waiter = {
  resolve: (token: BashAdmissionToken) => void;
  reject: (reason: Error) => void;
  signal?: AbortSignal;
};

/**
 * Slot-based admission controller for background bash tasks. A fixed number
 * of slots are available; `tryAcquire` is non-blocking, `acquire` queues
 * waiters until a slot frees up.
 */
export class BashAdmissionController {
  private readonly slots: Array<true | null>;
  private readonly waiters: Waiter[] = [];

  constructor(public readonly capacity: number = DEFAULT_BASH_ADMISSION_SLOTS) {
    if (!Number.isInteger(capacity) || capacity < 1) {
      throw new Error(
        `BashAdmissionController capacity must be a positive integer, got ${capacity}`,
      );
    }
    this.slots = Array.from({ length: capacity }, () => null);
  }

  /**
   * Non-blocking acquire. Returns `null` if no slot is free.
   */
  tryAcquire(): BashAdmissionToken | null {
    const idx = this.slots.findIndex((s) => s === null);
    if (idx === -1) return null;
    this.slots[idx] = true;
    return this.wrapSlot(idx, false);
  }

  /**
   * Blocking acquire. Resolves when a slot frees up, or rejects if the
   * optional abort signal fires while the request is queued.
   */
  acquire(signal?: AbortSignal): Promise<BashAdmissionToken> {
    const immediate = this.tryAcquire();
    if (immediate) return Promise.resolve(immediate);
    return new Promise<BashAdmissionToken>((resolve, reject) => {
      const waiter: Waiter = { resolve, reject, signal };
      this.waiters.push(waiter);
      if (signal) {
        const onAbort = () => this.rejectWaiter(waiter, signal.reason ?? new Error('Admission aborted'));
        if (signal.aborted) {
          this.rejectWaiter(waiter, signal.reason ?? new Error('Admission aborted'));
          return;
        }
        signal.addEventListener('abort', onAbort, { once: true });
      }
    });
  }

  /**
   * Acquire-or-overflow. Always resolves immediately: if a slot is free it
   * is taken normally (overflow=false), otherwise a phantom token with
   * `overflow=true` is returned and the task continues running without
   * blocking. Used by soft-yield promotion so the foreground tool call
   * never waits on admission.
   */
  acquireOverflow(): BashAdmissionToken {
    const normal = this.tryAcquire();
    if (normal) return normal;
    // Phantom slot outside the array — release() just decrements the
    // overflow counter and notifies waiters (none should be queued, but
    // be safe).
    const idx = this.slots.length + this.overflowCount;
    this.overflowCount += 1;
    let released = false;
    return {
      slot: idx,
      overflow: true,
      release: () => {
        if (released) return;
        released = true;
        this.overflowCount = Math.max(0, this.overflowCount - 1);
        this.processWaiters();
      },
    };
  }

  private overflowCount = 0;

  /** Current number of acquired slots (excludes overflow tokens). */
  get activeCount(): number {
    return this.slots.filter((s) => s !== null).length;
  }

  /** Current number of overflow tokens issued. */
  get overflowActiveCount(): number {
    return this.overflowCount;
  }

  /** Number of queued waiters waiting for a free slot. */
  get queuedCount(): number {
    return this.waiters.length;
  }

  private wrapSlot(idx: number, overflow: boolean): BashAdmissionToken {
    let released = false;
    return {
      slot: idx,
      overflow,
      release: () => {
        if (released) return;
        released = true;
        this.slots[idx] = null;
        this.processWaiters();
      },
    };
  }

  private processWaiters(): void {
    while (this.waiters.length > 0) {
      const token = this.tryAcquire();
      if (!token) break;
      const waiter = this.waiters.shift()!;
      waiter.resolve(token);
    }
  }

  private rejectWaiter(waiter: Waiter, reason: unknown): void {
    const idx = this.waiters.indexOf(waiter);
    if (idx === -1) return;
    this.waiters.splice(idx, 1);
    waiter.reject(reason instanceof Error ? reason : new Error(String(reason)));
  }
}

/** Process-wide singleton (one agent process owns at most one controller). */
let _admission: BashAdmissionController | null = null;

export function getBashAdmission(): BashAdmissionController {
  if (!_admission) {
    _admission = new BashAdmissionController();
  }
  return _admission;
}

export function resetBashAdmission(): void {
  _admission = null;
}