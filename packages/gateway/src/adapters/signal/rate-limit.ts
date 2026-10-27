/**
 * Client-side token bucket mirroring signal-cli's server-side limit.
 *
 * Signal's servers allow roughly 50 messages of burst and one message per
 * 4 seconds afterwards; attachments count extra. Without a local bucket the
 * adapter discovers the limit by receiving 429s, and every 429 costs the whole
 * burst again. `feedback()` lets a real 429 recalibrate refill instead of
 * trusting the compiled-in guess.
 */

export interface TokenBucketOptions {
  capacity?: number;
  refillMs?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

const DEFAULT_CAPACITY = 50;
const DEFAULT_REFILL_MS = 4000;

export class TokenBucket {
  private readonly capacity: number;
  private refillMs: number;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;

  private tokens: number;
  private lastRefill: number;
  /** Serializes waiters so concurrent sends cannot both consume one token. */
  private queue: Promise<void> = Promise.resolve();

  constructor(options: TokenBucketOptions = {}) {
    this.capacity = Math.max(1, options.capacity ?? DEFAULT_CAPACITY);
    this.refillMs = Math.max(1, options.refillMs ?? DEFAULT_REFILL_MS);
    this.now = options.now ?? Date.now;
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.tokens = this.capacity;
    this.lastRefill = this.now();
  }

  /** Tokens available right now (after applying elapsed refill). */
  available(): number {
    this.refill();
    return this.tokens;
  }

  /** Wait until `count` tokens are available, then consume them. */
  acquire(count = 1): Promise<void> {
    const cost = Math.max(1, Math.min(count, this.capacity));
    const run = this.queue.then(async () => {
      for (;;) {
        this.refill();
        if (this.tokens >= cost) {
          this.tokens -= cost;
          return;
        }
        const missing = cost - this.tokens;
        await this.sleep(Math.max(1, missing * this.refillMs));
      }
    });
    // Keep the chain alive even when a waiter rejects.
    this.queue = run.catch(() => undefined);
    return run;
  }

  /** Server told us to back off: drain the bucket and adopt its refill rate. */
  feedback(retryAfterSeconds: number, cost = 1): void {
    this.tokens = 0;
    this.lastRefill = this.now();
    if (retryAfterSeconds > 0) {
      this.refillMs = Math.max(1, (retryAfterSeconds * 1000) / Math.max(1, cost));
    }
  }

  private refill(): void {
    const elapsed = this.now() - this.lastRefill;
    if (elapsed <= 0) return;
    const gained = Math.floor(elapsed / this.refillMs);
    if (gained <= 0) return;
    this.tokens = Math.min(this.capacity, this.tokens + gained);
    this.lastRefill += gained * this.refillMs;
  }
}

/** Attachment-heavy messages cost one token per 32 attachments on the server. */
export function tokenCostForAttachments(attachmentCount: number): number {
  return 1 + Math.floor(attachmentCount / 32);
}
