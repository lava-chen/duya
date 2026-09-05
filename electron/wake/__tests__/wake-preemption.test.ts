/**
 * wake-preemption.test.ts — Plan 495 G3 / 476 §2.2 preemption + redrive and
 * the run-tail epoch guard (grok turn-runtime parity).
 *
 * Covers:
 *  - a user wake preempts an in-flight *dispatcher-owned* background run:
 *    interrupt fires, the displaced item re-queues as isRedriven, and the
 *    redriven run happens after the preempting user turn;
 *  - a lock held by someone else (no dispatcher run in flight) is never
 *    interrupted;
 *  - a run whose epoch advanced mid-flight has its user-facing tail
 *    side-effects (DM auto-return) suppressed; a run that stays current
 *    auto-returns normally.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import {
  _resetWakeDispatcherForTest,
  _setWakeDispatcherDeps,
  enqueueWakeItemForSession,
  notifySessionIdle,
  _queuedWakeCount,
  advanceUserTurn,
  currentTurnEpoch,
  type WakeDispatcherDeps,
} from '../wake-dispatcher'
import { maybeAutoReturnDmResult } from '../agent-dm-return'
import type { WakeItem } from '../../../packages/agent/src/wake/types'

vi.mock('../agent-dm-return', () => ({
  maybeAutoReturnDmResult: vi.fn(() => true),
  runUsedSendToAgent: vi.fn(() => false),
}))

/** Microtask flush — drain() is kicked as a fire-and-forget promise. */
const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

function completionItem(taskId: string, sessionId = 's1'): WakeItem {
  return {
    id: `task:${taskId}`,
    source: 'task.completion',
    lane: 'background',
    agentId: sessionId,
    enqueuedAtMs: Date.now(),
    payload: { kind: 'completion', taskId },
  }
}

function userItem(text: string, sessionId = 's1'): WakeItem {
  return {
    id: `user:${text}`,
    source: 'user.message',
    lane: 'user',
    agentId: sessionId,
    enqueuedAtMs: Date.now(),
    payload: { kind: 'user', text },
  }
}

function dmItem(text: string, sessionId = 'bot:receiver'): WakeItem {
  return {
    id: `dm:bot-a:${text}`,
    source: 'agent.dm',
    lane: 'agent',
    agentId: sessionId,
    enqueuedAtMs: Date.now(),
    payload: {
      kind: 'dm',
      clientMsgId: `cmi-${text}`,
      fromAgentId: 'bot-a',
      fromAgentName: 'Alpha',
      text,
    },
  }
}

interface FakeDeps {
  locked: Set<string>
  runCalls: string[]
  interrupts: string[]
  /** Resolvers for hanging runs — keyed by the prompt substring. */
  releasers: Map<string, () => void>
}

function makeDeps(fake: FakeDeps): WakeDispatcherDeps {
  return {
    isLocked: (sessionId) => fake.locked.has(sessionId),
    runWake: async (_sessionId, prompt) => {
      fake.runCalls.push(prompt)
      for (const [marker, resolve] of fake.releasers) {
        if (prompt.includes(marker)) {
          fake.releasers.delete(marker)
          // Hang until released; the releaser removes itself so the
          // redriven re-run of the same prompt does not hang again.
          await new Promise<void>((r) => {
            fake.releasers.set(marker, () => {
              fake.releasers.delete(marker)
              resolve()
              r()
            })
          })
          break
        }
      }
      return { output: 'run reply', events: [] }
    },
    interruptRun: (sessionId) => fake.interrupts.push(sessionId),
  }
}

describe('wake-dispatcher preemption / redrive / tail guard (Plan 495 G3)', () => {
  let fake: FakeDeps

  beforeEach(() => {
    _resetWakeDispatcherForTest()
    vi.mocked(maybeAutoReturnDmResult).mockClear()
    fake = {
      locked: new Set(),
      runCalls: [],
      interrupts: [],
      releasers: new Map(),
    }
    _setWakeDispatcherDeps(makeDeps(fake))
  })

  it('preempts a running background wake for a user message and redrives it', async () => {
    // The bg-1 run hangs until the test releases it.
    fake.releasers.set('bg-1', () => {})
    enqueueWakeItemForSession('s1', completionItem('bg-1'))
    await flush()
    expect(fake.runCalls).toHaveLength(1)
    // The in-flight wake run holds the session lock (real flow: lock:acquire).
    fake.locked.add('s1')

    // User message arrives while the background run is in flight.
    enqueueWakeItemForSession('s1', userItem('what is the status?'))
    await flush()
    // The dispatcher interrupted the displaced run and parked the queue.
    expect(fake.interrupts).toEqual(['s1'])
    expect(fake.runCalls).toHaveLength(1)
    expect(_queuedWakeCount('s1')).toBe(1)
    // A preempting user wake starts a new epoch (476 §2.6).
    expect(currentTurnEpoch('s1')).toBe(1)

    // The interrupted run returns → the displaced item re-queues (redrive).
    for (const release of [...fake.releasers.values()]) release()
    await flush()
    expect(_queuedWakeCount('s1')).toBe(2) // user item + redriven background item

    // Unlock → the preempting user turn dispatches first (lane order), the
    // redriven background run follows it instead of being lost.
    fake.locked.delete('s1')
    notifySessionIdle('s1')
    await flush()
    expect(fake.runCalls).toHaveLength(3)
    expect(fake.runCalls[1]).toContain('what is the status?')
    expect(fake.runCalls[2]).toContain('bg-1')
    expect(_queuedWakeCount('s1')).toBe(0)
  })

  it('never interrupts a lock held outside the dispatcher', async () => {
    fake.locked.add('s1') // foreign lock: no dispatcher run in flight
    enqueueWakeItemForSession('s1', userItem('queued behind foreign run'))
    await flush()
    expect(fake.interrupts).toEqual([])
    expect(fake.runCalls).toHaveLength(0)
    expect(_queuedWakeCount('s1')).toBe(1)
  })

  it('suppresses DM auto-return when the epoch advances mid-run', async () => {
    // The DM run hangs so the epoch can advance while it is in flight.
    fake.releasers.set('please audit', () => {})
    enqueueWakeItemForSession('bot:receiver', dmItem('please audit the logs'))
    await flush()
    expect(fake.runCalls).toHaveLength(1)
    // A user turn starts while the DM run is still in flight.
    advanceUserTurn('bot:receiver')
    for (const release of [...fake.releasers.values()]) release()
    await flush()
    expect(maybeAutoReturnDmResult).not.toHaveBeenCalled()
    expect(_queuedWakeCount('bot:receiver')).toBe(0)
  })

  it('auto-returns a DM run that stayed current', async () => {
    enqueueWakeItemForSession('bot:receiver', dmItem('please audit the logs'))
    await flush()
    expect(fake.runCalls).toHaveLength(1)
    expect(maybeAutoReturnDmResult).toHaveBeenCalledTimes(1)
    expect(vi.mocked(maybeAutoReturnDmResult).mock.calls[0][1]).toBe('run reply')
  })
})
