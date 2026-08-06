import type { Message, MessageContent, TokenUsage, ToolResultContent } from '../types.js';
import { cloneValue } from './message-framework.js';
import type {
  AgentMessage,
  AgentMessageContent,
  AgentMessageVisibility,
  CompactionSummaryMessage,
  LegacyCompactionBoundaryMessage,
  LegacySystemMessage,
  LegacyUnknownRoleMessage,
  RuntimeContextMessage,
  RuntimeContextSource,
} from './message-framework.js';

/**
 * Centralized AgentMessage construction.
 *
 * The DuyaAgent runtime historically hand-rolled every `messages.push({...})`
 * with inline `crypto.randomUUID()` / `Date.now()` calls (twelve push sites).
 * This factory is the single source of truth for new-domain AgentMessage
 * creation: callers inject the id generator and clock so tests and deterministic
 * flows can substitute their own, while production wires the Node defaults.
 *
 * User / assistant / tool turns are produced as the flat provider {@link Message}
 * (role, id, timestamp, visibility). Runtime context and compaction summaries
 * are produced as the framework's custom message types.
 */

export type AgentMessageIdGenerator = () => string;
export type AgentMessageClock = () => number;

export interface AgentMessageFactoryOptions {
  readonly idGenerator?: AgentMessageIdGenerator;
  readonly clock?: AgentMessageClock;
}

/**
 * Runtime-only fields carried over from the legacy `Message` record. They have
 * no dedicated slot on the provider `Message`, so the factory stores them on
 * `metadata` under the {@link AGENT_MESSAGE_METADATA_KEYS} keys.
 */
export interface AgentMessageRuntimeFields {
  readonly seqIndex?: number;
  readonly durationMs?: number;
  readonly status?: string;
  readonly stopReason?: string;
}

export const AGENT_MESSAGE_METADATA_KEYS = {
  seqIndex: 'seqIndex',
  durationMs: 'durationMs',
  status: 'status',
  stopReason: 'stopReason',
} as const;

function defaultIdGenerator(): string {
  return crypto.randomUUID();
}

function defaultClock(): number {
  return Date.now();
}

/**
 * Merges runtime-only fields into a base metadata record, returning a frozen
 * merged record. Returns `undefined` when neither base nor runtime fields are
 * present so the created message omits `metadata` entirely.
 */
export function mergeRuntimeMetadata(
  base: Readonly<Record<string, unknown>> | undefined,
  runtime: AgentMessageRuntimeFields,
): Readonly<Record<string, unknown>> | undefined {
  const hasRuntime =
    runtime.seqIndex !== undefined ||
    runtime.durationMs !== undefined ||
    runtime.status !== undefined ||
    runtime.stopReason !== undefined;
  if (!base && !hasRuntime) return undefined;

  const merged: Record<string, unknown> = { ...(base ?? {}) };
  if (runtime.seqIndex !== undefined) {
    merged[AGENT_MESSAGE_METADATA_KEYS.seqIndex] = runtime.seqIndex;
  }
  if (runtime.durationMs !== undefined) {
    merged[AGENT_MESSAGE_METADATA_KEYS.durationMs] = runtime.durationMs;
  }
  if (runtime.status !== undefined) {
    merged[AGENT_MESSAGE_METADATA_KEYS.status] = runtime.status;
  }
  if (runtime.stopReason !== undefined) {
    merged[AGENT_MESSAGE_METADATA_KEYS.stopReason] = runtime.stopReason;
  }
  return Object.freeze(merged);
}

export interface CreateUserMessageInput {
  readonly content: AgentMessageContent;
  readonly displayContent?: AgentMessageContent;
  readonly attachments?: readonly unknown[];
  readonly seqIndex?: number;
  readonly metadata?: Readonly<Record<string, unknown>>;
  readonly visibility?: AgentMessageVisibility;
}

export interface CreateAssistantMessageInput {
  readonly content: AgentMessageContent;
  readonly providerId?: string;
  readonly model?: string;
  readonly tokenUsage?: TokenUsage;
  readonly stopReason?: string;
  readonly durationMs?: number;
  readonly status?: string;
  readonly seqIndex?: number;
  readonly metadata?: Readonly<Record<string, unknown>>;
  readonly visibility?: AgentMessageVisibility;
}

export interface CreateToolResultMessageInput {
  readonly toolCallId: string;
  readonly toolName: string;
  readonly content: AgentMessageContent;
  readonly isError: boolean;
  readonly durationMs?: number;
  readonly status?: string;
  readonly seqIndex?: number;
  readonly metadata?: Readonly<Record<string, unknown>>;
  readonly visibility?: AgentMessageVisibility;
}

export interface CreateRuntimeContextMessageInput {
  readonly source: RuntimeContextSource;
  readonly content: AgentMessageContent;
  readonly seqIndex?: number;
  readonly metadata?: Readonly<Record<string, unknown>>;
  readonly visibility?: AgentMessageVisibility;
}

export interface CreateCompactionSummaryMessageInput {
  readonly summary: string;
  readonly compactionEntryId: string;
  readonly tokensBefore: number;
  readonly tokensAfter?: number;
  readonly seqIndex?: number;
  readonly metadata?: Readonly<Record<string, unknown>>;
  readonly visibility?: AgentMessageVisibility;
}

export class AgentMessageFactory {
  private readonly idGenerator: AgentMessageIdGenerator;
  private readonly clock: AgentMessageClock;

  constructor(options: AgentMessageFactoryOptions = {}) {
    this.idGenerator = options.idGenerator ?? defaultIdGenerator;
    this.clock = options.clock ?? defaultClock;
  }

  /**
   * User turn. `content` is model-facing; `displayContent` is the optional
   * UI-facing override. Attachments stay on the user message and are never
   * copied into a separate user message.
   */
  createUserMessage(input: CreateUserMessageInput): Message {
    const metadata = mergeRuntimeMetadata(input.metadata, {
      seqIndex: input.seqIndex,
    });
    const message: Message = {
      role: 'user',
      id: this.idGenerator(),
      timestamp: this.clock(),
      visibility: input.visibility ?? 'visible',
      content: input.content,
    };
    if (input.displayContent !== undefined) {
      message.displayContent = input.displayContent;
    }
    if (input.attachments !== undefined) {
      message.attachments = [...input.attachments];
    }
    if (metadata !== undefined) {
      message.metadata = metadata;
    }
    return message;
  }

  /**
   * Assistant turn. The thinking signature, tool_use ids, and provider
   * signatures live inside the `content` blocks (MessageContent[]) and are
   * preserved verbatim. `providerId`, `model`, and `tokenUsage` are first-class
   * fields. `stopReason`, `durationMs`, `status`, `seqIndex` are runtime-only
   * and stored on `metadata`.
   */
  createAssistantMessage(input: CreateAssistantMessageInput): Message {
    const metadata = mergeRuntimeMetadata(input.metadata, {
      seqIndex: input.seqIndex,
      durationMs: input.durationMs,
      status: input.status,
      stopReason: input.stopReason,
    });
    const message: Message = {
      role: 'assistant',
      id: this.idGenerator(),
      timestamp: this.clock(),
      visibility: input.visibility ?? 'visible',
      content: input.content,
    };
    if (input.providerId !== undefined) message.providerId = input.providerId;
    if (input.model !== undefined) message.model = input.model;
    if (input.tokenUsage !== undefined) message.tokenUsage = input.tokenUsage;
    if (metadata !== undefined) message.metadata = metadata;
    return message;
  }

  /**
   * Tool result. `toolCallId` pairs the result back to the originating
   * `tool_use` block. `isError` marks error results (including the synthetic
   * tool_result emitted when a generation is interrupted mid-stream).
   */
  createToolResultMessage(input: CreateToolResultMessageInput): Message {
    const metadata = mergeRuntimeMetadata(input.metadata, {
      seqIndex: input.seqIndex,
      durationMs: input.durationMs,
      status: input.status,
    });
    const message: Message = {
      role: 'tool',
      id: this.idGenerator(),
      timestamp: this.clock(),
      visibility: input.visibility ?? 'visible',
      name: input.toolName,
      tool_call_id: input.toolCallId,
      content: [
        {
          type: 'tool_result',
          tool_use_id: input.toolCallId,
          content: input.content,
          is_error: input.isError,
        },
      ],
    };
    if (metadata !== undefined) message.metadata = metadata;
    return message;
  }

  /**
   * Runtime context (AGENTS.md, mailbox, background notification, mode, memory,
   * attachment, system).
   */
  createRuntimeContextMessage(input: CreateRuntimeContextMessageInput): RuntimeContextMessage {
    const metadata = mergeRuntimeMetadata(input.metadata, {
      seqIndex: input.seqIndex,
    });
    const message: RuntimeContextMessage = {
      role: 'runtime_context',
      id: this.idGenerator(),
      timestamp: this.clock(),
      visibility: input.visibility ?? 'visible',
      source: input.source,
      content: input.content,
    };
    if (metadata !== undefined) message.metadata = metadata;
    return message;
  }

  /**
   * Compaction summary that stands in for compacted history. Defaults to
   * `visible` visibility since the summary must render in the transcript.
   */
  createCompactionSummaryMessage(input: CreateCompactionSummaryMessageInput): CompactionSummaryMessage {
    const metadata = mergeRuntimeMetadata(input.metadata, {
      seqIndex: input.seqIndex,
    });
    const message: CompactionSummaryMessage = {
      role: 'compaction_summary',
      id: this.idGenerator(),
      timestamp: this.clock(),
      visibility: input.visibility ?? 'visible',
      summary: input.summary,
      compactionEntryId: input.compactionEntryId,
      tokensBefore: input.tokensBefore,
    };
    if (input.tokensAfter !== undefined) message.tokensAfter = input.tokensAfter;
    if (metadata !== undefined) message.metadata = metadata;
    return message;
  }
}

// ─── Persistence-row ingest (Message -> AgentMessage) ───────────────────

/**
 * Direct ingest of a provider/persistence-shaped {@link Message} into the
 * AgentMessage domain. Replaces the old envelope-based legacy adapter: the
 * conversion keeps every field the DB row mapping produces (see
 * LEGACY_KNOWN_KEYS), and the boundary projectors rebuild the durable shape
 * natively, so no sidecar envelope is needed for losslessness.
 *
 * Role mapping:
 * - user / assistant / tool turns stay flat provider Messages
 * - isCompactBoundary markers become legacy_compaction_boundary
 * - isCompactSummary rows become compaction_summary
 * - role 'system' becomes legacy_system (content feeds the system prompt)
 * - runtime rows (mailbox / task notification / attachment / mode / memory)
 *   become runtime_context with hidden visibility where applicable
 * - anything else becomes legacy_unknown_role
 */

/**
 * Fields the AgentMessage domain models for user / assistant / tool turns
 * (the durable columns plus the flat provider `Message` fields). Ingest
 * copies only these known fields onto the AgentMessage; they are exactly the
 * fields `messageRowToMessage` (session/db.ts) can produce, so the
 * persistence projector can rebuild the row natively.
 */
const LEGACY_KNOWN_KEYS = [
  'name',
  'tool_call_id',
  'msg_type',
  'thinking',
  'tool_name',
  'tool_input',
  'parent_tool_call_id',
  'viz_spec',
  'status',
  'seq_index',
  'duration_ms',
  'sub_agent_id',
  'attachments',
  'displayContent',
  'isCompactBoundary',
  'isCompactSummary',
  'compactedMessageCount',
  'compactedMessageIds',
  'compactBoundaryId',
  'tokenUsage',
  'providerId',
  'model',
  'api',
] as const;

/**
 * Copies the known modeled fields (excluding `content`, `metadata`, `id`,
 * `role`, `timestamp`, `visibility`, which each branch sets explicitly) onto
 * a fresh object. Fields that are absent on the source are omitted.
 */
function pickKnown(message: Message): Record<string, unknown> {
  const source = message as Message & Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const key of LEGACY_KNOWN_KEYS) {
    const value = source[key];
    if (value !== undefined) out[key] = value;
  }
  return out;
}

function isRuntimeMetadata(metadata: Record<string, unknown> | undefined): boolean {
  return metadata?.runtimeContext === true;
}

function runtimeSource(message: Message): RuntimeContextSource | undefined {
  const type = message.msg_type?.toLowerCase();
  if (type === 'mailbox' || type === 'runtime_context') return 'mailbox';
  if (type === 'task-notification' || type === 'task_notification') {
    return 'background_notification';
  }
  if (type === 'attachment') return 'attachment';
  if (type === 'mode' || type === 'mode_changed') return 'mode';
  if (type === 'memory') return 'memory';
  if (isRuntimeMetadata(message.metadata)) return 'custom';
  return undefined;
}

function contentToText(content: AgentMessageContent): string {
  if (typeof content === 'string') return content;

  return content.map((block) => {
    if (block.type === 'text') return block.text;
    if (block.type === 'thinking') return block.thinking;
    if (block.type === 'tool_result') {
      return contentToText(block.content);
    }
    return JSON.stringify(block);
  }).join('\n');
}

function findToolResult(content: AgentMessageContent): ToolResultContent | undefined {
  if (!Array.isArray(content)) return undefined;
  return content.find((block): block is ToolResultContent => block.type === 'tool_result');
}

function ingestMetadata(message: Message): Readonly<Record<string, unknown>> {
  const metadata = message.metadata ? cloneValue(message.metadata) : {};
  return Object.freeze({ ...metadata });
}

interface IngestBaseFields {
  id: string;
  timestamp: number;
  visibility: 'visible' | 'hidden';
  metadata: Readonly<Record<string, unknown>>;
}

function ingestBaseFields(message: Message, index: number): IngestBaseFields {
  const source = runtimeSource(message);
  const id = message.id || `legacy-message-${index}`;
  return {
    id,
    timestamp: message.timestamp ?? 0,
    visibility: source === 'mailbox' || source === 'background_notification' || source === 'attachment'
      ? 'hidden'
      : 'visible',
    metadata: ingestMetadata(message),
  };
}

export interface IngestMessageOptions {
  /**
   * Used only to derive stable synthetic Agent ids for rows that do not
   * have an id.
   */
  readonly index?: number;
}

/**
 * Converts one persistence-shaped Message to a semantically useful
 * AgentMessage. The input message is never mutated.
 */
export function ingestMessage(
  message: Message,
  options: IngestMessageOptions = {},
): AgentMessage {
  const index = options.index ?? 0;
  const base = ingestBaseFields(message, index);
  const content = cloneValue(message.content);

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
        compactedMessageIds: message.compactedMessageIds
          ? [...message.compactedMessageIds]
          : undefined,
      },
    };
    return boundary;
  }

  if (message.isCompactSummary) {
    const summaryMessage: CompactionSummaryMessage = {
      role: 'compaction_summary',
      id: base.id,
      timestamp: base.timestamp,
      visibility: base.visibility,
      summary: contentToText(content),
      compactionEntryId: message.compactBoundaryId ?? base.id,
      tokensBefore: message.compactedMessageCount ?? 0,
    };
    if (Object.keys(base.metadata).length > 0) {
      summaryMessage.metadata = base.metadata;
    }
    return summaryMessage;
  }

  if (message.role === 'system') {
    const systemMessage: LegacySystemMessage = {
      role: 'legacy_system',
      id: base.id,
      timestamp: base.timestamp,
      visibility: base.visibility,
      payload: {
        content,
        name: message.name,
      },
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
    if (Object.keys(base.metadata).length > 0) {
      runtimeMessage.metadata = base.metadata;
    }
    return runtimeMessage;
  }

  if (message.role === 'user') {
    const userMessage: Message & Record<string, unknown> = {
      ...pickKnown(message),
      id: message.id,
      timestamp: base.timestamp,
      visibility: base.visibility,
      role: 'user',
      content: cloneValue(message.content),
      metadata: base.metadata,
    };
    return userMessage;
  }

  if (message.role === 'assistant') {
    const stopReason = (message as Message & Record<string, unknown>).stopReason;
    const assistantMessage: Message & Record<string, unknown> = {
      ...pickKnown(message),
      id: message.id,
      timestamp: base.timestamp,
      visibility: base.visibility,
      role: 'assistant',
      content: cloneValue(message.content),
      metadata: base.metadata,
    };
    if (typeof stopReason === 'string') {
      assistantMessage.metadata = { ...(base.metadata ?? {}), stopReason };
    }
    return assistantMessage;
  }

  if (message.role === 'tool') {
    const toolMessage: Message & Record<string, unknown> = {
      ...pickKnown(message),
      id: message.id,
      timestamp: base.timestamp,
      visibility: base.visibility,
      role: 'tool',
      content: cloneValue(message.content),
      metadata: base.metadata,
      name: message.name ?? message.tool_name ?? 'legacy-tool',
      tool_call_id: message.tool_call_id ?? findToolResult(content)?.tool_use_id ?? `legacy-tool-call-${index}`,
    };
    return toolMessage;
  }

  const unknownMessage: LegacyUnknownRoleMessage = {
    role: 'legacy_unknown_role',
    id: base.id,
    timestamp: base.timestamp,
    visibility: base.visibility,
    payload: {
      role: String((message as Message & Record<string, unknown>).role),
      content,
    },
  };
  return unknownMessage;
}

/**
 * Converts a persisted history without mutating either the input array or
 * any input message. Rows without an id receive deterministic, index-based
 * Agent ids.
 */
export function ingestMessages(
  messages: readonly Message[],
): AgentMessage[] {
  return messages.map((message, index) => ingestMessage(message, { index }));
}