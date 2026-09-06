/**
 * wake-rearm.ts — restart recovery for pending wakes (Plan 476 Phase 3.2).
 *
 * Called once on app startup after the database is open and the wake
 * dispatcher is initialised. Re-arms any wake markers that survived a host
 * restart so that background work which finished while the app was down is
 * not silently dropped.
 *
 * Steps (aligned with 476 §2.4 "重启 rearm"):
 *  1. pruneStale  — remove rows older than 48 h (host was down / work died).
 *  2. re-enqueue  — for every remaining row, hand a WakeItem to the
 *     dispatcher. The dispatcher's own pending_wakes dedupe prevents a
 *     double-dispatch if the row somehow survived consumption.
 *  3. (Cron/long-task re-watch is handled by the cron subsystem's own
 *     startup logic; pending_wakes rearm only covers the wake bus.)
 */

import { getCoreStores } from '../db/core-connection'
import { enqueueWakeItemForSession } from './wake-dispatcher'
import type { WakeItem } from '../../packages/agent/src/wake/types'
import { getLogger, LogComponent } from '../logging/logger'

/**
 * Re-arm all surviving pending wakes after a restart.
 * Idempotent — safe to call more than once.
 */
export async function rearmPendingWakes(): Promise<void> {
  const logger = getLogger()
  const { wakes } = getCoreStores()

  // Step 1: prune stale entries (48 h horizon).
  const pruned = wakes.pruneStale()
  if (pruned > 0) {
    logger.info(`Pending wakes rearm: pruned ${pruned} stale rows`, undefined, LogComponent.Automation)
  }

  // Step 2: re-enqueue surviving rows.
  const rows = wakes.listAll()
  if (rows.length === 0) {
    logger.debug('Pending wakes rearm: no surviving rows', undefined, LogComponent.Automation)
    return
  }

  logger.info(`Pending wakes rearm: re-enqueuing ${rows.length} rows`, undefined, LogComponent.Automation)

  for (const row of rows) {
    try {
      const item = pendingWakeRowToWakeItem(row)
      if (!item) {
        logger.debug('Pending wakes rearm: unsupported kind, skipping', {
          kind: row.kind,
          workId: row.workId,
        }, LogComponent.Automation)
        continue
      }

      const outcome = enqueueWakeItemForSession(row.agent_id, item)
      logger.debug('Pending wakes rearm: re-enqueued', {
        kind: row.kind,
        workId: row.workId,
        agentId: row.agent_id,
        outcome,
      }, LogComponent.Automation)
    } catch (err) {
      logger.warn('Pending wakes rearm: failed to re-enqueue row', {
        kind: row.kind,
        workId: row.workId,
        agentId: row.agent_id,
        error: err instanceof Error ? err.message : String(err),
      }, LogComponent.Automation)
    }
  }
}

/**
 * Convert a pending_wakes DB row back to a WakeItem so it can be re-queued.
 * Returns null for kinds not yet wired (agent.dm etc.).
 */
function pendingWakeRowToWakeItem(row: ReturnType<typeof getCoreStores>['wakes']['listAll'][number]): WakeItem | null {
  const now = Date.now()

  switch (row.kind) {
    case 'task.completion':
      return {
        id: `task:${row.work_id}`,
        source: 'task.completion',
        lane: row.lane as WakeItem['lane'],
        agentId: row.agent_id,
        enqueuedAtMs: now,
        turnEpoch: undefined,
        quietOrigin: row.quiet_origin_json ? JSON.parse(row.quiet_origin_json) : undefined,
        payload: { kind: 'completion', taskId: row.work_id, title: row.title ?? undefined },
      }

    case 'automation.fire':
      // automation fire rows store jobKey as work_id; fireKey is not recoverable
      // from the row alone. For now, re-enqueue with the jobKey as the id.
      // The dispatcher will dedupe by auto:<jobKey>:<fireKey> but fireKey is
      // absent — this means repeated fires of the same job within the dedupe
      // window will collapse. Acceptable for restart-recovery use case.
      return {
        id: `auto:${row.work_id}:?`,
        source: 'automation.fire',
        lane: row.lane as WakeItem['lane'],
        agentId: row.agent_id,
        enqueuedAtMs: now,
        quietOrigin: row.quiet_origin_json ? JSON.parse(row.quiet_origin_json) : undefined,
        payload: {
          kind: 'automation',
          jobKey: row.work_id,
          fireKey: 'rearm',
          name: row.title ?? undefined,
          // Restart-rearm replays are always scheduled fires; manual/event
          // fires are transient and never persisted as pending wakes.
          trigger: 'schedule',
        },
      }

    case 'connector.inbound':
      return {
        id: `inbound:${row.work_id}`,
        source: 'connector.inbound',
        lane: row.lane as WakeItem['lane'],
        agentId: row.agent_id,
        enqueuedAtMs: now,
        payload: { kind: 'inbound', envelopeId: row.work_id },
      }

    case 'broadcast':
      // title stores the broadcast text for re-arm purposes
      return {
        id: `broadcast:${row.work_id}`,
        source: 'broadcast',
        lane: row.lane as WakeItem['lane'],
        agentId: row.agent_id,
        enqueuedAtMs: now,
        payload: { kind: 'broadcast', broadcastId: row.work_id, text: row.title ?? '' },
      }

    case 'user.message':
      // Plan 500 P5.2: a queued user turn that never got dispatched before
      // the restart. Re-enters the user lane; the drain offers it to the
      // renderer (claim) or runs the hidden fallback.
      return {
        id: `user:${row.work_id}`,
        source: 'user.message',
        lane: 'user',
        agentId: row.agent_id,
        enqueuedAtMs: now,
        payload: { kind: 'user', text: row.title ?? '', messageId: row.work_id },
      }

    case 'agent.dm': {
      // Plan 500 P5.2: a parked bot→bot DM. The envelope metadata rides in
      // quiet_origin_json (persisted at enqueue); the text is in title.
      let envelope: {
        fromAgentId?: string
        fromAgentName?: string
        intent?: string
        priority?: boolean
        hops?: number
      } = {}
      try {
        const parsed = row.quiet_origin_json ? JSON.parse(row.quiet_origin_json) : {}
        if (parsed && typeof parsed === 'object' && parsed.dm) envelope = parsed.dm
      } catch {
        // Malformed JSON → empty envelope; fromAgentId empty → prompt skipped.
      }
      if (!envelope.fromAgentId) {
        getLogger().debug('Pending wakes rearm: agent.dm row missing sender; skipping', {
          workId: row.work_id,
          agentId: row.agent_id,
        }, LogComponent.Automation)
        return null
      }
      return {
        id: `dm:${row.work_id}`,
        source: 'agent.dm',
        lane: 'agent',
        agentId: row.agent_id,
        enqueuedAtMs: now,
        payload: {
          kind: 'dm',
          clientMsgId: row.work_id,
          fromAgentId: envelope.fromAgentId,
          ...(envelope.fromAgentName ? { fromAgentName: envelope.fromAgentName } : {}),
          text: row.title ?? '',
          ...(envelope.priority ? { priority: true } : {}),
          ...(envelope.intent ? { intent: envelope.intent } : {}),
          ...(envelope.hops != null ? { hops: envelope.hops } : {}),
        },
      }
    }

    default:
      return null
  }
}
