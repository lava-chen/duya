import type { TokenUsage } from '../types.js';
import type {
  AgentMessageContent,
  AgentMessageVisibility,
  AssistantAgentMessage,
  CompactionSummaryAgentMessage,
  RuntimeContextAgentMessage,
  RuntimeContextSource,
  ToolResultAgentMessage,
  UserAgentMessage,
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
 * Runtime-only fields that the AgentMessage domain does not model as
 * first-class properties (`seq_index`, `duration_ms`, `status`) are preserved
 * on {@link AgentMessageBase.metadata} under stable keys so they survive a
 * round-trip through the new domain without widening the core type union.
 */

export type AgentMessageIdGenerator = () => string;
export type AgentMessageClock = () => number;

export interface AgentMessageFactoryOptions {
  readonly idGenerator?: AgentMessageIdGenerator;
  readonly clock?: AgentMessageClock;
}

/**
 * Runtime-only fields carried over from the legacy `Message` record. They have
 * no dedicated slot on the AgentMessage union, so the factory stores them on
 * `metadata` under the {@link AGENT_MESSAGE_METADATA_KEYS} keys.
 */
export interface AgentMessageRuntimeFields {
  readonly seqIndex?: number;
  readonly durationMs?: number;
  readonly status?: string;
}

export const AGENT_MESSAGE_METADATA_KEYS = {
  seqIndex: 'seqIndex',
  durationMs: 'durationMs',
  status: 'status',
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
    runtime.status !== undefined;
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
   * UI-facing override. Attachments stay on the UserAgentMessage and are never
   * copied into a separate user message.
   */
  createUserMessage(input: CreateUserMessageInput): UserAgentMessage {
    const metadata = mergeRuntimeMetadata(input.metadata, {
      seqIndex: input.seqIndex,
    });
    const message: UserAgentMessage = {
      kind: 'user',
      id: this.idGenerator(),
      createdAt: this.clock(),
      visibility: input.visibility ?? 'visible',
      content: input.content,
    };
    if (input.displayContent !== undefined) {
      message.displayContent = input.displayContent;
    }
    if (input.attachments !== undefined) {
      message.attachments = input.attachments;
    }
    if (metadata !== undefined) {
      message.metadata = metadata;
    }
    return message;
  }

  /**
   * Assistant turn. The thinking signature, tool_use ids, and provider
   * signatures live inside the `content` blocks (MessageContent[]) and are
   * preserved verbatim. `providerId`, `model`, `tokenUsage`, and `stopReason`
   * are first-class fields. `durationMs`, `status`, `seqIndex` are runtime-only
   * and stored on `metadata`.
   */
  createAssistantMessage(input: CreateAssistantMessageInput): AssistantAgentMessage {
    const metadata = mergeRuntimeMetadata(input.metadata, {
      seqIndex: input.seqIndex,
      durationMs: input.durationMs,
      status: input.status,
    });
    const message: AssistantAgentMessage = {
      kind: 'assistant',
      id: this.idGenerator(),
      createdAt: this.clock(),
      visibility: input.visibility ?? 'visible',
      content: input.content,
    };
    if (input.providerId !== undefined) message.providerId = input.providerId;
    if (input.model !== undefined) message.model = input.model;
    if (input.tokenUsage !== undefined) message.tokenUsage = input.tokenUsage;
    if (input.stopReason !== undefined) message.stopReason = input.stopReason;
    if (metadata !== undefined) message.metadata = metadata;
    return message;
  }

  /**
   * Tool result. `toolCallId` pairs the result back to the originating
   * `tool_use` block. `isError` marks error results (including the synthetic
   * tool_result emitted when a generation is interrupted mid-stream).
   */
  createToolResultMessage(input: CreateToolResultMessageInput): ToolResultAgentMessage {
    const metadata = mergeRuntimeMetadata(input.metadata, {
      seqIndex: input.seqIndex,
      durationMs: input.durationMs,
      status: input.status,
    });
    const message: ToolResultAgentMessage = {
      kind: 'tool_result',
      id: this.idGenerator(),
      createdAt: this.clock(),
      visibility: input.visibility ?? 'visible',
      toolCallId: input.toolCallId,
      toolName: input.toolName,
      content: input.content,
      isError: input.isError,
    };
    if (metadata !== undefined) message.metadata = metadata;
    return message;
  }

  /**
   * Runtime context (AGENTS.md, mailbox, background notification, mode, memory,
   * attachment, system). Defaults to `transient` persistence since most runtime
   * context is re-injected per turn rather than durable history.
   */
  createRuntimeContextMessage(input: CreateRuntimeContextMessageInput): RuntimeContextAgentMessage {
    const metadata = mergeRuntimeMetadata(input.metadata, {
      seqIndex: input.seqIndex,
    });
    const message: RuntimeContextAgentMessage = {
      kind: 'runtime_context',
      id: this.idGenerator(),
      createdAt: this.clock(),
      visibility: input.visibility ?? 'visible',
      source: input.source,
      content: input.content,
    };
    if (metadata !== undefined) message.metadata = metadata;
    return message;
  }

  /**
   * Compaction summary that stands in for compacted history. Defaults to
   * `transient` persistence since it is derived from a durable compaction
   * entry rather than being an independent historical record.
   */
  createCompactionSummaryMessage(input: CreateCompactionSummaryMessageInput): CompactionSummaryAgentMessage {
    const metadata = mergeRuntimeMetadata(input.metadata, {
      seqIndex: input.seqIndex,
    });
    const message: CompactionSummaryAgentMessage = {
      kind: 'compaction_summary',
      id: this.idGenerator(),
      createdAt: this.clock(),
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
