/**
 * Ring buffer for Emacs-style kill/yank operations.
 *
 * Ported from minimax-code (`packages/tui/src/tui/engine/kill-ring.ts`). The
 * semantics are the ones an Emacs user's fingers already know: each kill
 * pushes an entry, and CONSECUTIVE kills accumulate into the most recent entry
 * instead of creating a new one — so killing to the end of the line and then
 * killing a word yanks back BOTH as one string.
 *
 * `prepend` records the direction of the deletion: killing BACKWARD
 * (Ctrl+U, Ctrl+W) deletes text that read before the previous entry, so the
 * accumulated text must be reconstructed in document order — backward kills
 * prepend, forward kills append.
 */
export class KillRing {
  private ring: string[] = [];

  /**
   * Add killed text to the ring.
   *
   * `accumulate` merges with the most recent entry rather than pushing a new
   * one; the caller decides when that applies (it passes `lastAction === 'kill'`).
   */
  push(text: string, opts: { prepend: boolean; accumulate?: boolean }): void {
    if (text === '') return;

    if (opts.accumulate === true && this.ring.length > 0) {
      const last = this.ring.pop() as string;
      this.ring.push(opts.prepend ? text + last : last + text);
    } else {
      this.ring.push(text);
    }
    if (this.ring.length > MAX_KILL_RING) this.ring.shift();
  }

  /** Most recent entry without modifying the ring. */
  peek(): string | undefined {
    return this.ring.length > 0 ? this.ring[this.ring.length - 1] : undefined;
  }

  /** Move the last entry to the front — how `yank-pop` cycles. */
  rotate(): void {
    if (this.ring.length > 1) {
      const last = this.ring.pop() as string;
      this.ring.unshift(last);
    }
  }

  get length(): number {
    return this.ring.length;
  }
}

/** Cap on retained entries; see `KillRing.push`. */
export const MAX_KILL_RING = 60;
