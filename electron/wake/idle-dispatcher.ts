/**
 * idle-dispatcher.ts — mailbox notification → wake queue adapter
 * (Plan 476 Phase 0-B/C/D + Phase 2.1).
 *
 * Phase 0 shipped a single-shot wake: a `background_notification` mailbox
 * row made the main process POST one immediate wake run (only when the
 * session was idle, mode='main'). Phase 2.1 upgrades the delivery: instead
 * of firing directly, this adapter converts the row into a `task.completion`
 * WakeItem and hands it to the authoritative per-session queue in
 * `wake-dispatcher.ts`. The queue serialises runs, parks them while the
 * session is busy (a user turn) and drains on `lock:release`.
 *
 * Responsibilities kept here (thin):
 *  1. ignore anything that is not a `background_notification`;
 *  2. honour the `wake.idleDispatch` switch ('renderer' | 'main', default
 *     'renderer') — main only participates when configured;
 *  3. build a terse, XML-stripped summary into the payload.
 *
 * Busy/dedupe/serialisation live in wake-dispatcher, not here.
 */

import type { WakeItem } from '../../packages/agent/src/wake/types'
import { enqueueWakeItemForSession } from './wake-dispatcher'
import { getConfigStore } from '../config/store-instance'

export const IDLE_DISPATCH_PATH = 'wake.idleDispatch'
export type IdleDispatchMode = 'renderer' | 'main'

export interface MailboxCreatedRow {
  id: string
  sessionId: string
  kind?: string
  content?: string
  clientMsgId?: string | null
}

export function readIdleDispatchMode(): IdleDispatchMode {
  try {
    const value = getConfigStore().getByPath(IDLE_DISPATCH_PATH)
    return value === 'main' ? 'main' : 'renderer'
  } catch {
    return 'renderer'
  }
}

/**
 * Extract a readable summary from the `<task-notification>` XML envelope.
 * Exported separately so tests can cover the parsing without a mailbox row.
 */
export function buildNotificationSummary(content: string | undefined): string {
  const raw = (content ?? '').trim()
  if (!raw) return ''
  // Strip XML tags for a readable summary — the model also sees full
  // envelopes in other contexts; a terse wake keeps this run cheap.
  return raw.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 800)
}

/**
 * Handle a freshly created mailbox row. Returns true when the wake was
 * queued or suppressed by dedupe, false when the row is not a background
 * notification or the mode is 'renderer' (renderer owns idle wakes then).
 */
export async function maybeDispatchIdleWake(
  row: MailboxCreatedRow,
  mode: IdleDispatchMode = readIdleDispatchMode(),
): Promise<boolean> {
  if (row.kind !== 'background_notification') return false
  if (!row.sessionId) return false
  if (mode !== 'main') return false

  const taskId = row.clientMsgId ?? row.id
  const item: WakeItem = {
    id: `task:${taskId}`,
    source: 'task.completion',
    lane: 'background',
    agentId: row.sessionId,
    enqueuedAtMs: Date.now(),
    payload: {
      kind: 'completion',
      taskId,
      summary: buildNotificationSummary(row.content),
    },
  }

  const outcome = enqueueWakeItemForSession(row.sessionId, item)
  // 'deduped' means a wake for this taskId ran within the window — the
  // notification is already handled, so still report success.
  return outcome !== 'deduped'
}
