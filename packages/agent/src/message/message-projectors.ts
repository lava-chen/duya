import type { Message, MessageContent } from '../types.js';
import {
  toModelMessages,
  type AgentCustomMessage,
  type AgentMessage,
  type AssistantAgentMessage,
  type CompactionSummaryAgentMessage,
  type CustomMessageProjector,
  type PromptSegment,
  type RuntimeContextAgentMessage,
  type ToolResultAgentMessage,
  type UserAgentMessage,
  type CompactionEntry,
  type MessageTimelineEntry,
  buildAgentContext,
} from './message-framework.js';
import {
  agentMessageToLegacyMessage,
  hasLegacyEnvelope,
  type LegacyAgentMessage,
} from './legacy-message-adapter.js';

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
 * deterministic output for a given input. Legacy-adapted messages are
 * restored losslessly via the adapter envelope; native AgentMessages are
 * projected by kind without requiring a sidecar.
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
   * Provider messages in order. Includes `includeInModel` runtime context and
   * compaction summaries as user-role turns; excludes `includeInModel=false`
   * runtime context and custom messages without a projector.
   */
  readonly messages: readonly Message[];
}

export interface ProjectModelMessagesOptions<TCustom extends AgentCustomMessage> {
  /** System segments merged into the system prompt. */
  readonly systemSegments?: readonly PromptSegment[];
  /** Custom-message projector for the model boundary. */
  readonly projectCustom?: CustomMessageProjector<TCustom>;
}

/**
 * Projects AgentMessages to the provider boundary: a separate system prompt
 * plus a `Message[]` ready for the model. The model boundary is gated only by
 * `includeInModel`; it is independent of `persistence` and `visibility`.
 */
export function projectModelMessages<TCustom extends AgentCustomMessage = never>(
  messages: readonly AgentMessage<TCustom>[],
  options: ProjectModelMessagesOptions<TCustom> = {},
): ModelMessageProjection {
  const providerMessages: Message[] = [];
  for (const message of messages) {
    // Custom messages: project via projectCustom; legacy marker kinds never
    // carry model content and are excluded from the model boundary.
    if (message.kind.startsWith('custom:')) {
      const custom = message as TCustom;
      if (
        message.kind === 'custom:legacy-compaction-boundary' ||
        message.kind === 'custom:legacy-unknown-role'
      ) {
        continue;
      }
      if (options.projectCustom) {
        const projected = options.projectCustom(custom);
        if (Array.isArray(projected)) {
          providerMessages.push(...projected);
        } else if (projected) {
          providerMessages.push(projected as Message);
        }
      }
      continue;
    }

    // Compaction summary: model boundary adds instructional framing
    if (message.kind === 'compaction_summary') {
      providerMessages.push({
        id: message.id,
        role: 'user',
        content: [
          'Another agent continued this task and produced the following context summary.',
          'Use it as prior context without repeating completed work.',
          '',
          message.summary,
        ].join('\n'),
        timestamp: message.createdAt,
        isCompactSummary: true,
        compactBoundaryId: message.compactionEntryId,
      });
      continue;
    }

    // All other messages: unified boundary converter handles both
    // legacy-envelope (agentMessageToLegacyMessage) and native (kind-specific).
    // Custom messages are handled above, so the projector is only a fallback
    // for the default branch, which is unreachable here.
    const legacy = toBoundaryMessage(
      message,
      options.projectCustom as NativeCustomToLegacyProjector<TCustom> | undefined,
    );
    if (legacy) {
      providerMessages.push(legacy);
    }
  }
  const system = mergeSystemSegments(options.systemSegments);
  return { system, messages: providerMessages };
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
 * Legacy system messages (role='system' in the DB) are adapted to
 * `custom:legacy-system` AgentMessages. `projectModelMessages` skips all
 * `custom:*` kinds, so their content would be lost without this extraction.
 * Compaction entries may carry `reinjectedSystemMessages` that also belong
 * in the system prompt.
 *
 * @param messages - AgentMessage[] from buildAgentContext
 * @param compaction - Optional CompactionEntry from buildAgentContext
 * @returns PromptSegment[] for use with projectModelMessages
 */
export function extractLegacySystemSegments<TCustom extends AgentCustomMessage = AgentCustomMessage>(
  messages: readonly AgentMessage<TCustom>[],
  compaction?: { readonly id: string; readonly reinjectedSystemMessages?: readonly (string | readonly MessageContent[])[] } | null,
): PromptSegment[] {
  const segments: PromptSegment[] = [];

  for (const message of messages) {
    if (message.kind === 'custom:legacy-system') {
      // LegacySystemAgentMessage has payload.content with the system text
      const payload = (message as { payload?: { content?: unknown } }).payload;
      if (payload?.content) {
        segments.push({
          id: message.id,
          contributorId: 'legacy-system',
          placement: 'history-prefix' as const,
          content: payload.content as string | readonly MessageContent[],
        });
      }
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

/**
 * Projects a native custom AgentMessage to the legacy `Message` shape at the
 * persistence/transcript boundaries. Returning `null` drops the message.
 */
export type NativeCustomToLegacyProjector<TCustom extends AgentCustomMessage> = (
  message: TCustom,
) => Message | null;

export interface ProjectBoundaryOptions<TCustom extends AgentCustomMessage> {
  /**
   * Optional projector for native custom messages. When omitted, native
   * custom messages are preserved as a user-role `Message` with the payload
   * serialized into `metadata` so nothing is silently lost at the boundary.
   */
  readonly projectCustomToLegacy?: NativeCustomToLegacyProjector<TCustom>;
}

function cloneValue<T>(value: T): T {
  return structuredClone(value);
}

function cloneMetadata(
  metadata: Readonly<Record<string, unknown>> | undefined,
): Record<string, unknown> | undefined {
  return metadata ? cloneValue(metadata) : undefined;
}

function nativeUserToLegacy(message: UserAgentMessage): Message {
  return {
    id: message.id,
    role: 'user',
    content: cloneValue(message.content),
    displayContent: message.displayContent !== undefined
      ? cloneValue(message.displayContent)
      : undefined,
    attachments: message.attachments
      ? (cloneValue(message.attachments) as unknown[])
      : undefined,
    timestamp: message.createdAt,
    metadata: cloneMetadata(message.metadata),
  };
}

function nativeAssistantToLegacy(message: AssistantAgentMessage): Message {
  const baseMetadata = cloneMetadata(message.metadata);
  const metadata =
    message.stopReason !== undefined
      ? { ...(baseMetadata ?? {}), stopReason: message.stopReason }
      : baseMetadata;
  return {
    id: message.id,
    role: 'assistant',
    content: cloneValue(message.content),
    providerId: message.providerId,
    model: message.model,
    tokenUsage: message.tokenUsage ? cloneValue(message.tokenUsage) : undefined,
    timestamp: message.createdAt,
    metadata,
  };
}

function nativeToolResultToLegacy(message: ToolResultAgentMessage): Message {
  return {
    id: message.id,
    role: 'tool',
    name: message.toolName,
    tool_call_id: message.toolCallId,
    content: [
      {
        type: 'tool_result',
        tool_use_id: message.toolCallId,
        content: cloneValue(message.content),
        is_error: message.isError,
      },
    ],
    timestamp: message.createdAt,
    metadata: cloneMetadata(message.metadata),
  };
}

function nativeRuntimeContextToLegacy(message: RuntimeContextAgentMessage): Message {
  const baseMetadata = cloneMetadata(message.metadata);
  return {
    id: message.id,
    role: 'user',
    content: cloneValue(message.content),
    // msg_type lets the adapter's runtimeSource() recover the source on
    // reverse conversion, so a native runtime_context round-trips back to a
    // runtime_context AgentMessage instead of a plain user message.
    msg_type: message.source,
    timestamp: message.createdAt,
    metadata: { ...(baseMetadata ?? {}), runtimeContext: true, source: message.source },
  };
}

function nativeCompactionSummaryToLegacy(
  message: CompactionSummaryAgentMessage,
): Message {
  return {
    id: message.id,
    role: 'user',
    content: message.summary,
    isCompactSummary: true,
    compactBoundaryId: message.compactionEntryId,
    compactedMessageCount: message.tokensBefore,
    timestamp: message.createdAt,
    metadata: cloneMetadata(message.metadata),
  };
}

function toBoundaryMessage<TCustom extends AgentCustomMessage>(
  message: AgentMessage<TCustom>,
  projectCustomToLegacy: NativeCustomToLegacyProjector<TCustom> | undefined,
): Message | null {
  // Legacy-adapted messages always win: the adapter envelope is the only
  // lossless source of provider state, signatures, and unknown DB fields.
  if (hasLegacyEnvelope(message)) {
    return agentMessageToLegacyMessage(message as unknown as LegacyAgentMessage);
  }

  // `hasLegacyEnvelope` is a type guard that narrows the negated branch to
  // custom-only kinds. Re-widen to the full union so the switch below can
  // discriminate all core kinds.
  const nativeMessage = message as AgentMessage<TCustom>;

  switch (nativeMessage.kind) {
    case 'user':
      return nativeUserToLegacy(nativeMessage);
    case 'assistant':
      return nativeAssistantToLegacy(nativeMessage);
    case 'tool_result':
      return nativeToolResultToLegacy(nativeMessage);
    case 'runtime_context':
      return nativeRuntimeContextToLegacy(nativeMessage);
    case 'compaction_summary':
      return nativeCompactionSummaryToLegacy(nativeMessage);
    default: {
      // Native custom message. An explicit projector wins; otherwise preserve
      // the payload in metadata so the message is never silently dropped at
      // the persistence/transcript boundary.
      if (projectCustomToLegacy) {
        return projectCustomToLegacy(message);
      }
      return {
        id: message.id,
        role: 'user',
        content: JSON.stringify(message.payload),
        timestamp: message.createdAt,
        metadata: {
          ...(cloneMetadata(message.metadata) ?? {}),
          duyaCustomKind: message.kind,
          duyaCustomPayload: cloneValue(message.payload),
        },
      };
    }
  }
}

// ─── Persistence boundary ────────────────────────────────────────────────

/**
 * Projects the durable subset of AgentMessages to the legacy `Message[]`
 * shape for DB persistence, IPC DTOs, and SSE events. Transient messages
 * (mailbox, background notifications, etc.) are always excluded. This is
 * independent of `visibility` and `includeInModel`.
 */
export function projectPersistenceMessages<TCustom extends AgentCustomMessage = never>(
  messages: readonly AgentMessage<TCustom>[],
  options: ProjectBoundaryOptions<TCustom> = {},
): Message[] {
  const result: Message[] = [];
  for (const message of messages) {
    const legacy = toBoundaryMessage(message, options.projectCustomToLegacy);
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
export function projectTimelinePersistenceMessages<
  TCustom extends AgentCustomMessage = never,
>(
  entries: readonly MessageTimelineEntry<TCustom>[],
  options: ProjectBoundaryOptions<TCustom> = {},
): Message[] {
  const projection = buildAgentContext(entries);
  if (!projection.compaction) {
    return projectPersistenceMessages(projection.messages, options);
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
      projection.messages.filter((message) => message.kind !== 'compaction_summary'),
      options,
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
export function projectTranscriptMessages<TCustom extends AgentCustomMessage = never>(
  messages: readonly AgentMessage<TCustom>[],
  options: ProjectBoundaryOptions<TCustom> = {},
): Message[] {
  const result: Message[] = [];
  for (const message of messages) {
    if (message.visibility !== 'visible') {
      continue;
    }
    const legacy = toBoundaryMessage(message, options.projectCustomToLegacy);
    if (legacy) {
      result.push(legacy);
    }
  }
  return result;
}
