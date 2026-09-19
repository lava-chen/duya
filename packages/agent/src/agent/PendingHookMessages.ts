/**
 * PendingHookMessages — Plan 550 step 2e (TurnPreparer, side-quest slice).
 *
 * Tiny FIFO queue for hook-event messages emitted during a `streamChat`
 * call but not yet appended to the durable timeline. The agent process
 * entry drains the queue at the turn-end boundary via
 * `DuyaAgent.drainPendingHookMessages()` and forwards each entry to
 * `appendMessages` so it persists as a `msg_type: 'hook_invocation'`
 * row.
 *
 * Why extracted:
 *   `pendingHookMessages: Message[] = []` + `drainPendingHookMessages()`
 *   used to live as a private field + public method on `DuyaAgent`. The
 *   state shape is fully self-contained (a FIFO queue with one entry
 *   point, one exit point, no other coupling), so pulling it behind a
 *   class:
 *     1. Makes the FIFO contract testable in isolation (no need to
 *        construct a full `DuyaAgent` for a queue test).
 *     2. Surfaces the `push` and `drain` API as named methods so the
 *        call sites in `streamChat` + `agent-process-entry` read as
 *        intent (push, drain) rather than array indexing.
 *     3. Locks down the "drain returns a fresh array, internal buffer
 *        is reset" invariant behind a single boundary — earlier
 *        inline code used `slice()` + `length = 0`, which is correct
 *        but easy to drift away from if a future caller mutates the
 *        returned array.
 *
 * Behaviour contract (locked by `tests/unit/agent/pending-hook-messages.test.ts`):
 *
 *   - `push(message)` appends; the queue may hold any number of entries.
 *   - `drain()` returns the buffered entries in arrival order and
 *     resets the queue to empty. The returned array is a fresh
 *     reference; callers may mutate it freely without affecting
 *     future `push`es.
 *   - `drain()` on an empty queue returns `[]` (no spurious copy).
 *
 * @see docs/exec-plans/active/550-prompt-hbs-and-agent-decomposition.md
 */

import type { Message } from '../types.js';

export class PendingHookMessages {
  private readonly entries: Message[] = [];

  /** Append a hook-event message to the queue. */
  push(message: Message): void {
    this.entries.push(message);
  }

  /**
   * Return the buffered entries in arrival order and reset the queue
   * to empty. The returned array is a fresh copy — callers may
   * mutate it freely without affecting future `push`es.
   */
  drain(): Message[] {
    if (this.entries.length === 0) return [];
    const drained = this.entries.slice();
    this.entries.length = 0;
    return drained;
  }

  /** Number of buffered entries (read-only diagnostic accessor). */
  get size(): number {
    return this.entries.length;
  }
}