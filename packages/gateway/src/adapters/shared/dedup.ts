/**
 * Bounded de-duplication set for inbound platform message IDs.
 *
 * Every adapter needs the same three properties, and every adapter used to
 * hand-roll them slightly differently:
 * - FIFO eviction once `capacity` is reached (never unbounded memory),
 * - optional TTL for platforms that replay (Signal/BlueBubbles re-deliver),
 * - O(1) `seen()` / `add()`.
 */
export interface BoundedIdSetOptions {
  /** Maximum retained IDs. Defaults to 500. */
  capacity?: number;
  /** Drop entries older than this many ms. `0`/undefined disables TTL. */
  ttlMs?: number;
  /** Injectable clock for tests. */
  now?: () => number;
}

export class BoundedIdSet {
  private readonly ids = new Set<string>();
  private readonly addedAt = new Map<string, number>();
  private readonly capacity: number;
  private readonly ttlMs: number;
  private readonly now: () => number;

  constructor(options: BoundedIdSetOptions = {}) {
    this.capacity = Math.max(1, options.capacity ?? 500);
    this.ttlMs = Math.max(0, options.ttlMs ?? 0);
    this.now = options.now ?? Date.now;
  }

  /** True when the ID was already recorded and is still within its TTL. */
  has(id: string): boolean {
    if (!this.ids.has(id)) return false;
    if (this.ttlMs > 0) {
      const at = this.addedAt.get(id);
      if (at !== undefined && this.now() - at > this.ttlMs) {
        this.ids.delete(id);
        this.addedAt.delete(id);
        return false;
      }
    }
    return true;
  }

  /**
   * Record an ID. Returns `false` when it was already present (i.e. the caller
   * is looking at a duplicate and should drop it).
   */
  add(id: string): boolean {
    if (this.has(id)) return false;
    this.ids.add(id);
    if (this.ttlMs > 0) this.addedAt.set(id, this.now());
    if (this.ids.size > this.capacity) {
      const oldest = this.ids.values().next().value;
      if (oldest !== undefined) {
        this.ids.delete(oldest);
        this.addedAt.delete(oldest);
      }
    }
    return true;
  }

  /** @deprecated Alias kept for adapters that read like a dedup filter. */
  isDuplicate(id: string): boolean {
    return !this.add(id);
  }

  get size(): number {
    return this.ids.size;
  }

  clear(): void {
    this.ids.clear();
    this.addedAt.clear();
  }
}
