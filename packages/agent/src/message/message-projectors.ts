import type { Message, MessageContent } from '../types.js';
import {
  type AgentMessage,
  type AgentMessageVisibility,
  type CompactionSummaryMessage,
  type LegacyCompactionBoundaryMessage,
  type LegacySystemMessage,
  type LegacyUnknownRoleMessage,
  type PromptSegment,
  type RuntimeContextMessage,
  type CompactionEntry,
  type MessageTimelineEntry,
  buildAgentContext,
  cloneValue,
} from './message-framework.js';

/**
 * Three explicit output boundaries for {@link AgentMessage}.
 *
 * The legacy runtime persisted, rendered, and modeled a single `Message[]`
 * with one shape. The new domain separates these concerns so each boundary
 * can be verified and migrated independently:
 *
 * - Model boundary       -> provider `Message[]` plus a separate system prompt.
 * - Persistence boundary -> the durable subset of the legacy `Message[]`
 *                           shape (DB rows, IPC DTOs, SSE events).
 * - Transcript boundary  -> the visible subset rendered in the UI.
 *
 * All projectors are pure: they never mutate their input and they produce
 * deterministic output for a given input. Every role is projected natively
 * from the AgentMessage shape; no adapter envelope is involved.
 *
 * These projectors do not change the external contract: each boundary still
 * emits the legacy `Message[]` shape (or a provider split), so DB schema, IPC
 * DTOs, SSE events, and renderer behavior remain unchanged.
 */

// ─── Model boundary ──────────────────────────────────────────────────────

/**
 * Provider-facing projection. System prompt content is kept separate from the
 * messages array so a system segment is never smuggled in as a user turn.
 */
export interface ModelMessageProjection {
  /**
   * Merged system prompt content. Empty string when no system segments are
   * supplied. Never mixed into {@link messages} as a user role.
   */
  readonly system: string | readonly MessageContent[];
  /**
   * Provider messages in order. Includes runtime context and compaction
   * summaries as user-role turns; excludes legacy marker roles.
   */
  readonly messages: readonly Message[];
}

export interface ProjectModelMessagesOptions {
  /** System segments merged into the system prompt. */
  readonly systemSegments?: readonly PromptSegment[];
}

/**
 * Projects AgentMessages to the provider boundary: a separate system prompt
 * plus a `Message[]` ready for the model.
 */
export function projectModelMessages(
  messages: readonly AgentMessage[],
  options: ProjectModelMessagesOptions = {},
): ModelMessageProjection {
  const providerMessages: Message[] = [];
  for (const message of messages) {
    providerMessages.push(...toModelBoundary(message));
  }
  const system = mergeSystemSegments(options.systemSegments);
  return { system, messages: providerMessages };
}

/**
 * Projects a single {@link RuntimeContextMessage} to a provider-compatible
 * user-role {@link Message}. This is a one-way API adaptation: the domain
 * message remains a runtime_context, and this projection only exists so the
 * provider sees a `role: 'user'` turn.
 *
 * Internal tracking metadata (mailbox row IDs, claim tokens, task IDs) is
 * intentionally NOT carried into the provider message — those are domain
 * concerns, not model context. Only `runtimeContext: true` and `source` are
 * attached so the reverse adapter can recover the runtime_context kind.
 *
 * The input message is never mutated.
 */
export function projectRuntimeContextToProviderMessage(
  message: RuntimeContextMessage,
): Message {
  return {
    id: message.id,
    role: 'user',
    content: message.content,
    timestamp: message.timestamp,
    metadata: {
      runtimeContext: true,
      source: message.source,
    },
  };
}

/**
 * Converts a role-based AgentMessage to the provider boundary. Legacy marker
 * roles are excluded (their content lives in the system prompt via
 * {@link extractLegacySystemSegments}).
 *
 * Only user/assistant/tool turns are restored losslessly from the legacy
 * envelope. System, compaction-summary, runtime-context, and unknown-role
 * messages are routed by role instead, so a legacy system row is never
 * re-injected into the messages array as a `system` turn.
 */
function toModelBoundary(message: AgentMessage): Message[] {
  const role = (message as { role?: string }).role;
  if (role !== 'user' && role !== 'assistant' && role !== 'tool') {
    return toModelBoundaryByRole(message);
  }

  // Phase 1: user/assistant/tool are projected natively. The ingest adapter
  // now preserves every original field on the object, so the spread is
  // lossless without the legacy envelope.
  return [{ ...(message as Message), id: (message as Message).id, timestamp: (message as Message).timestamp }];
}

function toModelBoundaryByRole(message: AgentMessage): Message[] {
  switch (message.role) {
    case 'runtime_context':
      return [projectRuntimeContextToProviderMessage(message)];
    case 'compaction_summary':
      return [
        {
          id: message.id,
          role: 'user',
          content: [
            'Another agent continued this task and produced the following context summary.',
            'Use it as prior context without repeating completed work.',
            '',
            message.summary,
          ].join('\n'),
          timestamp: message.timestamp,
          isCompactSummary: true,
          compactBoundaryId: message.compactionEntryId,
        },
      ];
    case 'legacy_system':
    case 'legacy_compaction_boundary':
    case 'legacy_unknown_role':
      return [];
    default:
      return [];
  }
}

function mergeSystemSegments(
  segments: readonly PromptSegment[] | undefined,
): string | readonly MessageContent[] {
  if (!segments || segments.length === 0) {
    return '';
  }

  // Clone the content payloads so callers cannot mutate the source segments
  // through the returned system value. `typeof` is used instead of
  // `Array.isArray` because the latter does not narrow `readonly T[]`.
  const cloned = segments.map((segment) => cloneValue(segment.content));
  const hasStructured = cloned.some((content) => typeof content !== 'string');

  if (!hasStructured) {
    return cloned
      .map((content) => content as string)
      .filter((text) => text.length > 0)
      .join('\n\n');
  }

  const blocks: MessageContent[] = [];
  for (const content of cloned) {
    if (typeof content === 'string') {
      if (content.length > 0) {
        blocks.push({ type: 'text', text: content });
      }
    } else {
      blocks.push(...content);
    }
  }
  return blocks;
}

/**
 * Extract system content from legacy-adapted system messages and compaction
 * reinjected system messages into PromptSegments for the model boundary.
 *
 * Legacy system messages (role='system' in the DB) are adapted to role
 * `legacy_system`. `projectModelMessages` skips that role, so their content
 * would be lost without this extraction. Compaction entries may carry
 * `reinjectedSystemMessages` that also belong in the system prompt.
 *
 * @param messages - AgentMessage[] from buildAgentContext
 * @param compaction - Optional CompactionEntry from buildAgentContext
 * @returns PromptSegment[] for use with projectModelMessages
 */
export function extractLegacySystemSegments(
  messages: readonly AgentMessage[],
  compaction?: { readonly id: string; readonly reinjectedSystemMessages?: readonly (string | readonly MessageContent[])[] } | null,
): PromptSegment[] {
  const segments: PromptSegment[] = [];

  for (const agentMessage of messages) {
    if (agentMessage.role !== 'legacy_system') continue;
    const payload = agentMessage.payload;
    if (payload?.content) {
      segments.push({
        id: agentMessage.id,
        contributorId: 'legacy-system',
        placement: 'history-prefix' as const,
        content: payload.content as string | readonly MessageContent[],
      });
    }
  }

  if (compaction?.reinjectedSystemMessages) {
    for (let i = 0; i < compaction.reinjectedSystemMessages.length; i++) {
      const reinjected = compaction.reinjectedSystemMessages[i];
      segments.push({
        id: `${compaction.id}:reinjected-${i}`,
        contributorId: 'compaction',
        placement: 'history-prefix' as const,
        content: reinjected as string | readonly MessageContent[],
      });
    }
  }

  return segments;
}

// ─── Shared boundary conversion (persistence + transcript) ──────────────

function cloneMetadata(
  metadata: Readonly<Record<string, unknown>> | undefined,
): Record<string, unknown> | undefined {
  if (!metadata) return undefined;
  const cloned = cloneValue(metadata);
  return Object.keys(cloned).length > 0 ? cloned : undefined;
}

/**
 * Reads a runtime-only DB column from the AgentMessage. The native factory
 * stores these under camelCase `metadata` keys (seqIndex / durationMs /
 * status), while rows loaded from the DB carry them as top-level snake_case
 * fields. Prefer the top-level field, then fall back to the metadata key.
 */
function runtimeField(
  message: Message,
  snakeKey: string,
  metaKey: string,
): string | number | undefined {
  const top = (message as Message & Record<string, unknown>)[snakeKey];
  if (top !== undefined && top !== null) return top as string | number;
  const meta = message.metadata as Record<string, unknown> | undefined;
  const metaValue = meta?.[metaKey];
  return metaValue !== undefined && metaValue !== null
    ? (metaValue as string | number)
    : undefined;
}

/**
 * Emits the DB columns the row mapping layer reads back (seq_index,
 * duration_ms, status, sub_agent_id, viz_spec, ...). These previously lived
 * only in the legacy adapter envelope; now the native projections carry them.
 */
function augmentLegacyColumns<T extends Message>(
  message: Message,
  target: T,
): T {
  const seqIndex = runtimeField(message, 'seq_index', 'seqIndex');
  const durationMs = runtimeField(message, 'duration_ms', 'durationMs');
  const status = runtimeField(message, 'status', 'status');
  if (seqIndex !== undefined) target.seq_index = seqIndex as number;
  if (durationMs !== undefined) target.duration_ms = durationMs as number;
  if (status !== undefined) target.status = status as string;
  if (message.msg_type !== undefined) target.msg_type = message.msg_type;
  if (message.tool_name !== undefined) target.tool_name = message.tool_name;
  if (message.tool_input !== undefined) target.tool_input = message.tool_input;
  if (message.parent_tool_call_id !== undefined) {
    target.parent_tool_call_id = message.parent_tool_call_id;
  }
  if (message.viz_spec !== undefined) target.viz_spec = message.viz_spec;
  if (message.sub_agent_id !== undefined) target.sub_agent_id = message.sub_agent_id;
  if (message.api !== undefined) target.api = message.api;
  if (message.tool_call_id !== undefined) target.tool_call_id = message.tool_call_id;
  return target;
}

function nativeUserToLegacy(message: Message): Message {
  return augmentLegacyColumns(message, {
    id: message.id,
    role: 'user',
    content: cloneValue(message.content),
    displayContent: message.displayContent !== undefined
      ? cloneValue(message.displayContent)
      : undefined,
    attachments: message.attachments
      ? (cloneValue(message.attachments) as unknown[])
      : undefined,
    timestamp: message.timestamp,
    metadata: cloneMetadata(message.metadata),
  });
}

function nativeAssistantToLegacy(message: Message): Message {
  return augmentLegacyColumns(message, {
    id: message.id,
    role: 'assistant',
    content: cloneValue(message.content),
    providerId: message.providerId,
    model: message.model,
    tokenUsage: message.tokenUsage ? cloneValue(message.tokenUsage) : undefined,
    timestamp: message.timestamp,
    metadata: cloneMetadata(message.metadata),
  });
}

function nativeToolResultToLegacy(message: Message): Message {
  const toolResult = Array.isArray(message.content)
    ? message.content.find(
        (block) => block.type === 'tool_result',
      )
    : undefined;
  return augmentLegacyColumns(message, {
    id: message.id,
    role: 'tool',
    name: message.name,
    tool_call_id: message.tool_call_id ?? toolResult?.tool_use_id,
    content: Array.isArray(message.content)
      ? cloneValue(message.content)
      : cloneValue([
          {
            type: 'tool_result' as const,
            tool_use_id: message.tool_call_id ?? '',
            content: message.content,
            is_error: false,
          },
        ]),
    timestamp: message.timestamp,
    metadata: cloneMetadata(message.metadata),
  });
}

function nativeRuntimeContextToLegacy(message: RuntimeContextMessage): Message {
  const baseMetadata = cloneMetadata(message.metadata);
  return {
    id: message.id,
    role: 'user',
    content: cloneValue(message.content),
    // msg_type lets the adapter's runtimeSource() recover the source on
    // reverse conversion, so a native runtime_context round-trips back to a
    // runtime_context AgentMessage instead of a plain user message.
    msg_type: message.source,
    timestamp: message.timestamp,
    metadata: { ...(baseMetadata ?? {}), runtimeContext: true, source: message.source },
  };
}

function nativeCompactionSummaryToLegacy(
  message: CompactionSummaryMessage,
): Message {
  return {
    id: message.id,
    role: 'user',
    content: message.summary,
    isCompactSummary: true,
    compactBoundaryId: message.compactionEntryId,
    compactedMessageCount: message.tokensBefore,
    timestamp: message.timestamp,
    metadata: cloneMetadata(message.metadata),
  };
}

function toBoundaryMessage(
  message: AgentMessage,
): Message | null {
  const role = (message as { role?: string }).role;

  // user/assistant/tool are lossless via the native projection: ingest keeps
  // every field the DB row mapping produces, so the row is rebuilt natively.
  switch (role) {
    case 'user':
      return nativeUserToLegacy(message as Message);
    case 'assistant':
      return nativeAssistantToLegacy(message as Message);
    case 'tool':
      return nativeToolResultToLegacy(message as Message);
    case 'runtime_context':
      return nativeRuntimeContextToLegacy(message as RuntimeContextMessage);
    case 'compaction_summary':
      return nativeCompactionSummaryToLegacy(message as CompactionSummaryMessage);
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
        role: marker.payload.role,
        content: cloneValue(marker.payload.content),
        timestamp: marker.timestamp,
      } as unknown as Message;
    }
    default:
      return null;
  }
}

// ─── Persistence boundary ────────────────────────────────────────────────

/**
 * Projects the durable subset of AgentMessages to the legacy `Message[]`
 * shape for DB persistence, IPC DTOs, and SSE events. Transient messages
 * (mailbox, background notifications, etc.) are always excluded. This is
 * independent of `visibility` and `includeInModel`.
 */
export function projectPersistenceMessages(
  messages: readonly AgentMessage[],
): Message[] {
  const result: Message[] = [];
  for (const message of messages) {
    const legacy = toBoundaryMessage(message);
    if (legacy) {
      result.push(legacy);
    }
  }
  return result;
}

/**
 * JSON-compatible checkpoint carried in the existing legacy Message[] store.
 * This deliberately avoids a schema migration: a compacted history is stored
 * as one durable marker followed by its retained suffix.
 */
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

const COMPACTION_CHECKPOINT_METADATA_KEY = 'duyaCompactionCheckpoint';
export const COMPACTION_CHECKPOINT_MESSAGE_TYPE = 'compact_checkpoint';

function checkpointForEntry(entry: CompactionEntry): LegacyCompactionCheckpoint {
  return {
    version: 1,
    id: entry.id,
    createdAt: entry.createdAt,
    firstKeptMessageId: entry.firstKeptMessageId,
    compactedMessageIds: [...entry.compactedMessageIds],
    tokensBefore: entry.tokensBefore,
    tokensAfter: entry.tokensAfter,
    strategy: entry.strategy,
    previousCompactionId: entry.previousCompactionId,
    reinjectedSystemMessages: entry.reinjectedSystemMessages
      ? cloneValue(entry.reinjectedSystemMessages)
      : undefined,
  };
}

function isCheckpoint(value: unknown): value is LegacyCompactionCheckpoint {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const checkpoint = value as Record<string, unknown>;
  return (
    checkpoint.version === 1 &&
    typeof checkpoint.id === 'string' &&
    typeof checkpoint.createdAt === 'number' &&
    typeof checkpoint.firstKeptMessageId === 'string' &&
    Array.isArray(checkpoint.compactedMessageIds) &&
    checkpoint.compactedMessageIds.every((id) => typeof id === 'string') &&
    typeof checkpoint.tokensBefore === 'number' &&
    typeof checkpoint.strategy === 'string'
  );
}

/** Read a Plan 315 checkpoint marker from durable fields or old memory DTOs. */
export function getLegacyCompactionCheckpoint(
  message: Message,
): LegacyCompactionCheckpoint | undefined {
  if (message.msg_type === COMPACTION_CHECKPOINT_MESSAGE_TYPE && message.tool_input) {
    try {
      const checkpoint = JSON.parse(message.tool_input) as unknown;
      if (isCheckpoint(checkpoint)) {
        return cloneValue(checkpoint);
      }
    } catch {
      return undefined;
    }
  }
  const metadataCheckpoint = message.metadata?.[COMPACTION_CHECKPOINT_METADATA_KEY];
  return isCheckpoint(metadataCheckpoint) ? cloneValue(metadataCheckpoint) : undefined;
}

/**
 * Projects a complete timeline for durable storage. A checkpoint replaces its
 * raw compacted prefix with one marker plus the retained suffix, so a DB reload
 * has enough information to rebuild the same append-only projection.
 */
export function projectTimelinePersistenceMessages(
  entries: readonly MessageTimelineEntry[],
): Message[] {
  const projection = buildAgentContext(entries);
  if (!projection.compaction) {
    return projectPersistenceMessages(projection.messages);
  }
  const checkpoint = checkpointForEntry(projection.compaction);
  const marker: Message = {
    id: `${checkpoint.id}:checkpoint`,
    role: 'system',
    content: projection.compaction.summary,
    isCompactSummary: true,
    compactBoundaryId: checkpoint.id,
    compactedMessageCount: checkpoint.compactedMessageIds.length,
    timestamp: checkpoint.createdAt,
    msg_type: COMPACTION_CHECKPOINT_MESSAGE_TYPE,
    tool_input: JSON.stringify(checkpoint),
  };
  return [
    marker,
    ...projectPersistenceMessages(
      projection.messages.filter((message) => message.role !== 'compaction_summary'),
    ),
  ];
}

// ─── Transcript boundary ─────────────────────────────────────────────────

/**
 * Projects the visible subset of AgentMessages to the legacy `Message[]`
 * shape for renderer display. Hidden messages (mailbox, background
 * notifications, etc.) are always excluded. This is independent of
 * `persistence` and `includeInModel`, and it does NOT reuse the provider
 * projector: the transcript owns its own conversion path.
 */
export function projectTranscriptMessages(
  messages: readonly AgentMessage[],
): Message[] {
  const result: Message[] = [];
  for (const message of messages) {
    if ((message as { visibility?: AgentMessageVisibility }).visibility !== 'visible') {
      continue;
    }
    const legacy = toBoundaryMessage(message);
    if (legacy) {
      result.push(legacy);
    }
  }
  return result;
}