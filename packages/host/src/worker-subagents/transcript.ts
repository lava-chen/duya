import type { Message, MessageContent } from '@duya/agent-core/message';
import type { FileAttachment } from '@duya/agent-protocol';
import type { TokenUsage } from '../worker-run-contracts.js';
import { logger } from '../worker-logger.js';
import { rehydrateContentWithAttachments } from '../worker-session/image-attachments.js';

/** Transcript row projection fields consumed by the sub-agent history loader. */
export interface WorkerSubagentMessageRow {
  readonly id: string;
  readonly role: Message['role'];
  readonly content: string;
  readonly display_content?: string | null;
  readonly name?: string | null;
  readonly tool_call_id?: string | null;
  readonly token_usage?: string | null;
  readonly msg_type?: string | null;
  readonly thinking?: string | null;
  readonly tool_name?: string | null;
  readonly tool_input?: string | null;
  readonly parent_tool_call_id?: string | null;
  readonly viz_spec?: string | null;
  readonly status?: string | null;
  readonly seq_index?: number | null;
  readonly duration_ms?: number | null;
  readonly sub_agent_id?: string | null;
  readonly attachments?: string | null;
  readonly provider_state?: string | null;
  readonly thinking_signature?: string | null;
  readonly tool_signature?: string | null;
  readonly text_signature?: string | null;
  readonly created_at: number;
  readonly reply_to_id?: string | null;
  readonly branched?: boolean | null;
}

export interface WorkerSubagentAttachmentRow {
  readonly mime_type: string | null;
  readonly data: string;
  readonly original_url: string | null;
}

/** Rehydrate a persisted worker message row without importing the SQL owner. */
export function messageRowToMessage(
  row: WorkerSubagentMessageRow,
  attachmentMap?: ReadonlyMap<string, readonly WorkerSubagentAttachmentRow[]>,
): Message {
  let content: string | MessageContent[];
  let toolCallId = row.tool_call_id || undefined;

  if (row.msg_type === 'thinking' && row.thinking) {
    content = [{ type: 'thinking', thinking: row.thinking }];
  } else if (row.msg_type === 'tool_use' && row.tool_name) {
    let input: Record<string, unknown> = {};
    let toolId = row.id;
    try {
      const parsed: unknown = JSON.parse(row.content);
      if (Array.isArray(parsed) && parsed.length > 0) {
        const block = parsed[0] as { id?: unknown; input?: unknown };
        if (block.id) toolId = block.id as string;
        if (block.input) input = block.input as Record<string, unknown>;
      }
    } catch {
      try {
        const parsed: unknown = row.tool_input ? JSON.parse(row.tool_input) : {};
        input = parsed as Record<string, unknown>;
      } catch {
        // Invalid legacy tool input is restored as an empty argument object.
      }
    }
    content = [{ type: 'tool_use', id: toolId, name: row.tool_name, input }];
    toolCallId = toolId;
  } else {
    try {
      const parsed: unknown = JSON.parse(row.content);
      content = Array.isArray(parsed) ? parsed as MessageContent[] : row.content;
    } catch {
      content = row.content;
    }
  }

  if (attachmentMap !== undefined && Array.isArray(content)) {
    content = rehydrateContentWithAttachments(content, attachmentMap, logger) as MessageContent[];
  }

  let parsedAttachments: FileAttachment[] | undefined;
  if (row.attachments) {
    try {
      parsedAttachments = JSON.parse(row.attachments) as FileAttachment[];
    } catch {
      // Preserve transcript loading when optional attachment metadata is malformed.
    }
  }

  let tokenUsage: TokenUsage | undefined;
  if (row.token_usage) {
    try {
      tokenUsage = JSON.parse(row.token_usage) as TokenUsage;
    } catch {
      // Malformed optional usage metadata does not invalidate the message row.
    }
  }

  if (Array.isArray(content)) {
    if (row.thinking_signature) {
      const thinkingBlock = content.find((block) => block.type === 'thinking');
      if (thinkingBlock?.type === 'thinking') thinkingBlock.thinkingSignature = row.thinking_signature;
    }
    if (row.tool_signature) {
      const toolBlock = content.find((block) => block.type === 'tool_use');
      if (toolBlock?.type === 'tool_use') toolBlock.thoughtSignature = row.tool_signature;
    }
    if (row.text_signature) {
      const textBlock = content.find((block) => block.type === 'text');
      if (textBlock?.type === 'text') textBlock.textSignature = row.text_signature;
    }
  }

  let providerState: { api?: string; providerId?: string; model?: string } | undefined;
  if (row.provider_state) {
    try {
      providerState = JSON.parse(row.provider_state) as typeof providerState;
    } catch {
      // Malformed optional provider metadata does not invalidate the message row.
    }
  }

  const threadMeta = row.reply_to_id != null || row.branched != null
    ? {
        ...(row.reply_to_id != null ? { replyToId: row.reply_to_id } : {}),
        ...(row.branched != null ? { branched: row.branched === true } : {}),
      }
    : undefined;

  return {
    id: row.id,
    role: row.role,
    content,
    timestamp: row.created_at,
    ...(row.display_content == null ? {} : { displayContent: row.display_content }),
    ...(row.name ? { name: row.name } : {}),
    ...(toolCallId === undefined ? {} : { tool_call_id: toolCallId }),
    ...(row.msg_type ? { msg_type: row.msg_type } : {}),
    ...(row.thinking ? { thinking: row.thinking } : {}),
    ...(row.tool_name ? { tool_name: row.tool_name } : {}),
    ...(row.tool_input ? { tool_input: row.tool_input } : {}),
    ...(row.parent_tool_call_id ? { parent_tool_call_id: row.parent_tool_call_id } : {}),
    ...(row.viz_spec ? { viz_spec: row.viz_spec } : {}),
    ...(row.status ? { status: row.status } : {}),
    ...(row.seq_index == null ? {} : { seq_index: row.seq_index }),
    ...(row.duration_ms == null ? {} : { duration_ms: row.duration_ms }),
    ...(row.sub_agent_id ? { sub_agent_id: row.sub_agent_id } : {}),
    ...(parsedAttachments === undefined ? {} : { attachments: parsedAttachments }),
    ...(tokenUsage === undefined ? {} : { tokenUsage }),
    ...(providerState?.api === undefined
      ? {}
      : { api: providerState.api as Exclude<Message['api'], undefined> }),
    ...(providerState?.providerId === undefined ? {} : { providerId: providerState.providerId }),
    ...(providerState?.model === undefined ? {} : { model: providerState.model }),
    ...(threadMeta === undefined ? {} : { metadata: { threadMeta } }),
  };
}
