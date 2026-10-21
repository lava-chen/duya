import type {
  AgentMessage,
  AgentMessageContent,
  CompactionSummaryMessage,
  LegacyCompactionBoundaryMessage,
  LegacySystemMessage,
  LegacyUnknownRoleMessage,
  RuntimeContextMessage,
  RuntimeContextSource,
} from './message-timeline.js';
import type { Message, MessageContent, ToolResultContent } from './transcript/content.js';

/** A persistence-shaped message may contain roles unknown to this version. */
export type LegacyPersistedMessage = Omit<Message, 'role'> & { role: string };

export interface IngestMessageOptions {
  /** Used only to derive stable synthetic IDs for rows without an ID. */
  readonly index?: number;
}

const LEGACY_KNOWN_KEYS = [
  'name', 'tool_call_id', 'msg_type', 'thinking', 'tool_name', 'tool_input',
  'parent_tool_call_id', 'viz_spec', 'status', 'seq_index', 'duration_ms',
  'sub_agent_id', 'attachments', 'displayContent', 'isCompactBoundary',
  'isCompactSummary', 'compactedMessageCount', 'compactedMessageIds',
  'compactBoundaryId', 'tokenUsage', 'providerId', 'model', 'api',
] as const;

function cloneValue<T>(value: T): T {
  return structuredClone(value);
}

function pickKnown(message: LegacyPersistedMessage): Record<string, unknown> {
  const source = message as LegacyPersistedMessage & Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const key of LEGACY_KNOWN_KEYS) {
    const value = source[key];
    if (value !== undefined) out[key] = value;
  }
  return out;
}

function runtimeSource(message: LegacyPersistedMessage): RuntimeContextSource | undefined {
  const type = message.msg_type?.toLowerCase();
  if (type === 'mailbox' || type === 'runtime_context') return 'mailbox';
  if (type === 'task-notification' || type === 'task_notification') return 'background_notification';
  if (type === 'attachment') return 'attachment';
  if (type === 'mode' || type === 'mode_changed') return 'mode';
  if (type === 'memory') return 'memory';
  if (type === 'goal_summary') return 'goal_summary';
  if (type === 'research_continuation') return 'research_continuation';
  if (message.metadata?.runtimeContext === true) return 'custom';
  return undefined;
}

function contentToText(content: AgentMessageContent): string {
  if (typeof content === 'string') return content;
  return content.map((block) => {
    if (block.type === 'text') return block.text;
    if (block.type === 'thinking') return block.thinking;
    if (block.type === 'tool_result') return contentToText(block.content);
    return JSON.stringify(block);
  }).join('\n');
}

function findToolResult(content: AgentMessageContent): ToolResultContent | undefined {
  if (!Array.isArray(content)) return undefined;
  return content.find((block): block is ToolResultContent => block.type === 'tool_result');
}

function baseFields(message: LegacyPersistedMessage, index: number): {
  id: string;
  timestamp: number;
  visibility: 'visible' | 'hidden';
  metadata: Readonly<Record<string, unknown>>;
} {
  const source = runtimeSource(message);
  return {
    id: message.id || `legacy-message-${index}`,
    timestamp: message.timestamp ?? 0,
    visibility: source === 'mailbox' || source === 'background_notification' || source === 'attachment'
      ? 'hidden'
      : 'visible',
    metadata: Object.freeze(message.metadata ? cloneValue(message.metadata) : {}),
  };
}

/** Converts a persisted message without mutating the input object. */
export function ingestMessage(
  message: LegacyPersistedMessage,
  options: IngestMessageOptions = {},
): AgentMessage {
  const index = options.index ?? 0;
  const base = baseFields(message, index);
  const content = cloneValue(message.content) as MessageContent[] | string;

  if (message.isCompactBoundary) {
    const boundary: LegacyCompactionBoundaryMessage = {
      role: 'legacy_compaction_boundary',
      id: base.id,
      timestamp: base.timestamp,
      visibility: base.visibility,
      payload: {
        compactBoundaryId: message.compactBoundaryId,
        content,
        compactedMessageCount: message.compactedMessageCount,
        compactedMessageIds: message.compactedMessageIds ? [...message.compactedMessageIds] : undefined,
      } as LegacyCompactionBoundaryMessage['payload'],
    };
    return boundary;
  }

  if (message.isCompactSummary) {
    const summary: CompactionSummaryMessage = {
      role: 'compaction_summary',
      id: base.id,
      timestamp: base.timestamp,
      visibility: base.visibility,
      summary: contentToText(content),
      compactionEntryId: message.compactBoundaryId ?? base.id,
      tokensBefore: message.compactedMessageCount ?? 0,
    };
    if (Object.keys(base.metadata).length > 0) summary.metadata = base.metadata;
    return summary;
  }

  if (message.role === 'system') {
    const systemMessage: LegacySystemMessage = {
      role: 'legacy_system',
      id: base.id,
      timestamp: base.timestamp,
      visibility: base.visibility,
      payload: { content, name: message.name } as LegacySystemMessage['payload'],
    };
    return systemMessage;
  }

  const source = runtimeSource(message);
  if (source) {
    const runtimeMessage: RuntimeContextMessage = {
      role: 'runtime_context',
      id: base.id,
      timestamp: base.timestamp,
      visibility: base.visibility,
      source,
      content,
    };
    if (Object.keys(base.metadata).length > 0) runtimeMessage.metadata = base.metadata;
    return runtimeMessage;
  }

  if (message.role === 'user' || message.role === 'assistant') {
    const chatMessage = {
      ...pickKnown(message),
      id: message.id,
      timestamp: base.timestamp,
      visibility: base.visibility,
      role: message.role,
      content: cloneValue(message.content),
      metadata: base.metadata,
    } as Message & Record<string, unknown>;
    const stopReason = (message as LegacyPersistedMessage & { stopReason?: unknown }).stopReason;
    if (message.role === 'assistant' && typeof stopReason === 'string') {
      chatMessage.metadata = { ...base.metadata, stopReason };
    }
    return chatMessage;
  }

  if (message.role === 'tool') {
    const toolMessage = {
      ...pickKnown(message),
      id: message.id,
      timestamp: base.timestamp,
      visibility: base.visibility,
      role: 'tool',
      content: cloneValue(message.content),
      metadata: base.metadata,
      name: message.name ?? message.tool_name ?? 'legacy-tool',
      tool_call_id: message.tool_call_id ?? findToolResult(content)?.tool_use_id ?? `legacy-tool-call-${index}`,
    } as Message & Record<string, unknown>;
    return toolMessage;
  }

  const unknownMessage: LegacyUnknownRoleMessage = {
    role: 'legacy_unknown_role',
    id: base.id,
    timestamp: base.timestamp,
    visibility: base.visibility,
    payload: { role: message.role, content },
  };
  return unknownMessage;
}

/** Converts a history with stable index-based IDs for rows missing an ID. */
export function ingestMessages(messages: readonly LegacyPersistedMessage[]): AgentMessage[] {
  return messages.map((message, index) => ingestMessage(message, { index }));
}
