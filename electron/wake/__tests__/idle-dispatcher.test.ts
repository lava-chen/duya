/**
 * idle-dispatcher.test.ts — Plan 476 mailbox → wake queue adapter.
 * Phase 2.1: maybeDispatchIdleWake converts a background_notification row
 * into a task.completion WakeItem and enqueues it (dispatch semantics live
 * in wake-dispatcher's own suite). Here we cover the gate (kind/sessionId/
 * mode) and the summary builder.
 */
import { describe, it, expect, beforeEach } from 'vitest'
import {
  _resetWakeDispatcherForTest,
  _setWakeDispatcherDeps,
  _queuedWakeCount,
  notifySessionIdle,
} from '../wake-dispatcher'
import {
  buildNotificationSummary,
  maybeDispatchIdleWake,
  type MailboxCreatedRow,
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
