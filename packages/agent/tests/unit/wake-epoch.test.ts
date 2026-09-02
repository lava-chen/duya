import { describe, expect, it } from 'vitest';
import {
  advancesTurnEpoch,
  createTurnEpochState,
} from '../../src/wake/epoch.js';
import type { WakeItem } from '../../src/wake/types.js';

function item(partial: Pick<WakeItem, 'source' | 'lane'> & Partial<WakeItem>): WakeItem {
  const kind =
    partial.source === 'user.message'
      ? ({ kind: 'user', text: 'hi', messageId: 'm1' } as const)
      : partial.source === 'agent.dm'
        ? ({
            kind: 'dm',
            clientMsgId: 'c1',
            fromAgentId: 'b',
            text: 'hi',
            ...(partial.payload?.kind === 'dm' && partial.payload.priority
              ? { priority: true }
              : {}),
          } as const)
        : ({ kind: 'completion', taskId: 't1' } as const)
  return {
    id: 'x',
    source: partial.source,
    lane: partial.lane,
    agentId: 'agent-a',
    enqueuedAtMs: 1_700_000_000_000,
    payload: kind,
  }
}

describe('turn_epoch — advancesTurnEpoch', () => {
  it('user lane always advances', () => {
    expect(advancesTurnEpoch(item({ source: 'user.message', lane: 'user' }))).toBe(true)
  })

  it('priority agent.dm advances', () => {
    const dm = item({ source: 'agent.dm', lane: 'agent' })
    const prio = { ...dm, payload: { ...dm.payload, priority: true } } as WakeItem
    expect(advancesTurnEpoch(prio)).toBe(true)
  })

  it('non-priority agent.dm does NOT advance', () => {
    expect(advancesTurnEpoch(item({ source: 'agent.dm', lane: 'agent' }))).toBe(false)
  })

  it('background lane never advances', () => {
    expect(advancesTurnEpoch(item({ source: 'task.completion', lane: 'background' }))).toBe(false)
    expect(advancesTurnEpoch(item({ source: 'automation.fire', lane: 'background' }))).toBe(false)
    expect(advancesTurnEpoch(item({ source: 'connector.inbound', lane: 'background' }))).toBe(false)
    expect(advancesTurnEpoch(item({ source: 'broadcast', lane: 'background' }))).toBe(false)
  })
})

describe('turn_epoch — state machine', () => {
  it('starts at 0 and advances only for user/priority wakes', () => {
    const state = createTurnEpochState()
    expect(state.current('s1')).toBe(0)

    // Background wake does not advance.
    expect(
      state.maybeAdvanceForItem('s1', item({ source: 'task.completion', lane: 'background' })),
    ).toBeNull()
    expect(state.current('s1')).toBe(0)

    // User message advances to 1.
    expect(
      state.maybeAdvanceForItem('s1', item({ source: 'user.message', lane: 'user' })),
    ).toBe(1)
    expect(state.current('s1')).toBe(1)
  })

  it('per-session epochs are independent', () => {
    const state = createTurnEpochState()
    state.maybeAdvanceForItem('s1', item({ source: 'user.message', lane: 'user' }))
    expect(state.current('s1')).toBe(1)
    expect(state.current('s2')).toBe(0)
  })

  it('isCurrent distinguishes live from superseded epochs', () => {
    const state = createTurnEpochState()
    const epoch1 = state.maybeAdvanceForItem('s1', item({ source: 'user.message', lane: 'user' }))!
    expect(state.isCurrent('s1', epoch1)).toBe(true)
    const epoch2 = state.maybeAdvanceForItem('s1', item({ source: 'user.message', lane: 'user' }))!
    expect(epoch2).toBe(epoch1 + 1)
    // The old turn is now superseded.
    expect(state.isCurrent('s1', epoch1)).toBe(false)
    expect(state.isCurrent('s1', epoch2)).toBe(true)
  })

  it('a stale turn report on a background wake epoch keeps working (isCurrent true at 0)', () => {
    const state = createTurnEpochState()
    // Never advanced → current is 0; a turn stamped 0 is still current.
    expect(state.isCurrent('s1', 0)).toBe(true)
  })

  it('advance() unconditionally bumps the epoch (main-side user-turn signal)', () => {
    const state = createTurnEpochState()
    expect(state.current('s1')).toBe(0)
    expect(state.advance('s1')).toBe(1)
    expect(state.advance('s1')).toBe(2)
    expect(state.current('s1')).toBe(2)
    // Items stamped at older epochs are superseded.
    expect(state.isCurrent('s1', 1)).toBe(false)
    expect(state.isCurrent('s1', 2)).toBe(true)
  })

  it('advance() is independent across sessions', () => {
    const state = createTurnEpochState()
    state.advance('a')
    state.advance('a')
    expect(state.current('a')).toBe(2)
    expect(state.current('b')).toBe(0)
  })
})
