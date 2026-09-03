/**
 * wake-dispatcher.test.ts — Plan 476 P2.1 queue + dispatch loop semantics.
 * Covers: enqueue → drain, strict serialisation, busy parking + re-kick on
 * notifySessionIdle, mid-pass pre-emption backoff, queue merge by taskId,
 * recently-dispatched dedupe window, and failure tolerance.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import {
  _resetWakeDispatcherForTest,
  _setWakeDispatcherDeps,
  enqueueWakeItemForSession,
  notifySessionIdle,
  clearSessionWakes,
  removeQueuedWake,
  advanceUserTurn,
  currentTurnEpoch,
  enqueueBroadcastWake,
  enqueueInboundWake,
  _queuedWakeCount,
  type WakeDispatcherDeps,
} from '../wake-dispatcher'
import type { WakeItem } from '../../../packages/agent/src/wake/types'

/** Microtask flush — drain() is kicked as a fire-and-forget promise. */
const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

function completionItem(taskId: string, sessionId = 's1', summary?: string): WakeItem {
  return {
    id: `task:${taskId}`,
    source: 'task.completion',
    lane: 'background',
    agentId: sessionId,
    enqueuedAtMs: Date.now(),
    payload: {
      kind: 'completion',
      taskId,
      ...(summary == null ? {} : { summary }),
    },
  }
}

interface FakeDeps {
  lockedSessions: Set<string>
  runWakeCalls: Array<{ sessionId: string; prompt: string }>
  /** When set, runWake rejects for these taskIds (checked via prompt text). */
  failingTaskIds: Set<string>
  runWakeImpl?: (sessionId: string, prompt: string) => Promise<void>
}

function makeDeps(fake: FakeDeps): WakeDispatcherDeps {
  return {
    isLocked: (sessionId) => fake.lockedSessions.has(sessionId),
    runWake: async (sessionId, prompt) => {
      fake.runWakeCalls.push({ sessionId, prompt })
      if (fake.runWakeImpl) {
        await fake.runWakeImpl(sessionId, prompt)
        return
      }
      const matched = Array.from(fake.failingTaskIds).some((t) => prompt.includes(t))
      if (matched) throw new Error(`run failed for ${prompt}`)
    },
  }
}

describe('wake-dispatcher (P2.1)', () => {
  let fake: FakeDeps

  beforeEach(() => {
    _resetWakeDispatcherForTest()
    fake = { lockedSessions: new Set(), runWakeCalls: [], failingTaskIds: new Set() }
    _setWakeDispatcherDeps(makeDeps(fake))
  })

  it('drains an enqueued completion immediately when idle', async () => {
    enqueueWakeItemForSession('s1', completionItem('t1'))
    await flush()
    expect(fake.runWakeCalls).toHaveLength(1)
    expect(fake.runWakeCalls[0].sessionId).toBe('s1')
    expect(fake.runWakeCalls[0].prompt).toContain('t1')
    expect(_queuedWakeCount('s1')).toBe(0)
  })

  it('embeds the notification summary into the wake prompt', async () => {
    enqueueWakeItemForSession('s1', completionItem('t1', 's1', 'Disk usage audit finished: 3 GB freed'))
    await flush()
    expect(fake.runWakeCalls[0].prompt).toContain('Disk usage audit finished')
    expect(fake.runWakeCalls[0].prompt).toContain('[system]')
  })

  it('serialises: a second item never starts before the first finishes', async () => {
    let releaseFirst: () => void = () => {}
    fake.runWakeImpl = () =>
      new Promise<void>((resolve) => {
        releaseFirst = resolve
      })

    enqueueWakeItemForSession('s1', completionItem('t1'))
    enqueueWakeItemForSession('s1', completionItem('t2'))
    await flush()

    // First run in flight, second must be parked.
    expect(fake.runWakeCalls).toHaveLength(1)
    expect(_queuedWakeCount('s1')).toBe(1)

    releaseFirst()
    await flush()
    expect(fake.runWakeCalls).toHaveLength(2)
    expect(fake.runWakeCalls[1].prompt).toContain('t2')
    expect(_queuedWakeCount('s1')).toBe(0)
  })

  it('parks the queue while the session is busy and drains on notifySessionIdle', async () => {
    fake.lockedSessions.add('s1')

    enqueueWakeItemForSession('s1', completionItem('t1'))
    await flush()
    expect(fake.runWakeCalls).toHaveLength(0)
    expect(_queuedWakeCount('s1')).toBe(1)

    // Run ends (user turn finished) → lock released → re-kick.
    fake.lockedSessions.delete('s1')
    notifySessionIdle('s1')
    await flush()
    expect(fake.runWakeCalls).toHaveLength(1)
    expect(_queuedWakeCount('s1')).toBe(0)
  })

  it('backs off mid-pass when the session becomes busy and resumes after release', async () => {
    let releaseFirst: () => void = () => {}
    fake.runWakeImpl = () =>
      new Promise<void>((resolve) => {
        releaseFirst = resolve
      })

    enqueueWakeItemForSession('s1', completionItem('t1'))
    enqueueWakeItemForSession('s1', completionItem('t2'))
    await flush()
    expect(fake.runWakeCalls).toHaveLength(1)

    // User turn starts while t1's run is still in flight.
    fake.lockedSessions.add('s1')
    releaseFirst()
    await flush()
    // t2 must NOT have run (backed off) and stays queued.
    expect(fake.runWakeCalls).toHaveLength(1)
    expect(_queuedWakeCount('s1')).toBe(1)

    // User turn ends → drain resumes.
    fake.lockedSessions.delete('s1')
    notifySessionIdle('s1')
    await flush()
    expect(fake.runWakeCalls).toHaveLength(2)
    expect(_queuedWakeCount('s1')).toBe(0)
  })

  it('merges a duplicate taskId that is still queued (no double dispatch)', async () => {
    fake.lockedSessions.add('s1')

    const first = enqueueWakeItemForSession('s1', completionItem('t1'))
    const second = enqueueWakeItemForSession('s1', completionItem('t1'))
    expect(first).toBe('added')
    expect(second).toBe('merged')
    expect(_queuedWakeCount('s1')).toBe(1)

    fake.lockedSessions.delete('s1')
    notifySessionIdle('s1')
    await flush()
    expect(fake.runWakeCalls).toHaveLength(1)
  })

  it('dedupes a taskId that was already dispatched within the window', async () => {
    // t1 runs to completion immediately.
    enqueueWakeItemForSession('s1', completionItem('t1'))
    await flush()
    expect(fake.runWakeCalls).toHaveLength(1)

    // A re-notification of the same task arrives → deduped, no second run.
    const outcome = enqueueWakeItemForSession('s1', completionItem('t1'))
    expect(outcome).toBe('deduped')
    await flush()
    expect(fake.runWakeCalls).toHaveLength(1)
  })

  it('does not wedge the queue when a run throws', async () => {
    fake.failingTaskIds.add('t1')
    enqueueWakeItemForSession('s1', completionItem('t1'))
    enqueueWakeItemForSession('s1', completionItem('t2'))
    await flush()
    expect(fake.runWakeCalls).toHaveLength(2)
    expect(_queuedWakeCount('s1')).toBe(0)
  })

  it('clearSessionWakes drops everything for a session', () => {
    fake.lockedSessions.add('s1')
    enqueueWakeItemForSession('s1', completionItem('t1'))
    enqueueWakeItemForSession('s1', completionItem('t2'))
    clearSessionWakes('s1')
    expect(_queuedWakeCount('s1')).toBe(0)
  })

  it('removeQueuedWake removes only matching items', () => {
    fake.lockedSessions.add('s1')
    enqueueWakeItemForSession('s1', completionItem('t1'))
    enqueueWakeItemForSession('s1', completionItem('t2'))
    const removed = removeQueuedWake('s1', (item) => item.payload.kind === 'completion' && item.payload.taskId === 't1')
    expect(removed).toHaveLength(1)
    expect(_queuedWakeCount('s1')).toBe(1)
  })

  // ---- Plan 476 P2.5: turn_epoch supersede semantics ----

  it('skips a parked wake that a newer user turn superseded', async () => {
    fake.lockedSessions.add('s1')
    // Background wake arrives while the session is busy (epoch 0).
    enqueueWakeItemForSession('s1', completionItem('t1'))
    expect(_queuedWakeCount('s1')).toBe(1)

    // A user turn starts (main-side advanceUserTurn on user lock:acquire).
    advanceUserTurn('s1')
    expect(currentTurnEpoch('s1')).toBe(1)

    // Run ends → drain resumes, but t1 is stale (epoch 0 < 1) → skipped.
    fake.lockedSessions.delete('s1')
    notifySessionIdle('s1')
    await flush()
    expect(fake.runWakeCalls).toHaveLength(0)
    expect(_queuedWakeCount('s1')).toBe(0)
  })

  it('runs a wake enqueued after the user turn (epoch matches)', async () => {
    fake.lockedSessions.add('s1')
    advanceUserTurn('s1') // a user turn already happened

    enqueueWakeItemForSession('s1', completionItem('t1'))
    expect(_queuedWakeCount('s1')).toBe(1)

    fake.lockedSessions.delete('s1')
    notifySessionIdle('s1')
    await flush()
    expect(fake.runWakeCalls).toHaveLength(1)
    expect(fake.runWakeCalls[0].prompt).toContain('t1')
  })

  it('stamps items with the epoch at enqueue time', () => {
    fake.lockedSessions.add('s1')
    expect(currentTurnEpoch('s1')).toBe(0)
    enqueueWakeItemForSession('s1', completionItem('t1'))
    // Dispatcher should have stamped turnEpoch = 0 on the queued copy.
    const removed = removeQueuedWake('s1', () => true)
    expect(removed[0].turnEpoch).toBe(0)
  })

  it('advanceUserTurn is monotonic and per-session', () => {
    expect(advanceUserTurn('s1')).toBe(1)
    expect(advanceUserTurn('s1')).toBe(2)
    expect(advanceUserTurn('other')).toBe(1)
    expect(currentTurnEpoch('s1')).toBe(2)
    expect(currentTurnEpoch('other')).toBe(1)
  })
})

describe('wake sources (P2.3c inbound / P2.4 broadcast) + lane ordering (P2.2)', () => {
  let fake: FakeDeps

  beforeEach(() => {
    _resetWakeDispatcherForTest()
    fake = { lockedSessions: new Set(), runWakeCalls: [], failingTaskIds: new Set() }
    _setWakeDispatcherDeps(makeDeps(fake))
  })

  // ---- P2.4 broadcast ----

  it('enqueues one background wake per target session', async () => {
    const outcomes = enqueueBroadcastWake({
      broadcastId: 'b1',
      text: 'Planned maintenance at 02:00.',
      targetSessionIds: ['s1', 's2'],
    })
    expect(outcomes).toHaveLength(2)
    await flush()
    expect(fake.runWakeCalls).toHaveLength(2)
    expect(fake.runWakeCalls.map((c) => c.sessionId).sort()).toEqual(['s1', 's2'])
    expect(fake.runWakeCalls[0].prompt).toContain('Planned maintenance')
    expect(fake.runWakeCalls[0].prompt).toContain('b1')
  })

  it('clamps broadcast text to 8000 chars', () => {
    fake.lockedSessions.add('s1')
    enqueueBroadcastWake({ broadcastId: 'big', text: 'x'.repeat(12_000), targetSessionIds: ['s1'] })
    const removed = removeQueuedWake('s1', () => true)
    expect(removed[0].payload.kind).toBe('broadcast')
    if (removed[0].payload.kind === 'broadcast') {
      expect(removed[0].payload.text.length).toBe(8000)
    }
  })

  it('dedupes a re-sent broadcast to a still-queued session (merge)', () => {
    fake.lockedSessions.add('s1')
    const first = enqueueBroadcastWake({ broadcastId: 'b1', text: 'v1', targetSessionIds: ['s1'] })
    const second = enqueueBroadcastWake({ broadcastId: 'b1', text: 'v2', targetSessionIds: ['s1'] })
    expect(first[0]).toBe('added')
    expect(second[0]).toBe('merged')
    expect(_queuedWakeCount('s1')).toBe(1)
    const removed = removeQueuedWake('s1', () => true)
    if (removed[0].payload.kind === 'broadcast') expect(removed[0].payload.text).toBe('v2')
  })

  // ---- P2.3c connector.inbound (dispatcher layer) ----

  it('enqueues a channel inbound as a background wake', async () => {
    const outcome = enqueueInboundWake('s1', { envelopeId: 'env-9', text: 'hello from telegram' })
    expect(outcome).toBe('added')
    await flush()
    expect(fake.runWakeCalls).toHaveLength(1)
    expect(fake.runWakeCalls[0].sessionId).toBe('s1')
    expect(fake.runWakeCalls[0].prompt).toContain('hello from telegram')
    expect(fake.runWakeCalls[0].prompt).toContain('env-9')
  })

  it('merges duplicate inbound envelopes while queued', async () => {
    fake.lockedSessions.add('s1')
    enqueueInboundWake('s1', { envelopeId: 'env-1', text: 'hi' })
    const second = enqueueInboundWake('s1', { envelopeId: 'env-1', text: 'hi again' })
    expect(second).toBe('merged')
    expect(_queuedWakeCount('s1')).toBe(1)
  })

  // ---- P2.2 lane ordering: user lane outranks background inside one drain ----

  it('drains a parked user wake before a parked background wake (lane order)', async () => {
    fake.lockedSessions.add('s1')
    enqueueWakeItemForSession('s1', completionItem('bg-task')) // arrives first
    enqueueWakeItemForSession('s1', {
      id: 'user:1',
      source: 'user.message',
      lane: 'user',
      agentId: 's1',
      enqueuedAtMs: Date.now(),
      payload: { kind: 'user', text: 'what is the status?' },
    })
    expect(_queuedWakeCount('s1')).toBe(2)

    fake.lockedSessions.delete('s1')
    notifySessionIdle('s1')
    await flush()
    expect(fake.runWakeCalls).toHaveLength(2)
    // Strict lane order: the user item runs first even though it arrived second.
    expect(fake.runWakeCalls[0].prompt).toContain('what is the status?')
    expect(fake.runWakeCalls[1].prompt).toContain('bg-task')
  })

  it('runs two same-lane items in FIFO order', async () => {
    fake.lockedSessions.add('s1')
    enqueueInboundWake('s1', { envelopeId: 'e1', text: 'first' })
    enqueueInboundWake('s1', { envelopeId: 'e2', text: 'second' })
    fake.lockedSessions.delete('s1')
    notifySessionIdle('s1')
    await flush()
    expect(fake.runWakeCalls.map((c) => c.prompt)).toEqual([
      expect.stringContaining('first'),
      expect.stringContaining('second'),
    ])
  })
})
