/**
 * client-lease.ts — know whether anybody is still attached to this Host.
 *
 * ## Why this exists
 *
 * A Host owns the SQLite files of one data directory, so a Host nobody talks
 * to keeps a lock nobody else can take. `duya serve` is a foreground service
 * the user stops by hand; a Host that `duya tui` started in the background has
 * no such user, so it has to notice on its own that its clients left.
 *
 * ## The signal
 *
 * A client holds one long-lived `GET /v1/host/lease` request open for as long
 * as it wants the Host to stay alive. The Host counts those requests. When the
 * last one is gone — and it stays gone for the idle timeout — the Host reports
 * itself idle and its owner shuts it down.
 *
 * A lease is a presence signal, not a lock. Several clients may hold leases at
 * the same time; the Host only ever asks "is anybody still there?".
 *
 * ## Why not "time since the last request"
 *
 * A client that is streaming a long turn sends no requests at all: its only
 * traffic is the one open event stream. Judging liveness by request frequency
 * would declare such a client gone. An explicit lease stays open for exactly
 * as long as the client wants the Host to stay, including while it is busy.
 */

/**
 * How long the Host waits after the last lease is gone before it reports idle.
 *
 * The grace period is not decoration: a client that is restarting, or a second
 * window opening right as the first one closes, must not be answered by a
 * Host that has already decided to exit.
 */
export const DEFAULT_CLIENT_LEASE_IDLE_MS = 30_000;

export interface ClientLeaseTrackerOptions {
  /** Silence after which the Host considers itself client-less. */
  readonly idleTimeoutMs?: number;
  readonly now?: () => number;
}

/** Counts the clients that want this Host to stay alive. */
export class ClientLeaseTracker {
  #leases = 0;
  #lastLeaseLostAt: number;
  readonly #idleTimeoutMs: number;
  readonly #now: () => number;

  constructor(options: ClientLeaseTrackerOptions = {}) {
    this.#idleTimeoutMs = options.idleTimeoutMs ?? DEFAULT_CLIENT_LEASE_IDLE_MS;
    this.#now = options.now ?? Date.now;
    // The Host starts with no clients. The clock starts now so a Host nobody
    // ever attaches to still gives up instead of holding the lock forever.
    this.#lastLeaseLostAt = this.#now();
  }

  /** How many clients currently hold a lease. */
  get leaseCount(): number {
    return this.#leases;
  }

  /** A client took a lease. */
  acquire(): void {
    this.#leases += 1;
  }

  /**
   * A client released its lease.
   *
   * The clock restarts only when the last lease goes: while any client is
   * still attached, the Host is not idle no matter how long ago that was.
   */
  release(): void {
    if (this.#leases <= 0) return;
    this.#leases -= 1;
    if (this.#leases === 0) this.#lastLeaseLostAt = this.#now();
  }

  /**
   * True when no client has held a lease for the idle timeout.
   *
   * The very first check on a fresh Host is already meaningful: nobody has
   * attached yet, so the Host is idle from the moment it started.
   */
  isIdle(): boolean {
    if (this.#leases > 0) return false;
    return this.#now() - this.#lastLeaseLostAt >= this.#idleTimeoutMs;
  }
}
