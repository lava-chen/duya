import { describe, expect, it } from 'vitest';
import {
  asRedriven,
  decidePreemption,
  isPreemptingWake,
} from '../../src/wake/preemption.js';
import type { WakeItem } from '../../src/wake/types.js';

function item(partial: Pick<WakeItem, 'source' | 'lane'> & Partial<WakeItem>): WakeItem {
  const base: WakeItem = {
    id: 'x',
    source: partial.source,
    lane: partial.lane,
    agentId: 'agent-a',
    enqueuedAtMs: 1_700_000_000_000,
    payload:
      partial.source === 'user.message'
        ? { kind: 'user', text: 'hi' }
        : partial.source === 'agent.dm'
          ? { kind: 'dm', clientMsgId: 'c1', fromAgentId: 'b', text: 'hi' }
          : { kind: 'completion', taskId: 't1' },
  }
  return { ...base, ...partial }
}

function priorityDm(): WakeItem {
  const dm = item({ source: 'agent.dm', lane: 'agent' })
  return { ...dm, payload: { ...dm.payload, priority: true } } as WakeItem
}

describe('preemption — isPreemptingWake', () => {
  it('user wake preempts', () => {
    expect(isPreemptingWake(item({ source: 'user.message', lane: 'user' }))).toBe(true)
  })

  it('priority DM preempts; plain DM and background do not', () => {
    expect(isPreemptingWake(priorityDm())).toBe(true)
    expect(isPreemptingWake(item({ source: 'agent.dm', lane: 'agent' }))).toBe(false)
    expect(isPreemptingWake(item({ source: 'task.completion', lane: 'background' }))).toBe(false)
    expect(isPreemptingWake(item({ source: 'automation.fire', lane: 'background' }))).toBe(false)
  })
})

describe('preemption — decidePreemption', () => {
  it('idle agent: never preempts, proceeds in order', () => {
    expect(decidePreemption(item({ source: 'user.message', lane: 'user' }), undefined).action)
      .toBe('proceed')
    expect(decidePreemption(item({ source: 'task.completion', lane: 'background' }), undefined).action)
      .toBe('proceed')
  })

  it('user wake preempts a bot-run and asks for redrive', () => {
    const decision = decidePreemption(
      item({ source: 'user.message', lane: 'user' }),
      'bot',
    )
    expect(decision).toEqual({
      action: 'preempt',
      redrive: true,
      reason: 'user_wake',
    })
  })

  it('priority DM preempts an automation-run with reason priority_dm', () => {
    const decision = decidePreemption(priorityDm(), 'automation')
    expect(decision).toEqual({
      action: 'preempt',
      redrive: true,
      reason: 'priority_dm',
    })
  })

  it('background wake never preempts even when a run is active', () => {
    expect(
      decidePreemption(item({ source: 'task.completion', lane: 'background' }), 'bot').action,
    ).toBe('proceed')
    expect(
      decidePreemption(item({ source: 'automation.fire', lane: 'background' }), 'automation').action,
    ).toBe('proceed')
  })

  it('a user-driven run yields only to a user message (Plan 500 P3, grok supersede)', () => {
    // A priority DM still waits behind a user-driven run.
    expect(decidePreemption(priorityDm(), 'user').action).toBe('proceed')
    // A new user message supersedes even a running user turn (grok
    // "superseded by a new user message") — and does NOT redrive it: the
    // user replaced the run on purpose.
    expect(decidePreemption(item({ source: 'user.message', lane: 'user' }), 'user')).toEqual({
      action: 'preempt',
      redrive: false,
      reason: 'user_wake',
    })
  })

  it('preemption carries redrive=false only for displaced user runs', () => {
    expect(decidePreemption(item({ source: 'user.message', lane: 'user' }), 'bot').redrive).toBe(true)
    expect(decidePreemption(item({ source: 'user.message', lane: 'user' }), 'automation').redrive).toBe(true)
    expect(decidePreemption(item({ source: 'user.message', lane: 'user' }), 'user').redrive).toBe(false)
    expect(decidePreemption(priorityDm(), 'bot').redrive).toBe(true)
  })
})

describe('preemption — redrive marker', () => {
  it('asRedriven flips the flag and keeps identity', () => {
    const wake = item({ source: 'task.completion', lane: 'background' })
    const redriven = asRedriven(wake)
    expect(redriven.isRedriven).toBe(true)
    expect(redriven.id).toBe(wake.id)
    expect(redriven.source).toBe(wake.source)
    // Original item untouched (immutability).
    expect(wake.isRedriven).toBeUndefined()
  })
})
