/**
 * idle-dispatcher.test.ts — Plan 476 mailbox → wake queue adapter.
 * Phase 2.1: maybeDispatchIdleWake converts a background_notification row
 * into a task.completion WakeItem and enqueues it (dispatch semantics live
 * in wake-dispatcher's own suite). Here we cover the gate (kind/sessionId/
 * mode) and the summary builder, plus the Plan 571 dual-channel guard
 * (pending → enqueue; observed → stand down + orphan recheck;
 * applied/cancelled → drop).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import {
  _resetWakeDispatcherForTest,
  _setWakeDispatcherDeps,
  _queuedWakeCount,
  notifySessionIdle,
} from '../wake-dispatcher'
import {
  _setIdleDispatcherDeps,
  buildNotificationSummary,
  maybeDispatchIdleWake,
  type MailboxCreatedRow,
  type MailboxRowStatusInfo,
} from '../idle-dispatcher'

function row(partial: Partial<MailboxCreatedRow> = {}): MailboxCreatedRow {
  return {
    id: 'mail-1',
    sessionId: 's1',
    kind: 'background_notification',
    content: undefined,
    clientMsgId: 'task-9',
    ...partial,
  }
}

const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

describe('buildNotificationSummary', () => {
  it('strips XML tags and collapses whitespace', () => {
    const summary = buildNotificationSummary(
      '<task-notification><title>Done</title><detail>Freed  3 GB</detail></task-notification>',
    )
    expect(summary).toContain('Done')
    expect(summary).toContain('Freed 3 GB')
    expect(summary).not.toContain('<')
    expect(summary).not.toContain('>')
  })

  it('returns empty for empty content', () => {
    expect(buildNotificationSummary('')).toBe('')
    expect(buildNotificationSummary(undefined)).toBe('')
  })

  it('clamps very long content to 800 chars', () => {
    const summary = buildNotificationSummary('x'.repeat(2000))
    expect(summary.length).toBe(800)
  })
})

describe('maybeDispatchIdleWake (queue adapter gates)', () => {
  let unlockSession: () => void = () => {}
  let lockSession: () => void = () => {}

  beforeEach(() => {
    _resetWakeDispatcherForTest()
    let locked = true // queue adapter tests observe the parked queue; each
    // test unlocks explicitly when it wants the drain to run.
    lockSession = () => { locked = true }
    unlockSession = () => { locked = false }
    _setWakeDispatcherDeps({
      isLocked: () => locked,
      runWake: async () => {},
    })
  })

  afterEach(() => {
    _resetWakeDispatcherForTest()
  })

  it('ignores non-background_notification kinds', async () => {
    const result = await maybeDispatchIdleWake(row({ kind: 'user_message' }))
    expect(result).toBe(false)
    expect(_queuedWakeCount('s1')).toBe(0)
  })

  it('ignores rows without a sessionId', async () => {
    const result = await maybeDispatchIdleWake(row({ sessionId: '' }))
    expect(result).toBe(false)
    expect(_queuedWakeCount('s1')).toBe(0)
  })

  it('stays silent when mode is renderer (default)', async () => {
    const result = await maybeDispatchIdleWake(row(), 'renderer')
    expect(result).toBe(false)
    expect(_queuedWakeCount('s1')).toBe(0)
  })

  it('enqueues a completion wake when mode is main', async () => {
    const result = await maybeDispatchIdleWake(
      row({ clientMsgId: 'task-9', content: '<task-notification><title>Built</title></task-notification>' }),
      'main',
    )
    expect(result).toBe(true)
    expect(_queuedWakeCount('s1')).toBe(1)

    // Release the session → drain runs and the queue empties.
    unlockSession()
    notifySessionIdle('s1')
    await flush()
    expect(_queuedWakeCount('s1')).toBe(0)
  })

  it('falls back to row.id as taskId when clientMsgId is missing', async () => {
    const result = await maybeDispatchIdleWake(row({ clientMsgId: null }), 'main')
    expect(result).toBe(true)
    expect(_queuedWakeCount('s1')).toBe(1)
  })

  it('merges a re-notification for a taskId that is still queued (returns true)', async () => {
    // Warm the queue with the same taskId directly (session parked).
    const { enqueueWakeItemForSession } = await import('../wake-dispatcher')
    const outcome = enqueueWakeItemForSession('s1', {
      id: 'task:task-9',
      source: 'task.completion',
      lane: 'background',
      agentId: 's1',
      enqueuedAtMs: Date.now(),
      payload: { kind: 'completion', taskId: 'task-9' },
    })
    expect(outcome).toBe('added')
    expect(_queuedWakeCount('s1')).toBe(1)

    // Same task arrives through the adapter → merged into the parked item.
    const result = await maybeDispatchIdleWake(row({ clientMsgId: 'task-9' }), 'main')
    expect(result).toBe(true)
    expect(_queuedWakeCount('s1')).toBe(1)
  })
})

describe('maybeDispatchIdleWake (Plan 571 dual-channel guard)', () => {
  let unlockSession: () => void = () => {}
  let timers: Array<{ fn: () => void; ms: number }> = []

  beforeEach(() => {
    _resetWakeDispatcherForTest()
    timers = []
    let locked = true
    unlockSession = () => { locked = false }
    _setWakeDispatcherDeps({
      isLocked: () => locked,
      runWake: async () => {},
    })
  })

  afterEach(() => {
    _setIdleDispatcherDeps(null)
    _resetWakeDispatcherForTest()
  })

  /** Inject a controllable row-status reader + manual timer queue. */
  function seedStatus(initial: MailboxRowStatusInfo | null): {
    setStatus: (next: MailboxRowStatusInfo | null) => void
    fireTimers: () => void
  } {
    let current = initial
    _setIdleDispatcherDeps({
      getRowStatus: () => current,
      scheduleTimer: (fn, ms) => {
        timers.push({ fn, ms })
        return timers.length
      },
    })
    return {
      setStatus: (next) => { current = next },
      fireTimers: () => {
        const pending = timers
        timers = []
        for (const t of pending) t.fn()
      },
    }
  }

  it('enqueues when the row is still pending', async () => {
    seedStatus({ status: 'pending', leaseExpired: false })
    const result = await maybeDispatchIdleWake(row(), 'main')
    expect(result).toBe(true)
    expect(_queuedWakeCount('s1')).toBe(1)
  })

  it('fails open toward delivery when the row cannot be read', async () => {
    seedStatus(null)
    const result = await maybeDispatchIdleWake(row(), 'main')
    expect(result).toBe(true)
    expect(_queuedWakeCount('s1')).toBe(1)
  })

  it('does not enqueue an already-applied row', async () => {
    seedStatus({ status: 'applied', leaseExpired: false })
    const result = await maybeDispatchIdleWake(row(), 'main')
    expect(result).toBe(false)
    expect(_queuedWakeCount('s1')).toBe(0)
  })

  it('does not enqueue a cancelled row', async () => {
    seedStatus({ status: 'cancelled', leaseExpired: false })
    const result = await maybeDispatchIdleWake(row(), 'main')
    expect(result).toBe(false)
    expect(_queuedWakeCount('s1')).toBe(0)
  })

  it('stands down on an observed row and registers a recheck (no wake yet)', async () => {
    const control = seedStatus({ status: 'observed', leaseExpired: false })
    const result = await maybeDispatchIdleWake(row(), 'main')
    expect(result).toBe(false)
    expect(_queuedWakeCount('s1')).toBe(0)
    expect(timers).toHaveLength(1)

    // The run absorbs the row before the recheck fires → applied → no wake.
    control.setStatus({ status: 'applied', leaseExpired: false })
    control.fireTimers()
    await flush()
    expect(_queuedWakeCount('s1')).toBe(0)
  })

  it('enqueues an orphan (still observed, lease expired) at the recheck', async () => {
    const control = seedStatus({ status: 'observed', leaseExpired: false })
    const result = await maybeDispatchIdleWake(row(), 'main')
    expect(result).toBe(false)
    expect(timers).toHaveLength(1)

    // Claiming run crashed: lease expired and the row is still observed.
    control.setStatus({ status: 'observed', leaseExpired: true })
    control.fireTimers()
    await flush()
    expect(_queuedWakeCount('s1')).toBe(1)

    unlockSession()
    notifySessionIdle('s1')
    await flush()
    expect(_queuedWakeCount('s1')).toBe(0)
  })

  it('does not wake when the observed row still holds a live lease at the recheck', async () => {
    const control = seedStatus({ status: 'observed', leaseExpired: false })
    await maybeDispatchIdleWake(row(), 'main')
    expect(timers).toHaveLength(1)

    // A run is actively holding the row (fresh lease) → not an orphan.
    control.setStatus({ status: 'observed', leaseExpired: false })
    control.fireTimers()
    await flush()
    expect(_queuedWakeCount('s1')).toBe(0)
  })

  it('recheck timer uses the 10s default delay', async () => {
    seedStatus({ status: 'observed', leaseExpired: false })
    await maybeDispatchIdleWake(row(), 'main')
    expect(timers).toHaveLength(1)
    expect(timers[0].ms).toBe(10_000)
  })
})
