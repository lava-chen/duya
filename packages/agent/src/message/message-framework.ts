import type { Message, MessageContent, TokenUsage } from '../types.js';

export type AgentMessageContent = string | MessageContent[];

export type AgentMessagePersistence = 'durable' | 'transient';

export type AgentMessageVisibility = 'visible' | 'hidden';

export interface AgentMessageBase {
  id: string;
  createdAt: number;
  persistence: AgentMessagePersistence;
  visibility: AgentMessageVisibility;
  metadata?: Readonly<Record<string, unknown>>;
}

export interface UserAgentMessage extends AgentMessageBase {
  kind: 'user';
  content: AgentMessageContent;
  displayContent?: AgentMessageContent;
  attachments?: readonly unknown[];
}

export interface AssistantAgentMessage extends AgentMessageBase {
  kind: 'assistant';
  content: AgentMessageContent;
  providerId?: string;
  model?: string;
  tokenUsage?: TokenUsage;
  stopReason?: string;
}

export interface ToolResultAgentMessage extends AgentMessageBase {
  kind: 'tool_result';
  toolCallId: string;
  toolName: string;
  content: AgentMessageContent;
  isError: boolean;
}

export type RuntimeContextSource =
  | 'agents_md'
  | 'attachment'
  | 'background_notification'
  | 'mailbox'
  | 'memory'
  | 'mode'
  | 'system'
  | 'custom';

export interface RuntimeContextAgentMessage extends AgentMessageBase {
  kind: 'runtime_context';
  source: RuntimeContextSource;
  content: AgentMessageContent;
  includeInModel: boolean;
}

export interface CompactionSummaryAgentMessage extends AgentMessageBase {
  kind: 'compaction_summary';
  summary: string;
  compactionEntryId: string;
  tokensBefore: number;
  tokensAfter?: number;
}

/**
 * Applications may extend the framework without widening the provider Message type.
 *
 * @example
 * type ArtifactMessage = AgentCustomMessage<'artifact', { path: string }>;
 * type AppMessage = AgentMessage<ArtifactMessage>;
 */
export interface AgentCustomMessage<
  TKind extends string = string,
  TPayload = unknown,
> extends AgentMessageBase {
  kind: `custom:${TKind}`;
  payload: TPayload;
  includeInModel: boolean;
}

export type CoreAgentMessage =
  | UserAgentMessage
  | AssistantAgentMessage
  | ToolResultAgentMessage
  | RuntimeContextAgentMessage
  | CompactionSummaryAgentMessage;

export type AgentMessage<TCustom extends AgentCustomMessage = never> =
  | CoreAgentMessage
  | TCustom;

export interface MessageEntry<TCustom extends AgentCustomMessage = never> {
  type: 'message';
  id: string;
  parentId: string | null;
  createdAt: number;
  message: AgentMessage<TCustom>;
}

export interface CompactionEntry {
  type: 'compaction';
  id: string;
  parentId: string | null;
  createdAt: number;
  summary: string;
  firstKeptMessageId: string;
  compactedMessageIds: readonly string[];
  tokensBefore: number;
  tokensAfter?: number;
  strategy: string;
  previousCompactionId?: string;
}

export type MessageTimelineEntry<TCustom extends AgentCustomMessage = never> =
  | MessageEntry<TCustom>
  | CompactionEntry;

export interface AgentContextProjection<TCustom extends AgentCustomMessage = never> {
  messages: AgentMessage<TCustom>[];
  compaction?: CompactionEntry;
  warnings: string[];
}

export type CustomMessageProjector<TCustom extends AgentCustomMessage> = (
  message: TCustom,
) => Message | readonly Message[] | null;

function isCustomAgentMessage(
  message: AgentMessage<AgentCustomMessage>,
): message is AgentCustomMessage {
  return message.kind.startsWith('custom:');
}

export function isDurableAgentMessage(
  message: AgentMessage<AgentCustomMessage>,
): boolean {
  return message.persistence === 'durable';
}

export function isVisibleAgentMessage(
  message: AgentMessage<AgentCustomMessage>,
): boolean {
  return message.visibility === 'visible';
}

export function findSafeCompactionBoundary<
  TCustom extends AgentCustomMessage = never,
>(
  messages: readonly AgentMessage<TCustom>[],
  proposedFirstKeptIndex: number,
): { firstKeptIndex: number; firstKeptMessageId?: string } {
  if (messages.length === 0) {
    return { firstKeptIndex: 0 };
  }

  const proposedIndex = Math.max(
    0,
    Math.min(Math.trunc(proposedFirstKeptIndex), messages.length - 1),
  );

  for (let index = proposedIndex; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.kind === 'user') {
      return { firstKeptIndex: index, firstKeptMessageId: message.id };
    }
  }

  return {
    firstKeptIndex: 0,
    firstKeptMessageId: messages[0]?.id,
  };
}

export function buildAgentContext<TCustom extends AgentCustomMessage = never>(
  entries: readonly MessageTimelineEntry<TCustom>[],
): AgentContextProjection<TCustom> {
  const messageEntries = entries.filter(
    (entry): entry is MessageEntry<TCustom> => entry.type === 'message',
  );
  const latestCompaction = [...entries]
    .reverse()
    .find((entry): entry is CompactionEntry => entry.type === 'compaction');

  if (!latestCompaction) {
    return {
      messages: messageEntries.map((entry) => entry.message),
      warnings: [],
    };
  }

  const compactionIndex = entries.findIndex(
    (entry) => entry.id === latestCompaction.id,
  );
  const firstKeptIndex = entries.findIndex(
    (entry) =>
      entry.type === 'message' &&
      entry.message.id === latestCompaction.firstKeptMessageId,
  );

  if (firstKeptIndex < 0 || firstKeptIndex > compactionIndex) {
    return {
      messages: messageEntries.map((entry) => entry.message),
      compaction: latestCompaction,
      warnings: [
        `Compaction ${latestCompaction.id} references missing boundary ${latestCompaction.firstKeptMessageId}; full history retained`,
      ],
    };
  }

  const retainedMessages = entries
    .slice(firstKeptIndex)
    .filter((entry): entry is MessageEntry<TCustom> => entry.type === 'message')
    .map((entry) => entry.message);

  const summaryMessage: CompactionSummaryAgentMessage = {
    kind: 'compaction_summary',
    id: `${latestCompaction.id}:summary`,
    createdAt: latestCompaction.createdAt,
    persistence: 'transient',
    visibility: 'visible',
    summary: latestCompaction.summary,
    compactionEntryId: latestCompaction.id,
    tokensBefore: latestCompaction.tokensBefore,
    tokensAfter: latestCompaction.tokensAfter,
  };

  return {
    messages: [summaryMessage, ...retainedMessages],
    compaction: latestCompaction,
    warnings: [],
  };
}

export function toModelMessages<TCustom extends AgentCustomMessage = never>(
  messages: readonly AgentMessage<TCustom>[],
  projectCustom?: CustomMessageProjector<TCustom>,
): Message[] {
  const result: Message[] = [];

  for (const message of messages) {
    if (message.kind === 'user') {
      result.push({
        id: message.id,
        role: 'user',
        content: message.content,
        displayContent: message.displayContent,
        attachments: message.attachments ? [...message.attachments] : undefined,
        timestamp: message.createdAt,
      });
      continue;
    }

    if (message.kind === 'assistant') {
      result.push({
        id: message.id,
        role: 'assistant',
        content: message.content,
        providerId: message.providerId,
        model: message.model,
        tokenUsage: message.tokenUsage,
        timestamp: message.createdAt,
      });
      continue;
    }

    if (message.kind === 'tool_result') {
      result.push({
        id: message.id,
        role: 'tool',
        content: [{
          type: 'tool_result',
          tool_use_id: message.toolCallId,
          content: message.content,
          is_error: message.isError,
        }],
        name: message.toolName,
        tool_call_id: message.toolCallId,
        timestamp: message.createdAt,
      });
      continue;
    }

    if (message.kind === 'runtime_context') {
      if (message.includeInModel) {
        result.push({
          id: message.id,
          role: 'user',
          content: message.content,
          timestamp: message.createdAt,
          metadata: {
            runtimeContext: true,
            source: message.source,
          },
        });
      }
      continue;
    }

    if (message.kind === 'compaction_summary') {
      result.push({
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

    const customMessage = message as TCustom;
    if (!isCustomAgentMessage(customMessage) || !customMessage.includeInModel) {
      continue;
    }
    if (!projectCustom) {
      continue;
    }

    const projected = projectCustom(customMessage);
    if (Array.isArray(projected)) {
      result.push(...projected);
    } else if (projected) {
      result.push(projected as Message);
    }
  }

  return result;
}

export class MessageTimeline<TCustom extends AgentCustomMessage = never> {
  private readonly timeline: MessageTimelineEntry<TCustom>[];
  private readonly entryIds: Set<string>;
  private readonly messageIds: Set<string>;

  constructor(entries: readonly MessageTimelineEntry<TCustom>[] = []) {
    this.timeline = [];
    this.entryIds = new Set();
    this.messageIds = new Set();
    for (const entry of entries) {
      this.appendEntry(entry);
    }
  }

  appendMessage(entry: MessageEntry<TCustom>): void {
    this.appendEntry(entry);
  }

  appendCompaction(entry: CompactionEntry): void {
    this.appendEntry(entry);
  }

  snapshot(): readonly MessageTimelineEntry<TCustom>[] {
    return [...this.timeline];
  }

  buildContext(): AgentContextProjection<TCustom> {
    return buildAgentContext(this.timeline);
  }

  private appendEntry(entry: MessageTimelineEntry<TCustom>): void {
    if (this.entryIds.has(entry.id)) {
      throw new Error(`Duplicate timeline entry id: ${entry.id}`);
    }
    if (entry.type === 'message' && this.messageIds.has(entry.message.id)) {
      throw new Error(`Duplicate agent message id: ${entry.message.id}`);
    }

    this.timeline.push(entry);
    this.entryIds.add(entry.id);
    if (entry.type === 'message') {
      this.messageIds.add(entry.message.id);
    }
  }
}
