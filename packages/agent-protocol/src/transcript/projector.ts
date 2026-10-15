import {
  THREAD_METADATA_KEY,
  type AgentMessage,
  type CompactionEntry,
  type CompactionSummaryMessage,
  type LegacyCompactionBoundaryMessage,
  type LegacySystemMessage,
  type LegacyUnknownRoleMessage,
  type MessageTimelineEntry,
  type RuntimeContextMessage,
} from '../message-timeline.js';
import type { Message, MessageContent } from './content.js';

export interface LegacyCompactionCheckpoint {
  readonly version: 1;
  readonly id: string;
  readonly createdAt: number;
  readonly firstKeptMessageId: string;
  readonly compactedMessageIds: readonly string[];
  readonly tokensBefore: number;
  readonly tokensAfter?: number;
  readonly strategy: string;
  readonly previousCompactionId?: string;
  readonly reinjectedSystemMessages?: readonly (string | readonly MessageContent[])[];
}

export const COMPACTION_CHECKPOINT_MESSAGE_TYPE = 'compact_checkpoint';
export const COMPACTION_CHECKPOINT_ID_SUFFIX = ':checkpoint';

export interface ProjectTranscriptOptions {
  readonly includeBranched?: boolean;
}

function cloneValue<T>(value: T): T {
  return structuredClone(value);
}

function cloneMetadata(
  metadata: Readonly<Record<string, unknown>> | undefined,
): Record<string, unknown> | undefined {
  if (!metadata) return undefined;
  const cloned = cloneValue(metadata);
  return Object.keys(cloned).length > 0 ? cloned : undefined;
}

function runtimeField(
  message: Message,
  snakeKey: string,
  metaKey: string,
): string | number | undefined {
  const top = (message as Message & Record<string, unknown>)[snakeKey];
  if (top !== undefined && top !== null) return top as string | number;
  const metaValue = message.metadata?.[metaKey];
  return metaValue !== undefined && metaValue !== null
    ? (metaValue as string | number)
    : undefined;
}

function augmentLegacyColumns<T extends Message>(message: Message, target: T): T {
  const seqIndex = runtimeField(message, 'seq_index', 'seqIndex');
  const durationMs = runtimeField(message, 'duration_ms', 'durationMs');
  const status = runtimeField(message, 'status', 'status');
  if (seqIndex !== undefined) target.seq_index = seqIndex as number;
  if (durationMs !== undefined) target.duration_ms = durationMs as number;
  if (status !== undefined) target.status = status as string;
  if (message.msg_type !== undefined) target.msg_type = message.msg_type;
  if (message.thinking !== undefined) target.thinking = message.thinking;
  if (message.tool_name !== undefined) target.tool_name = message.tool_name;
  if (message.tool_input !== undefined) target.tool_input = message.tool_input;
  if (message.parent_tool_call_id !== undefined) target.parent_tool_call_id = message.parent_tool_call_id;
  if (message.viz_spec !== undefined) target.viz_spec = message.viz_spec;
  if (message.sub_agent_id !== undefined) target.sub_agent_id = message.sub_agent_id;
  if (message.api !== undefined) target.api = message.api;
  if (message.tool_call_id !== undefined) target.tool_call_id = message.tool_call_id;
  return target;
}

function projectBoundaryMessage(message: AgentMessage): Message | null {
  switch (message.role) {
    case 'user': {
      const native = message as Message;
      return augmentLegacyColumns(native, {
        id: native.id,
        role: 'user',
        content: cloneValue(native.content),
        displayContent: native.displayContent !== undefined ? cloneValue(native.displayContent) : undefined,
        attachments: native.attachments ? cloneValue(native.attachments) : undefined,
        timestamp: native.timestamp,
        metadata: cloneMetadata(native.metadata),
      } as Message);
    }
    case 'assistant': {
      const native = message as Message;
      return augmentLegacyColumns(native, {
        id: native.id,
        role: 'assistant',
        content: cloneValue(native.content),
        providerId: native.providerId,
        model: native.model,
        tokenUsage: native.tokenUsage ? cloneValue(native.tokenUsage) : undefined,
        timestamp: native.timestamp,
        metadata: cloneMetadata(native.metadata),
      } as Message);
    }
    case 'tool': {
      const native = message as Message;
      const toolResult = Array.isArray(native.content)
        ? native.content.find((block) => block.type === 'tool_result') as
          | { tool_use_id?: string }
          | undefined
        : undefined;
      const isError = runtimeField(native, 'status', 'status') === 'error';
      return augmentLegacyColumns(native, {
        id: native.id,
        role: 'tool',
        name: native.name,
        tool_call_id: native.tool_call_id ?? toolResult?.tool_use_id,
        content: Array.isArray(native.content)
          ? cloneValue(native.content)
          : cloneValue([{
              type: 'tool_result' as const,
              tool_use_id: native.tool_call_id ?? '',
              content: native.content,
              is_error: isError,
            }]),
        timestamp: native.timestamp,
        metadata: cloneMetadata(native.metadata),
      } as Message);
    }
    case 'runtime_context': {
      const context = message as RuntimeContextMessage;
      const metadata = cloneMetadata(context.metadata);
      return {
        id: context.id,
        role: 'user',
        content: cloneValue(context.content),
        msg_type: context.source,
        timestamp: context.timestamp,
        metadata: { ...(metadata ?? {}), runtimeContext: true, source: context.source },
      };
    }
    case 'compaction_summary': {
      const summary = message as CompactionSummaryMessage;
      return {
        id: summary.id,
        role: 'user',
        content: summary.summary,
        isCompactSummary: true,
        compactBoundaryId: summary.compactionEntryId,
        compactedMessageCount: summary.tokensBefore,
        timestamp: summary.timestamp,
        metadata: cloneMetadata(summary.metadata),
      } as Message;
    }
    case 'legacy_system': {
      const marker = message as LegacySystemMessage;
      return {
        id: marker.id,
        role: 'system',
        content: cloneValue(marker.payload.content),
        name: marker.payload.name,
        timestamp: marker.timestamp,
      } as Message;
    }
    case 'legacy_compaction_boundary': {
      const marker = message as LegacyCompactionBoundaryMessage;
      return {
        id: marker.id,
        role: 'system',
        content: cloneValue(marker.payload.content),
        isCompactBoundary: true,
        compactBoundaryId: marker.payload.compactBoundaryId,
        compactedMessageCount: marker.payload.compactedMessageCount,
        compactedMessageIds: marker.payload.compactedMessageIds
          ? [...marker.payload.compactedMessageIds]
          : undefined,
        timestamp: marker.timestamp,
      } as Message;
    }
    case 'legacy_unknown_role': {
      const marker = message as LegacyUnknownRoleMessage;
      return {
        id: marker.id,
        role: marker.payload.role as Message['role'],
        content: cloneValue(marker.payload.content),
        timestamp: marker.timestamp,
      };
    }
    default:
      return null;
  }
}

function isBranched(message: AgentMessage): boolean {
  const metadata = (message as { metadata?: Readonly<Record<string, unknown>> }).metadata;
  const thread = metadata?.[THREAD_METADATA_KEY];
  return Boolean(thread && typeof thread === 'object' && !Array.isArray(thread) &&
    (thread as Record<string, unknown>).branched === true);
}

/** Projects durable messages to the legacy row shape without visibility filtering. */
export function projectPersistenceMessages(
  messages: readonly AgentMessage[],
): Message[] {
  const result: Message[] = [];
  for (const message of messages) {
    const projected = projectBoundaryMessage(message);
    if (projected) result.push(projected);
  }
  return result;
}

function checkpointForEntry(entry: CompactionEntry): LegacyCompactionCheckpoint {
  return {
    version: 1,
    id: entry.id,
    createdAt: entry.createdAt,
    firstKeptMessageId: entry.firstKeptMessageId,
    compactedMessageIds: [...entry.compactedMessageIds],
    tokensBefore: entry.tokensBefore,
    strategy: entry.strategy,
    ...(entry.tokensAfter === undefined ? {} : { tokensAfter: entry.tokensAfter }),
    ...(entry.previousCompactionId === undefined
      ? {}
      : { previousCompactionId: entry.previousCompactionId }),
    ...(entry.reinjectedSystemMessages === undefined
      ? {}
      : { reinjectedSystemMessages: cloneValue(entry.reinjectedSystemMessages) }),
  };
}

/**
 * Projects a complete timeline into durable legacy rows. Compaction replaces
 * the folded main-line prefix with one checkpoint marker while preserving
 * branched messages that belong to the thread layer.
 */
export function projectTimelinePersistenceMessages(
  entries: readonly MessageTimelineEntry[],
): Message[] {
  const messageEntries = entries.filter(
    (entry) => entry.type === 'message',
  );
  const latestCompaction = [...entries]
    .reverse()
    .find((entry): entry is CompactionEntry => entry.type === 'compaction');
  if (!latestCompaction) {
    return projectPersistenceMessages(messageEntries.map((entry) => entry.message));
  }

  const checkpoint = checkpointForEntry(latestCompaction);
  const marker: Message = {
    id: `${checkpoint.id}${COMPACTION_CHECKPOINT_ID_SUFFIX}`,
    role: 'system',
    content: latestCompaction.summary,
    isCompactSummary: true,
    compactBoundaryId: checkpoint.id,
    compactedMessageCount: checkpoint.compactedMessageIds.length,
    timestamp: checkpoint.createdAt,
    msg_type: COMPACTION_CHECKPOINT_MESSAGE_TYPE,
    tool_input: JSON.stringify(checkpoint),
  };

  const compactionIndex = entries.findIndex((entry) => entry.id === latestCompaction.id);
  const firstKeptIndex = entries.findIndex(
    (entry) => entry.type === 'message' && entry.message.id === checkpoint.firstKeptMessageId,
  );
  const hasValidBoundary = firstKeptIndex >= 0 && firstKeptIndex <= compactionIndex;
  const contextMessages = hasValidBoundary
    ? entries
        .slice(firstKeptIndex)
        .filter((entry) => entry.type === 'message')
        .map((entry) => entry.message)
    : messageEntries.map((entry) => entry.message);

  const foldedBranched: AgentMessage[] = [];
  if (firstKeptIndex > 0) {
    for (const entry of entries.slice(0, firstKeptIndex)) {
      if (entry.type === 'message' && isBranched(entry.message)) {
        foldedBranched.push(entry.message);
      }
    }
  }

  return [
    marker,
    ...projectPersistenceMessages(foldedBranched),
    ...projectPersistenceMessages(
      contextMessages.filter((message) => message.role !== 'compaction_summary'),
    ),
  ];
}

/** Projects the visible AgentMessage subset to the legacy transcript DTO. */
export function projectTranscriptMessages(
  messages: readonly AgentMessage[],
  options: ProjectTranscriptOptions = {},
): Message[] {
  const includeBranched = options.includeBranched === true;
  const result: Message[] = [];
  for (const message of messages) {
    if (message.visibility !== 'visible') continue;
    if (!includeBranched && isBranched(message)) continue;
    const projected = projectBoundaryMessage(message);
    if (projected) result.push(projected);
  }
  return result;
}
