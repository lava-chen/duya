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
import { enqueueInboundWake, enqueueWakeItemForSession, notifySessionIdle } from './wake-dispatcher'
import { loadPersistedInboundEnvelopes, restoreInboundEnvelopes } from './channels'
import type { WakeItem } from '../../packages/agent/src/wake/types'
import { getLogger, LogComponent } from '../logging/logger'

const logger = getLogger()

/**
 * Re-arm all surviving pending wakes after a restart.
 * Idempotent — safe to call more than once.
 */
export async function rearmPendingWakes(): Promise<void> {
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
      // connector.inbound rows carry the session's undelivered envelopes in
      // quiet_origin_json — restore them into the in-memory envelope store
      // and re-enqueue one wake per platform:chat group. Handled here rather
      // than in pendingWakeRowToWakeItem because one row fans out to N items.
      if (row.kind === 'connector.inbound') {
        rearmConnectorInboundRow(row)
        continue
      }

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
 * Restore a durable connector.inbound row (workId = sessionId). The
 * envelopes are re-seeded into the channel system's in-memory store and one
 * `connector.inbound` wake is re-enqueued per platform:chat group — the
 * dispatcher's dedupe collapses repeats, and the drain's revive replays the
 * full `[inbound]` prompt (grok `wakeForInbound` restart parity).
 */
function rearmConnectorInboundRow(row: ReturnType<typeof getCoreStores>['wakes']['listAll'][number]): void {
  const sessionId = row.work_id
  const envelopes = loadPersistedInboundEnvelopes(row)
  if (envelopes.length === 0) {
    logger.debug('Pending wakes rearm: connector.inbound row has no envelopes; skipping', {
      workId: sessionId,
    }, LogComponent.Automation)
    return
  }

  restoreInboundEnvelopes(sessionId, envelopes)

  const groups = new Map<string, { platform: string; chat: string; text: string }>()
  for (const envelope of envelopes) {
    const key = `${envelope.address.platform}:${envelope.address.chat}`
    if (!groups.has(key)) {
      groups.set(key, { platform: envelope.address.platform, chat: envelope.address.chat, text: envelope.text })
    }
  }
  for (const [key, group] of groups) {
    const envelopeId = `${sessionId}:${group.platform}:${group.chat}`
    const outcome = enqueueInboundWake(sessionId, { envelopeId, text: group.text })
    logger.debug('Pending wakes rearm: re-enqueued connector.inbound', {
      sessionId,
      envelopeId: key,
      outcome,
    }, LogComponent.Automation)
  }
  notifySessionIdle(sessionId)
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

    case 'automation.fire': {
      // Rows persist one fire each: workId is `<jobKey>:<fireKey>` (fireKey
      // is a Scheduler UUID, so the ':' separator is unambiguous) and the
      // fire payload (trigger / event context / quiet) rides
      // quiet_origin_json. Legacy rows without the separator fall back to
      // the old collapse-to-'rearm' behaviour.
      const sep = row.work_id.lastIndexOf(':')
      const jobKey = sep > 0 ? row.work_id.slice(0, sep) : row.work_id
      const fireKey = sep > 0 ? row.work_id.slice(sep + 1) : 'rearm'
      let fire: { trigger?: string; eventSummary?: string; eventContext?: string; quiet?: boolean } = {}
      try {
        const parsed = row.quiet_origin_json ? (JSON.parse(row.quiet_origin_json) as { fire?: typeof fire }) : null
        if (parsed && typeof parsed === 'object' && parsed.fire) fire = parsed.fire
      } catch {
        // Malformed JSON → defaults below.
      }
      return {
        id: `auto:${jobKey}:${fireKey}`,
        source: 'automation.fire',
        lane: row.lane as WakeItem['lane'],
        agentId: row.agent_id,
        enqueuedAtMs: now,
        ...(fire.quiet ? { quietOrigin: { automation: { id: jobKey, name: row.title ?? '' } } } : {}),
        payload: {
          kind: 'automation',
          jobKey,
          fireKey,
          name: row.title ?? undefined,
          // Restore the fire's own trigger so a queued manual/event fire
          // wakes with the right prompt opening; unknown shapes fall back
          // to a scheduled fire.
          trigger: fire.trigger === 'manual' || fire.trigger === 'event' ? fire.trigger : 'schedule',
          ...(fire.quiet ? { quiet: true } : {}),
          ...(fire.eventSummary ? { eventSummary: fire.eventSummary } : {}),
          ...(fire.eventContext ? { eventContext: fire.eventContext } : {}),
        },
      }
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
