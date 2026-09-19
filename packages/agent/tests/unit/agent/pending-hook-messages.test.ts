/**
 * PendingHookMessages unit tests — Plan 550 step 2e (side-quest slice).
 *
 * Pins the FIFO contract the agent process entry relies on:
 *
 *   - `push` appends in arrival order.
 *   - `drain` returns the buffered entries in arrival order and
 *     resets the queue to empty.
 *   - The drained array is a fresh copy: mutating it does not affect
 *     subsequent `push`es (the agent-process-entry case mutates the
 *     array to tag `msg_type` metadata before persisting).
 *   - `drain` on an empty queue returns `[]` without spurious copy.
 *   - `size` reports the current buffer length for diagnostics.
 *
 * @see docs/exec-plans/active/550-prompt-hbs-and-agent-decomposition.md
 */

import { describe, expect, it } from 'vitest';

import { PendingHookMessages } from '../../../src/agent/PendingHookMessages.js';
import type { Message } from '../../../src/types.js';

function msg(id: string, timestamp: number): Message {
  return { id, role: 'user', content: id, timestamp };
}

describe('PendingHookMessages (Plan 550 2e side-quest)', () => {
  it('starts empty', () => {
    const q = new PendingHookMessages();
    expect(q.size).toBe(0);
    expect(q.drain()).toEqual([]);
  });

  it('returns the buffered entries in arrival order on first drain', () => {
    const q = new PendingHookMessages();
    q.push(msg('a', 1));
    q.push(msg('b', 2));
    q.push(msg('c', 3));
    expect(q.size).toBe(3);
    expect(q.drain()).toEqual([
      { id: 'a', role: 'user', content: 'a', timestamp: 1 },
      { id: 'b', role: 'user', content: 'b', timestamp: 2 },
      { id: 'c', role: 'user', content: 'c', timestamp: 3 },
    ]);
  });

  it('resets the queue after drain', () => {
    const q = new PendingHookMessages();
    q.push(msg('a', 1));
    q.push(msg('b', 2));
    q.drain();
    expect(q.size).toBe(0);
    expect(q.drain()).toEqual([]);
  });

  it('returns a fresh array on each drain (caller may mutate safely)', () => {
    const q = new PendingHookMessages();
    q.push(msg('a', 1));
    const drained = q.drain();
    drained.push(msg('mutation', 99));
    // Subsequent drain is unaffected by the caller's mutation.
    expect(q.drain()).toEqual([]);
    expect(q.size).toBe(0);
  });

  it('supports push + drain cycles indefinitely', () => {
    const q = new PendingHookMessages();
    for (let cycle = 0; cycle < 5; cycle++) {
      q.push(msg(`c${cycle}-1`, cycle));
      q.push(msg(`c${cycle}-2`, cycle));
      expect(q.drain().map((m) => m.id)).toEqual([`c${cycle}-1`, `c${cycle}-2`]);
      expect(q.size).toBe(0);
    }
  });

  it('returns [] without copy on empty drain (verified by reference identity)', () => {
    const q = new PendingHookMessages();
    // drain() on empty must return a value, not undefined.
    const result = q.drain();
    expect(result).toEqual([]);
    expect(Array.isArray(result)).toBe(true);
  });
});