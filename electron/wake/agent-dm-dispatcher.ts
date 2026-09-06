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
import type { NewEvent } from '../db/core'
import { ipcMessageToNewEvent, newEventToIpcMessage } from '../ipc/core-db-adapters'
import { getSessionManager } from '../agents/session-manager'

export interface AgentDmRowLike {
  id: string
  sessionId: string
  kind?: string
  content?: string
  clientMsgId?: string | null
  /** Sender identity carried by the mailbox row (P4.2 hop-chain lookup). */
  source?: string | null
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
    createBotSessionIfMissing(sessionId, agentId)
  },
}

/**
 * P2.3b — idempotently ensure the bot's persistent session row
 * (`bot:<agentId>`) exists. Shared by the DM dispatch path and the
 * automation Scheduler's routine fires (both POST hidden turns to that
 * session via the wake bus).
 */
export function createBotSessionIfMissing(sessionId: string, agentId: string): void {
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
}

/** Test seam — same pattern as wake-dispatcher's `_setWakeDispatcherDeps`. */
let botSessionCreator: BotSessionSpec = defaultBotSessionCreator
export function _setBotSessionCreatorForTest(spec: BotSessionSpec): void {
  botSessionCreator = spec
}

/**
 * Persist the receiver-side agent_dm marker row (plan 477 P4.4) so the
 * target bot's direct chat shows a "from peer" card — and so the wake
 * prompt's visibility claim is true. Mirrors the sender-side marker in
 * SendToAgentTool. Best-effort: marker failures never block the wake.
 */
function appendReceiverMarker(
  sessionId: string,
  envelope: ReturnType<typeof decodeEnvelope> & { clientMsgId: string },
  hops: number,
): void {
  if (!envelope) return
  try {
    // Plan 497 fix: the envelope's from.id is the SENDER'S PERSISTENT SESSION
    // id (`bot:<agentId>`), but every UI consumer keys peers by the bare
    // roster agent id (contact lookup, pair-view session derivation — a
    // prefixed peerId rendered the wrong name and opened an empty pair view).
    // Normalize here, and prefer the display name from the sender's session
    // row (envelope.from.name is the worker's id-derived fallback).
    const fromAgentId =
      parseAgentIdFromBotSession(envelope.from.id) ?? envelope.from.id
    let fromName = envelope.from.name || fromAgentId
    try {
      const senderSession = getCoreStores().sessions.get(envelope.from.id)
      if (senderSession?.agentName) fromName = senderSession.agentName
    } catch {
      // Core stores unavailable (tests) — the envelope name is fine.
    }
    const message = {
      id: `dm-marker-${envelope.clientMsgId}`,
      session_id: sessionId,
      role: 'user',
      content: `${fromName}: ${envelope.text}`,
      status: 'complete',
      msg_type: 'text',
      source: 'agent_dm',
      metadata: {
        source: 'agent_dm',
        agentDm: {
          direction: 'received',
          peerId: fromAgentId,
          peerName: fromName,
          text: envelope.text,
          intent: envelope.intent ?? null,
          priority: envelope.priority ?? false,
          hops,
          clientMsgId: envelope.clientMsgId,
        },
      },
      created_at: Date.now(),
    }
    const { messageLog } = getCoreStores()
    const event: NewEvent = ipcMessageToNewEvent(
      sessionId,
      message as unknown as Parameters<typeof ipcMessageToNewEvent>[1],
      null,
    )
    messageLog.appendBatch([event])
    const broadcast = newEventToIpcMessage(event)
    if (broadcast) {
      getSessionManager().broadcastSessionEvent('message:new', {
        sessionId,
        messages: [broadcast],
      })
    }
  } catch (err) {
    getLogger().warn('AgentDm: receiver marker append failed (non-fatal)', {
      sessionId,
      error: err instanceof Error ? err.message : String(err),
    }, LogComponent.AgentProcess)
  }
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

  // Plan 477 P4.2 — compute the hop depth. A reply (replyTo present) adds one
  // hop over the message it answers, looked up in the SENDER's mailbox (the
  // inbound row lives in the replier's mailbox, which is this row's source
  // session). Messages without a replyTo start at 0 (human-initiated
  // context). Computed here — not by the sending model — so the value cannot
  // be forged downward, and attached to the wake payload for observability.
  // No message is DROPPED on hop depth: a multi-round bot↔bot exchange is the
  // intended shape, and runaway ping-pong is bounded by the model's own
  // "nothing to add → stay silent" judgment (matching grok-bot), not by a hop
  // counter that a fresh topic can reset.
  let hops = 0
  if (envelope.replyTo?.messageId) {
    try {
      const inbound = getCoreStores().mailbox.getByClientMsgId(
        row.source || envelope.from.id,
        envelope.replyTo.messageId,
      )
      if (inbound) {
        const inboundEnvelope = inbound.content ? decodeEnvelope(inbound.content) : null
        hops = (inboundEnvelope?.hops ?? 0) + 1
      }
    } catch (err) {
      getLogger().warn('AgentDm: hop lookup failed; treating as hop 0', {
        sessionId,
        clientMsgId,
        error: err instanceof Error ? err.message : String(err),
      }, LogComponent.AgentProcess)
    }
  }

  // Plan 477 P4.4 — receiver-side marker row (before the wake so the card is
  // already in the transcript when the hidden run starts).
  appendReceiverMarker(sessionId, envelope, hops)

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
      ...(envelope.intent ? { intent: envelope.intent } : {}),
      ...(hops > 0 ? { hops } : {}),
    },
  }

  const outcome = enqueueWakeItemForSession(sessionId, item)
  // 'deduped' means the same DM already ran within the window — treat as handled.
  return outcome !== 'deduped'
}