/**
 * project-message-transcript.ts
 *
 * Thin renderer shim over the agent-side structural projector
 * (`@duya/agent/message`). The renderer still loads legacy `Message[]` DTOs
 * from the DB/IPC, so this module bridges the two shapes and delegates ALL
 * visibility filtering to `projectTranscriptMessages`, which is driven by the
 * structural `visibility` field the agent sets at AgentMessage construction
 * time (mailbox, background notifications, and non-compaction system rows are
 * hidden; the rest are visible).
 *
 * The agent projector is the single source of truth for what is visible. Local
 * concerns that remain here (the agent projector does not own them):
 *  - tool-result grouping (collected into a map, removed from the stream)
 *  - displayContent normalisation for user messages
 *  - field mapping between the renderer's hybrid Message shape and the agent
 *    snake_case Message shape
 */

import type { FileAttachment, Message, MsgType, ToolResultInfo } from '@/types';
import {
  ingestMessages,
  projectTranscriptMessages,
  type Message as AgentMessage,
} from '@duya/agent/message';

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
 * Visibility filtering is delegated to the agent-side `projectTranscriptMessages`
 * (structural `visibility` field); displayContent normalisation is resolved here.
 */
export function projectMessageTranscript(messages: Message[]): ProjectedTranscript {
  const agentMessages = ingestMessages(messages.map(toAgentMessage));
  const projected = projectTranscriptMessages(agentMessages);

  const visible: Message[] = [];
  for (const agentMsg of projected) {
    const msg = toRendererMessage(agentMsg);
    visible.push(resolveDisplayContent(msg));
  }

  return { messages: visible };
}