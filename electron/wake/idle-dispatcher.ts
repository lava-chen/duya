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
 * Plan 571 (dual-channel guard): under `wake.idleDispatch='main'` the row
 * may already have been claimed by the in-run checkpoint claimer (plan 569
 * final poll / next checkpoint). Claim atomicity guarantees only one side
 * wins the row, so before enqueueing we check the row's live status:
 *  - `pending`            → enqueue as before (fast wake);
 *  - `observed`           → stand down now and register a one-shot delayed
 *                           recheck: if the row is applied/cancelled by then
 *                           the run absorbed it (no wake); if it is still
 *                           observed with an expired lease it is an orphan
 *                           (claiming run crashed) and we enqueue as the
 *                           fallback deliverer;
 *  - `applied/cancelled`  → do not enqueue.
 * Missing rows (not found) fail open toward delivery — the queue's own
 * dedupe window still guards against double wakes.
 *
 * Busy/dedupe/serialisation live in wake-dispatcher, not here.
 */

import type { WakeItem } from '../../packages/agent/src/wake/types'
import { enqueueWakeItemForSession } from './wake-dispatcher'
import { getConfigStore } from '../config/store-instance'
import { getCoreStoresOrNull } from '../db/core-connection'

export const IDLE_DISPATCH_PATH = 'wake.idleDispatch'
export type IdleDispatchMode = 'renderer' | 'main'

export interface MailboxCreatedRow {
  id: string
  sessionId: string
  kind?: string
  content?: string
  clientMsgId?: string | null
}

/** Live status snapshot of a mailbox row (Plan 571 dual-channel guard). */
export interface MailboxRowStatusInfo {
  status: 'pending' | 'observed' | 'applied' | 'cancelled'
  /** True when the row is observed and its claim lease has already expired. */
  leaseExpired: boolean
}

interface IdleDispatcherDeps {
  /** Read the live status of a mailbox row. Defaults to the core store. */
  getRowStatus?: (rowId: string) => MailboxRowStatusInfo | null
  /** Delay before the orphan recheck fires. Defaults to 10s. */
  orphanRecheckDelayMs?: number
  /** Test seam: control the recheck timer (defaults to setTimeout). */
  scheduleTimer?: (fn: () => void, ms: number) => unknown
}

let activeDeps: IdleDispatcherDeps | null = null

/**
 * Plan 571 test/edge seam. Passing `null` resets to the default deps
 * (core-store-backed row reads + 10s one-shot recheck timer).
 */
export function _setIdleDispatcherDeps(deps: IdleDispatcherDeps | null): void {
  activeDeps = deps
}

function currentDeps(): IdleDispatcherDeps {
  if (!activeDeps) {
    activeDeps = {
      getRowStatus(rowId) {
        try {
          const mailbox = getCoreStoresOrNull()?.mailbox
          if (!mailbox) return null
          const row = mailbox.get(rowId)
          if (!row) return null
          return {
            status: row.status,
            leaseExpired:
              row.claimExpiresAt != null && row.claimExpiresAt < Date.now(),
          }
        } catch {
          return null
        }
      },
      scheduleTimer: (fn, ms) => setTimeout(fn, ms),
    }
  }
  return activeDeps
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

/** One-shot delayed recheck for an observed row (Plan 571 orphan fallback). */
function scheduleOrphanRecheck(row: MailboxCreatedRow): void {
  const deps = currentDeps()
  const delay = deps.orphanRecheckDelayMs ?? 10_000
  deps.scheduleTimer?.(() => {
    try {
      const info = currentDeps().getRowStatus?.(row.id) ?? null
      if (!info) return
      // Applied/cancelled → the claiming run (or the user) finalised the
      // row: nothing to do. Still observed WITH a live lease → a run is
      // actively holding it, the next checkpoint will finish it. Only an
      // expired-lease orphan (claiming run crashed) falls back to a wake.
      if (info.status === 'observed' && info.leaseExpired) {
        enqueueCompletionWake(row)
      }
    } catch {
      // Best-effort convergence: the next notification or user input will
      // retrigger delivery anyway. Never loop retries here.
    }
  }, delay)
}

function enqueueCompletionWake(row: MailboxCreatedRow): boolean {
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

/**
 * Handle a freshly created mailbox row. Returns true when the wake was
 * queued or suppressed by dedupe, false when the row is not a background
 * notification, the mode is 'renderer', or the row was already claimed by a
 * run (Plan 571: stand down + delayed orphan recheck instead of dual
 * delivery).
 */
export async function maybeDispatchIdleWake(
  row: MailboxCreatedRow,
  mode: IdleDispatchMode = readIdleDispatchMode(),
): Promise<boolean> {
  if (row.kind !== 'background_notification') return false
  if (!row.sessionId) return false
  if (mode !== 'main') return false

  // Plan 571 dual-channel guard: check the live row status before
  // enqueueing. A row the in-run claimer already holds (observed) or has
  // finalised (applied/cancelled) must not produce a second, lossy wake run.
  const info = currentDeps().getRowStatus?.(row.id) ?? null
  if (info) {
    if (info.status === 'applied' || info.status === 'cancelled') return false
    if (info.status === 'observed') {
      scheduleOrphanRecheck(row)
      return false
    }
    // 'pending' → enqueue below. A null read (row missing / store down)
    // fails open toward delivery; the queue's dedupe window still protects
    // against double wakes for the same taskId.
  }

  return enqueueCompletionWake(row)
}
