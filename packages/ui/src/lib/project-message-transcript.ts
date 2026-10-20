/**
 * project-message-transcript.ts
 *
 * Thin renderer shim over the Protocol structural projector
 * (`@duya/agent-protocol/transcript`). The renderer still loads legacy `Message[]` DTOs
 * from the DB/IPC, so this module bridges the two shapes and delegates ALL
 * visibility filtering to `projectTranscriptMessages`, which is driven by the
 * structural `visibility` field set during AgentMessage ingestion
 * time (mailbox, background notifications, and non-compaction system rows are
 * hidden; the rest are visible).
 *
 * The Protocol projector is the single source of truth for what is visible. Local
 * concerns that remain here (the agent projector does not own them):
 *  - tool-result grouping (collected into a map, removed from the stream)
 *  - displayContent normalisation for user messages
 *  - field mapping between the renderer's hybrid Message shape and the legacy
 *    Agent-compatible Message shape
 */

import type { FileAttachment, Message, MsgType, ToolResultInfo } from '@/types';
import { ingestMessages } from '@duya/agent-protocol';
import type { Message as AgentMessage } from '@duya/agent-protocol/transcript';
import { projectTranscriptMessages } from '@duya/agent-protocol/transcript';

/** Output of the transcript projection. */
export interface ProjectedTranscript {
  /** Visible messages in original order. Hidden messages are removed. */
  readonly messages: Message[];
}

// ---------------------------------------------------------------------------
// Field mapping (renderer hybrid shape <-> agent snake_case shape)
// ---------------------------------------------------------------------------

function toAgentMessage(msg: Message): AgentMessage {
  return {
    id: msg.id,
    role: msg.role,
    content: msg.content as AgentMessage['content'],
    displayContent: msg.displayContent as AgentMessage['displayContent'],
    name: msg.name,
    tool_call_id: msg.tool_call_id,
    timestamp: msg.timestamp,
    metadata: msg.metadata as Record<string, unknown> | undefined,
    msg_type: msg.msgType,
    thinking: msg.thinking ?? undefined,
    tool_name: msg.toolName ?? undefined,
    tool_input: msg.toolInput ?? undefined,
    parent_tool_call_id: msg.parentToolCallId ?? undefined,
    viz_spec: msg.vizSpec ?? undefined,
    status: msg.status,
    seq_index: msg.seqIndex ?? undefined,
    duration_ms: msg.durationMs ?? undefined,
    sub_agent_id: msg.subAgentId ?? undefined,
    attachments: msg.attachments as unknown[] | undefined,
    isCompactBoundary: msg.isCompactBoundary,
    isCompactSummary: msg.isCompactSummary,
    compactedMessageCount: msg.compactedMessageCount,
    tokenUsage: msg.tokenUsage ?? undefined,
  };
}

function toRendererMessage(msg: AgentMessage): Message {
  return {
    id: msg.id ?? '',
    role: msg.role,
    content: msg.content as Message['content'],
    displayContent: msg.displayContent as Message['displayContent'],
    name: msg.name,
    tool_call_id: msg.tool_call_id,
    timestamp: msg.timestamp ?? 0,
    tokenUsage: (msg.tokenUsage ?? null) as unknown as Message['tokenUsage'],
    msgType: (msg.msg_type as MsgType) ?? 'text',
    thinking: msg.thinking ?? null,
    toolName: msg.tool_name ?? null,
    toolInput: msg.tool_input ?? null,
    parentToolCallId: msg.parent_tool_call_id ?? null,
    vizSpec: msg.viz_spec ?? null,
    status: msg.status ?? 'done',
    seqIndex: msg.seq_index ?? null,
    durationMs: msg.duration_ms ?? null,
    subAgentId: msg.sub_agent_id ?? null,
    attachments: msg.attachments as FileAttachment[] | undefined,
    isCompactBoundary: msg.isCompactBoundary,
    isCompactSummary: msg.isCompactSummary,
    compactedMessageCount: msg.compactedMessageCount,
    metadata: msg.metadata as Message['metadata'],
  };
}

// ---------------------------------------------------------------------------
// Display content resolution
// ---------------------------------------------------------------------------

/**
 * Ensures user messages have a `displayContent`. When the caller already set
 * one (e.g. the frontend stored the user's typed text separately from the
 * LLM-facing content), it is preserved. Otherwise `content` is used.
 *
 * Returns the original message reference when no change is needed (zero-copy
 * fast path); returns a shallow copy only when `displayContent` must be set.
 */
function resolveDisplayContent(msg: Message): Message {
  if (msg.role !== 'user') return msg;
  if (msg.displayContent !== undefined) return msg;
  return { ...msg, displayContent: msg.content };
}

// ---------------------------------------------------------------------------
// Cursor provenance
// ---------------------------------------------------------------------------

/**
 * The two fields the Protocol round-trip cannot carry, and why they are
 * re-attached HERE instead of being added to the Protocol message shape.
 *
 * `sequenceDomain` + `runId` are RENDERER-SIDE cursor provenance: `MsgType`-
 * independent bookkeeping that tells `MessageList`'s
 * `sortMessagesForConversation` which cursor a `seqIndex` was read on, so a
 * durable row (message-log cursor) and a live RunSession row (run-event cursor)
 * with unrelated, overlapping sequence numbers are never merged into one
 * sort key. `sequenceDomain` is renderer cursor provenance; it is not stored
 * in MessageLog. Host already stamps `runId` onto its durable run projection,
 * while live RunSession rows also carry the Host run identity. The Protocol
 * transcript projection does not preserve either field, so the Protocol boundary — whose
 * `LEGACY_KNOWN_KEYS` whitelist in
 * `packages/agent-protocol/src/message-ingest.ts` drops every key it does not
 * list — legitimately strips them.
 *
 * Widening that whitelist is the alternative, and is rejected: it is a
 * cross-lane change to a `managed: true` package (zero tolerance, cannot be
 * baselined) for renderer cursor metadata consumed by this renderer. The
 * fields are therefore captured before
 * `ingestMessages` and re-attached after `projectTranscriptMessages`.
 */
type CursorProvenance = Pick<Message, 'sequenceDomain' | 'runId'>;

function cursorProvenanceOf(msg: Message | undefined): CursorProvenance | null {
  if (!msg) return null;
  if (msg.sequenceDomain === undefined && msg.runId === undefined) return null;
  return {
    ...(msg.sequenceDomain === undefined ? {} : { sequenceDomain: msg.sequenceDomain }),
    ...(msg.runId === undefined ? {} : { runId: msg.runId }),
  };
}

// ---------------------------------------------------------------------------
// Projector
// ---------------------------------------------------------------------------

/**
 * Project a raw message list (from IPC/DB mapping or streaming) into the
 * visible transcript. Hidden runtime_context rows (attachment context,
 * mailbox instructions, background notifications, etc.) are removed.
 *
 * Tool results stay in the returned message array so the existing
 * `MessageList` grouping logic continues to work unchanged.
 *
 * PURE function: it does not mutate the input array or any message object.
 * Visibility filtering is delegated to Protocol's `projectTranscriptMessages`
 * (structural `visibility` field); displayContent normalisation is resolved here.
 */
export function projectMessageTranscript(messages: Message[]): ProjectedTranscript {
  const agentMessages = ingestMessages(messages.map(toAgentMessage));

  // Capture cursor provenance keyed by the id the row carries BACK OUT, read
  // off the ingested row — not off the input row. The two are NOT the same key:
  // `ingestMessages` mints `legacy-message-<index>` for a row that arrived
  // without an id (for the roles that go through `baseFields`), while
  // `toRendererMessage` coerces a row that reached it without one to `''`.
  // Reading `agentMessages[index].id` reproduces ingest's role-dependent id
  // rule exactly, without duplicating it here, and `projectTranscriptMessages`
  // preserves both the order and the id of every row it keeps — so a row with
  // no id at all is still re-attached correctly (it comes back under whatever
  // id ingest gave it, and the lookup key follows the same rule).
  //
  // A QUEUE per key, not one slot per key: rows that end up sharing a key
  // (the id-less ones above) are re-attached in source order, and a row that
  // shares its key with an earlier one is not silently overwritten. The
  // pairing is exact for the rows that actually carry provenance — the live
  // RunSession rows, whose ids are `run:<runId>:<messageId|toolCallId>`,
  // unique by construction and never hidden — and for a duplicate key the
  // source order is the only true pairing left: the projector preserves the
  // order of the rows it keeps, and a hidden row never consumes an entry of a
  // key a later visible row also holds (hidden rows come from
  // `baseFields`-derived synthetic ids, so they cannot share a visible row id).
  const pendingProvenance = new Map<string, CursorProvenance[]>();
  for (let index = 0; index < messages.length; index += 1) {
    const provenance = cursorProvenanceOf(messages[index]);
    if (!provenance) continue;
    const key = agentMessages[index]?.id ?? '';
    const queue = pendingProvenance.get(key);
    if (queue) queue.push(provenance);
    else pendingProvenance.set(key, [provenance]);
  }

  const projected = projectTranscriptMessages(agentMessages);

  const visible: Message[] = [];
  for (const agentMsg of projected) {
    const msg = toRendererMessage(agentMsg);
    // `shift` (not `get`): the projector DROPS rows (hidden / branched), and
    // the rows it keeps keep their relative order — so consuming the queue in
    // order pairs each visible row with its own source entry, never with the
    // first entry of its key.
    const provenance = pendingProvenance.get(msg.id)?.shift();
    visible.push(resolveDisplayContent(provenance ? { ...msg, ...provenance } : msg));
  }

  return { messages: visible };
}
