/**
 * Keep a client lease held for the lifetime of a terminal.
 *
 * A lease is the only thing telling a client-scoped Host that somebody still
 * wants it alive. Losing one is not fatal by itself: the Host waits out its
 * idle grace before doing anything, and a terminal that reattaches inside that
 * window is indistinguishable from one that never left. So a dropped lease is
 * re-acquired here, with backoff, instead of being accepted as "this Host is
 * shutting down".
 *
 * A Host that answers 404 does not offer leases (the Desktop's Host, or a
 * foreground `duya serve`). That Host runs until somebody stops it, so this
 * holder stops trying and holds nothing.
 */

import type { HostClientLease } from '@duya/host/http-client';

/** Consecutive delays between re-acquire attempts; the last value repeats. */
const DEFAULT_RETRY_DELAYS_MS = [500, 1_000, 2_000, 5_000] as const;

export interface ClientLeaseSource {
  openClientLease(): Promise<HostClientLease | null>;
}

export interface ClientLeaseTimers {
  setTimeout(callback: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

export interface HoldClientLeaseOptions {
  readonly retryDelaysMs?: readonly number[];
  readonly timers?: ClientLeaseTimers;
  /** The Host ended the lease; a re-acquire is scheduled. */
  readonly onLost?: (reason: string) => void;
  /** A lease was granted again after a loss. */
  readonly onReacquired?: () => void;
  /** The Host does not offer leases; nothing will be held. */
  readonly onUnavailable?: () => void;
}

export interface ClientLeaseHolder {
  /** Release the lease and stop re-acquiring. */
  close(): void;
  /** True while a lease is held. */
  readonly held: boolean;
}

const defaultTimers: ClientLeaseTimers = {
  setTimeout: (callback, ms) => setTimeout(callback, ms),
  clearTimeout: (handle) => {
    clearTimeout(handle as ReturnType<typeof setTimeout>);
  },
};

export function holdClientLease(
  client: ClientLeaseSource,
  options: HoldClientLeaseOptions = {},
): ClientLeaseHolder {
  const delays = options.retryDelaysMs ?? DEFAULT_RETRY_DELAYS_MS;
  const timers = options.timers ?? defaultTimers;
  let closed = false;
  let attaching = false;
  let lease: HostClientLease | null = null;
  let everHeld = false;
  let failures = 0;
  let retryTimer: unknown = null;

  const stop = (): void => {
    if (closed) return;
    closed = true;
    if (retryTimer !== null) {
      timers.clearTimeout(retryTimer);
      retryTimer = null;
    }
    const held = lease;
    lease = null;
    held?.close();
  };

  const schedule = (): void => {
    if (closed || retryTimer !== null) return;
    const delay = delays[Math.min(failures, delays.length - 1)] ?? 0;
    failures += 1;
    retryTimer = timers.setTimeout(() => {
      retryTimer = null;
      void attach();
    }, delay);
  };

  const attach = async (): Promise<void> => {
    if (closed || attaching) return;
    attaching = true;
    let opened: HostClientLease | null;
    try {
      opened = await client.openClientLease();
    } catch {
      attaching = false;
      schedule();
      return;
    }
    attaching = false;
    if (closed) {
      opened?.close();
      return;
    }
    if (opened === null) {
      closed = true;
      options.onUnavailable?.();
      return;
    }
    lease = opened;
    const reattached = everHeld;
    everHeld = true;
    failures = 0;
    if (reattached) options.onReacquired?.();
    void opened.lost.then((reason) => {
      if (closed || lease !== opened) return;
      lease = null;
      options.onLost?.(reason);
      schedule();
    });
  };

  void attach();

  return {
    close: stop,
    get held(): boolean {
      return lease !== null;
    },
  };
}
