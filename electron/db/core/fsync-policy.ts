/**
 * Plan 441: group-commit fsync policy for the rollout JSONL.
 *
 * Per-event journal writes (Phase 2) trigger one `appendBatch` per
 * semantic boundary. Without batching, each event triggers an OS-level
 * `fsync` which is ~1ms on SSD — multiplied across a tool-heavy turn
 * (5–20 boundaries per turn), it adds non-trivial latency to the
 * stream without proportional durability benefit (process death is
 * already covered by `write()` hitting the page cache; only machine
 * crash needs explicit fsync).
 *
 * Policy:
 *   - `fsyncGroup()` queues a synchronous fsync request
 *   - A 200ms timer drains the queue in a single `fsyncSync` per file
 *     fd that has dirty bytes since the last drain
 *   - `markBarrier('user_msg' | 'turn_end')` upgrades a pending fsync
 *     to immediate — those boundaries are the ones the user can see
 *     (their message landed; their turn finished), so 200ms is too
 *     long to wait for durability
 *
 * The policy is per-instance and not shared across worker processes —
 * each subprocess owns its own rollouts and runs its own fsync timer.
 * Tests that don't exercise persistence don't pay the cost (the policy
 * is constructed lazily and torn down when its owner disposes).
 *
 * NOTE: this module is intentionally OS-aware but conservative. On
 * Windows, `fsyncSync` on the appended file handle is the closest
 * analogue to POSIX fsync — the OS flushes the page cache to disk.
 * `fdatasync` would be nicer for power-loss scenarios but is not
 * available on Windows.
 */

import * as fs from 'node:fs';

export type BarrierKind = 'user_msg' | 'turn_end';

interface FsyncPolicyOptions {
  /** Timer interval for group commit. Default 200ms. */
  intervalMs?: number;
  /** Disable fsync entirely (for tests that don't need durability). */
  disabled?: boolean;
}

export class FsyncPolicy {
  private readonly intervalMs: number;
  private readonly disabled: boolean;
  /** File descriptors that need an fsync at the next drain. */
  private dirty = new Set<number>();
  /** File descriptors that need an fsync IMMEDIATELY (barrier). */
  private barrier = new Set<number>();
  private timer: NodeJS.Timeout | null = null;
  private torndown = false;

  constructor(opts: FsyncPolicyOptions = {}) {
    this.intervalMs = opts.intervalMs ?? 200;
    this.disabled = opts.disabled ?? false;
    if (!this.disabled) {
      this.timer = setInterval(() => this.drain(), this.intervalMs);
      // Don't keep the event loop alive for the fsync timer.
      if (typeof this.timer.unref === 'function') this.timer.unref();
    }
  }

  /**
   * Mark `fd` as having dirty bytes since the last drain. The next
   * `drain()` (or an immediate barrier) will fsync it.
   *
   * No-op when `disabled`.
   */
  markDirty(fd: number): void {
    if (this.disabled || this.torndown) return;
    this.dirty.add(fd);
  }

  /**
   * Promote any pending fsync of `fd` to immediate. Used by journal
   * barriers (`user_msg_added`, `turn_end`) — the user can see those
   * boundaries so the 200ms group window is too long.
   */
  markBarrier(fd: number, kind: BarrierKind): void {
    if (this.disabled || this.torndown) return;
    this.dirty.add(fd);
    this.barrier.add(fd);
    // Force an immediate drain — the cost is one fsync per barrier,
    // not per event, so it's bounded.
    queueMicrotask(() => {
      if (!this.torndown) this.drain();
    });
  }

  /**
   * Flush dirty file descriptors. Idempotent — safe to call from the
   * timer AND from `markBarrier` concurrently; the Set-based dedup
   * ensures each fd is fsynced at most once per drain.
   */
  drain(): void {
    if (this.torndown) return;
    if (this.dirty.size === 0) return;
    // Snapshot + clear before fsync so a fsync that triggers more
    // markDirty calls (recursively) lands in the NEXT drain.
    const fds = Array.from(this.dirty);
    this.dirty.clear();
    this.barrier.clear();
    for (const fd of fds) {
      try {
        fs.fsyncSync(fd);
      } catch {
        // fsync on a stale fd (file rotated, fd closed) is non-fatal;
        // the next appendBatch path will reopen. Don't throw — we're
        // called from the group timer, not a user-facing path.
      }
    }
  }

  /** Force an immediate drain and stop the timer. Used at agent shutdown. */
  dispose(): void {
    if (this.torndown) return;
    this.drain();
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.torndown = true;
  }

  /** Test-only: peek the dirty set to assert fsync batching. */
  _peekDirty(): readonly number[] {
    return Array.from(this.dirty);
  }
}

/**
 * Single global fsync policy used by MessageLog. Constructed on first
 * use; tests can call `resetGlobalFsyncPolicy()` to drop the singleton
 * between cases.
 */
let globalPolicy: FsyncPolicy | null = null;

export function getGlobalFsyncPolicy(): FsyncPolicy {
  if (!globalPolicy) {
    globalPolicy = new FsyncPolicy();
  }
  return globalPolicy;
}

export function resetGlobalFsyncPolicy(): void {
  if (globalPolicy) {
    globalPolicy.dispose();
    globalPolicy = null;
  }
}