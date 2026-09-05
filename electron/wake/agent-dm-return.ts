/**
 * agent-dm-return.ts — automatic result return for agent DMs (477 P4.3).
 *
 * When a bot's DM-wake run finishes and the inbound message was a
 * request/question, the run's final written response is automatically sent
 * back to the delegating bot as an `intent='result'` DM threaded via
 * `replyTo` — mirroring rakazo's `returnBotMessageOutcome`. The receiving bot
 * therefore does not need to call SendToAgent just to deliver an outcome.
 *
 * Runs entirely in the main process: it reuses the mailbox store (durable
 * row) + `maybeDispatchAgentDm` (wake enqueue). It deliberately bypasses the
 * agent-side cycle detector / send limiter — a result reply IS a legitimate
 * round trip, and the limiter lives in the sender worker's memory anyway.
 *
 * Duplicate suppression: the wake dispatcher scans the run's SSE events for
 * an explicit `send_to_agent` call and skips the auto-return when the bot
 * already replied itself (same rule as rakazo's "explicit result wins").
 */

import { randomUUID } from 'node:crypto';
import { getCoreStores } from '../db/core-connection';
import { maybeDispatchAgentDm } from './agent-dm-dispatcher';
import { clampAgentMessage, encodeEnvelope, prepareEnvelopeForSend } from '../../packages/agent/src/agent/dm/index.js';
import type { AgentDmEnvelope, AgentDmIntent } from '../../packages/agent/src/agent/dm/index.js';
import { parseAgentIdFromBotSession } from './bot-session-id';
import { getLogger, LogComponent } from '../logging/logger';

/** DM wake payload fields the auto-return needs (subset of WakeItem). */
export interface DmAutoReturnContext {
  /** The woken (receiving) bot's session id — `bot:<agentId>`. */
  sessionId: string;
  /** Inbound message fields, as carried on the wake item payload. */
  clientMsgId: string;
  fromAgentId: string;
  fromAgentName?: string;
  intent?: string;
  hops?: number;
}

/**
 * Intents whose final response is auto-returned. result/status/fyi carry no
 * delegation obligation, so their runs end silently.
 */
const AUTO_RETURN_INTENTS: ReadonlySet<string> = new Set(['request', 'question']);

/** Minimum meaningful run output: the placeholder means "no text was emitted". */
function isRealOutput(output: string): boolean {
  const trimmed = output.trim();
  if (!trimmed) return false;
  if (trimmed.startsWith('completed in ')) return false;
  return true;
}

/**
 * Maybe send the run's final response back to the delegating bot.
 * Returns true when an auto-return DM was written and dispatched.
 */
export function maybeAutoReturnDmResult(
  ctx: DmAutoReturnContext,
  runOutput: string,
): boolean {
  const intent: AgentDmIntent | undefined = (
    ctx.intent as AgentDmIntent | undefined
  );
  if (!intent || !AUTO_RETURN_INTENTS.has(intent)) return false;
  if (!isRealOutput(runOutput)) return false;

  const replierSessionId = ctx.sessionId;
  const replierAgentId = parseAgentIdFromBotSession(replierSessionId) ?? replierSessionId;
  const targetSessionId = ctx.fromAgentId;
  if (!targetSessionId || targetSessionId === replierSessionId) return false;

  // Resolve the replying bot's display name from its session row (best-effort).
  let replierName = replierAgentId;
  try {
    replierName = getCoreStores().sessions.get(replierSessionId)?.agentName ?? replierAgentId;
  } catch {
    // Core stores unavailable (test env) — the id is an acceptable fallback.
  }

  const clientMsgId = randomUUID();
  const envelope: AgentDmEnvelope = {
    from: { id: replierSessionId, name: replierName },
    to: { id: targetSessionId, name: ctx.fromAgentName ?? ctx.fromAgentId },
    text: clampAgentMessage(runOutput.trim()),
    intent: 'result',
    hops: ctx.hops ?? 0,
    timestampMs: Date.now(),
    clientMsgId,
    replyTo: { messageId: ctx.clientMsgId },
  };

  try {
    const prepared = prepareEnvelopeForSend(envelope);
    const row = getCoreStores().mailbox.enqueue({
      id: randomUUID(),
      sessionId: targetSessionId,
      kind: 'agent_dm',
      content: encodeEnvelope(prepared),
      source: replierSessionId,
      clientMsgId,
      submittedRunId: '',
    });
    const dispatched = maybeDispatchAgentDm({
      id: row.id,
      sessionId: row.sessionId,
      kind: row.kind,
      content: row.content,
      clientMsgId: row.clientMsgId,
      source: replierSessionId,
    });
    if (!dispatched) {
      getLogger().warn('AgentDm auto-return: row written but not dispatched', {
        targetSessionId,
        clientMsgId,
      }, LogComponent.AgentProcess);
      return false;
    }
    getLogger().info('AgentDm auto-return sent', {
      replierSessionId,
      targetSessionId,
      inboundClientMsgId: ctx.clientMsgId,
      clientMsgId,
    }, LogComponent.AgentProcess);
    return true;
  } catch (err) {
    getLogger().warn('AgentDm auto-return failed', {
      replierSessionId,
      targetSessionId,
      error: err instanceof Error ? err.message : String(err),
    }, LogComponent.AgentProcess);
    return false;
  }
}

/**
 * Detect an explicit `send_to_agent` tool call in a wake run's SSE events.
 * When the bot already replied itself, the auto-return must be skipped so
 * the delegator does not receive the outcome twice.
 */
export function runUsedSendToAgent(events: ReadonlyArray<{ type: string; data?: unknown }>): boolean {
  return events.some(
    (event) =>
      event.type === 'tool_use' &&
      (event.data as { name?: unknown } | undefined)?.name === 'send_to_agent',
  );
}
