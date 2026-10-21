/**
 * TurnEventDispatcher test — Plan 550 step 2e infrastructure.
 *
 * The dispatcher is foundation-only at this stage. The 13 inline
 * `yield { type: ... }` sites in `DuyaAgent.streamChat` will migrate
 * to `dispatcher.dispatch(...)` calls in subsequent commits (2e-2 /
 * 2e-3). This test pins the dispatcher's contract:
 *
 *   - `seq_index` is monotonic and starts at 0.
 *   - The dispatcher never mutates the input event.
 *   - `recordLog: true` captures every dispatched event in order.
 *   - `attachTurnId` stamps the per-turn id without touching payloads.
 *   - `dispatch` returns a fresh object (consumers can re-dispatch).
 *
 * Five cases:
 *   1. Empty dispatcher — peekNextSeqIndex / lastAssignedSeqIndex defaults.
 *   2. Single dispatch — seq_index 0, fresh-object guarantee.
 *   3. Multiple dispatches — monotonic seq_index, log ordering.
 *   4. attachTurnId after dispatch — log entries pick up new turnId.
 *   5. recordLog: false — getLog returns null (no leak).
 */
import { describe, expect, it } from 'vitest';
import { TurnEventDispatcher } from '../../../src/agent/TurnEventDispatcher.js';

describe('TurnEventDispatcher (Plan 550 step 2e)', () => {
  it('starts with seq_index 0 and reports -1 for the last assigned', () => {
    const d = new TurnEventDispatcher()
    expect(d.peekNextSeqIndex()).toBe(0)
    expect(d.lastAssignedSeqIndex()).toBe(-1)
  });

  it('dispatches a single event with seq_index 0 and does not mutate the input', () => {
    const d = new TurnEventDispatcher({ initialTurnId: 'turn-1' })
    const input = { type: 'turn_start', data: { turnCount: 1 } }
    const out = d.dispatch(input)

    expect(out.seq_index).toBe(0)
    expect(out.type).toBe('turn_start')
    expect(out.data).toEqual({ turnCount: 1 })
    // The dispatcher must not mutate the caller's object.
    expect((input as { seq_index?: number }).seq_index).toBeUndefined()
    // A fresh object — mutating the output must not affect future dispatch inputs.
    const outMut = out as { data: { turnCount: number } }
    outMut.data.turnCount = 99
    const out2 = d.dispatch({ type: 'turn_start', data: { turnCount: 2 } })
    expect(out2.data).toEqual({ turnCount: 2 })
  });

  it('increments seq_index monotonically across multiple dispatches', () => {
    const d = new TurnEventDispatcher({ recordLog: true })
    const out0 = d.dispatch({ type: 'turn_start', data: {} })
    const out1 = d.dispatch({ type: 'text', data: 'hello' })
    const out2 = d.dispatch({ type: 'done', reason: 'completed' })

    expect([out0.seq_index, out1.seq_index, out2.seq_index]).toEqual([0, 1, 2])
    expect(d.lastAssignedSeqIndex()).toBe(2)

    const log = d.getLog()!
    expect(log.map(e => e.seqIndex)).toEqual([0, 1, 2])
    expect(log.map(e => e.event.type)).toEqual(['turn_start', 'text', 'done'])
  });

  it('mirrors the latest turn id in log entries after attachTurnId', () => {
    const d = new TurnEventDispatcher({ recordLog: true, initialTurnId: 'turn-1' })
    d.dispatch({ type: 'turn_start', data: {} })
    d.attachTurnId('turn-2')
    d.dispatch({ type: 'text', data: 'after-attachment' })

    const log = d.getLog()!
    expect(log[0]?.turnId).toBe('turn-1')
    expect(log[1]?.turnId).toBe('turn-2')
  });

  it('returns null from getLog when recordLog was not enabled', () => {
    const d = new TurnEventDispatcher()
    d.dispatch({ type: 'turn_start', data: {} })
    expect(d.getLog()).toBeNull()
  });
});