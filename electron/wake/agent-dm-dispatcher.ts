/**
 * agent-dm-dispatcher.ts — agent_dm mailbox → wake queue adapter (477 P3.1).
 *
 * A bot→bot DM is written by the sender's `SendToAgent` tool as a
 * `kind='agent_dm'` `mailbox_items` row whose `session_id` is the target bot's
 * persistent session id (`bot:<agentId>`, see `bot-session-id.ts`). This thin
 * adapter is the main-process consumer:
 *
 *   1. ignores anything that is not an `agent_dm` row;
 *   2. idempotently creates the target bot's persistent session
 *      (`extensions.source='bot'`, `agent_profile_id=<agentId>`) if missing —
 *      same get-or-create shape as `createCronSessionRow`;
 *   3. builds the WakeItem (`agent.dm`, agent lane) and hands it to the
 *      per-session queue in `wake-dispatcher.ts`, which serialises runs,
 *      parks them while the session is busy and drains on `lock:release`.
 *
 * Busy/dedupe/serialisation live in wake-dispatcher, not here. A missing LLM
 * provider never throws out of here: the mailbox row is durable, the session
 * row is created best-effort, and the wake simply fires later once the
 * provider / bind is configured.
 *
 * Mirrors `idle-dispatcher.ts`'s dependency style so it stays unit-testable.
 */

import { getCoreStores } from '../db/core-connection'
import type { WakeItem } from '../../packages/agent/src/wake/types'
import { enqueueWakeItemForSession } from './wake-dispatcher'
import { decodeEnvelope } from '../../packages/agent/src/agent/dm/index.js'
import { parseAgentIdFromBotSession } from './bot-session-id'
import { getLogger, LogComponent } from '../logging/logger'

export interface AgentDmRowLike {
  id: string
  sessionId: string
  kind?: string
  content?: string
  clientMsgId?: string | null
}

export interface BotSessionSpec {
  /** Idempotently ensure the target bot's persistent session row exists. */
  createIfMissing(sessionId: string, agentId: string): void
}

/**
 * Default bot session creation: get-or-create via the core session store.
 * Injected separately so tests can back it with an in-memory core DB.
 */
export const defaultBotSessionCreator: BotSessionSpec = {
  createIfMissing(sessionId, agentId) {
    const { sessions } = getCoreStores()
    if (sessions.get(sessionId)) return
    sessions.create({
      id: sessionId,
      // The LLM provider/model for a wake run is resolved at request time by
      // wake-run.ts (same as cron); the row only needs the bot identity.
      title: agentId,
      status: 'active',
      mode: 'chat',
      permissionMode: 'auto',
      agentType: 'bot',
      agentName: agentId,
      agentProfileId: agentId,
      extensions: { source: 'bot' },
    })
  },
}

/** Test seam — same pattern as wake-dispatcher's `_setWakeDispatcherDeps`. */
let botSessionCreator: BotSessionSpec = defaultBotSessionCreator
export function _setBotSessionCreatorForTest(spec: BotSessionSpec): void {
  botSessionCreator = spec
}

/**
 * Handle a freshly created agent_dm mailbox row. Returns true when the DM was
 * enqueued (or suppressed by dedupe), false when it is not an agent_dm row or
 * the target session could not be resolved.
 */
export function maybeDispatchAgentDm(row: AgentDmRowLike): boolean {
  if (row.kind !== 'agent_dm') return false
  if (!row.sessionId) return false

  // Target bot's persistent session id is carried verbatim in the row.
  const sessionId = row.sessionId

  // Try to keep the session alive so a later wake has a target (best-effort).
  try {
    botSessionCreator.createIfMissing(sessionId, parseAgentIdFromBotSession(sessionId) ?? sessionId)
  } catch (err) {
    getLogger().warn('AgentDm: failed to ensure bot session', {
      sessionId,
      error: err instanceof Error ? err.message : String(err),
    }, LogComponent.AgentProcess)
  }

  const envelope = row.content ? decodeEnvelope(row.content) : null
  if (!envelope) {
    getLogger().warn('AgentDm: unparseable envelope', { sessionId }, LogComponent.AgentProcess)
    return false
  }

  const clientMsgId = row.clientMsgId ?? envelope.clientMsgId ?? row.id
  const item: WakeItem = {
    id: `dm:${clientMsgId}`,
    source: 'agent.dm',
    lane: 'agent',
    agentId: sessionId,
    enqueuedAtMs: Date.now(),
    payload: {
      kind: 'dm',
      clientMsgId,
      fromAgentId: envelope.from.id,
      fromAgentName: envelope.from.name,
      text: envelope.text,
      ...(envelope.priority ? { priority: true } : {}),
    },
  }

  const outcome = enqueueWakeItemForSession(sessionId, item)
  // 'deduped' means the same DM already ran within the window — treat as handled.
  return outcome !== 'deduped'
}