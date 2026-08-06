import type { Message, MessageContent, TokenUsage } from '../types.js';

export type AgentMessageContent = string | MessageContent[];

export type AgentMessageVisibility = 'visible' | 'hidden';

export type RuntimeContextSource =
  | 'agents_md'
  | 'attachment'
  | 'background_notification'
  | 'mailbox'
  | 'memory'
  | 'mode'
  | 'system'
  | 'custom';

/**
 * Runtime context (AGENTS.md, mailbox, background notification, mode, memory,
 * attachment, system). Modeled as a user-role provider turn when projected.
 */
export interface RuntimeContextMessage {
  role: 'runtime_context';
  id: string;
  timestamp: number;
  visibility: AgentMessageVisibility;
  source: RuntimeContextSource;
  content: AgentMessageContent;
  metadata?: Readonly<Record<string, unknown>>;
}

/**
 * Compaction summary that stands in for compacted history. Derived from a
 * durable CompactionEntry rather than an independent historical record.
 */
export interface CompactionSummaryMessage {
  role: 'compaction_summary';
  id: string;
  timestamp: number;
  visibility: AgentMessageVisibility;
  summary: string;
  compactionEntryId: string;
  tokensBefore: number;
  tokensAfter?: number;
  metadata?: Readonly<Record<string, unknown>>;
}

/** Legacy `role: 'system'` message adapted from an old provider row. */
export interface LegacySystemMessage {
  role: 'legacy_system';
  id: string;
  timestamp: number;
  visibility: AgentMessageVisibility;
  payload: { content: AgentMessageContent; name?: string };
}

/** Legacy compact-boundary marker adapted from an old provider row. */
export interface LegacyCompactionBoundaryMessage {
  role: 'legacy_compaction_boundary';
  id: string;
  timestamp: number;
  visibility: AgentMessageVisibility;
  payload: {
    compactBoundaryId?: string;
    /** Original marker content, kept so persistence can rebuild the row. */
    content: AgentMessageContent;
    compactedMessageCount?: number;
    compactedMessageIds?: readonly string[];
  };
}

/** Legacy message with a role the new domain does not model. */
export interface LegacyUnknownRoleMessage {
  role: 'legacy_unknown_role';
  id: string;
  timestamp: number;
  visibility: AgentMessageVisibility;
  payload: { role: string; content: AgentMessageContent };
}

/**
 * Fixed registry of the framework's custom (non-provider) message roles.
 * The composite `AgentMessage` is the provider `Message` OR one of these.
 */
export interface CustomAgentMessages {
  runtimeContext: RuntimeContextMessage;
  compactionSummary: CompactionSummaryMessage;
  legacySystem: LegacySystemMessage;
  legacyCompactionBoundary: LegacyCompactionBoundaryMessage;
  legacyUnknownRole: LegacyUnknownRoleMessage;
}

/**
 * Unified agent message: the flat provider `Message` for user/assistant/tool
 * turns, unioned with the framework's custom message roles.
 */
export type AgentMessage = Message | CustomAgentMessages[keyof CustomAgentMessages];

// ─── Backward-compatible aliases ────────────────────────────────────────

export type RuntimeContextAgentMessage = RuntimeContextMessage;
export type CompactionSummaryAgentMessage = CompactionSummaryMessage;

export type UserAgentMessage = Message & { role: 'user' };
export type AssistantAgentMessage = Message;
export type ToolResultAgentMessage = Message & { role: 'tool' };

export type CoreAgentMessage =
  | Message
  | RuntimeContextMessage
  | CompactionSummaryMessage;

export interface MessageEntry {
  type: 'message';
  id: string;
  parentId: string | null;
  createdAt: number;
  message: AgentMessage;
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
  /**
   * System-role context the legacy CompactionManager reinjected immediately
   * after its summary marker (file/skill/tool/working-directory context).
   * Kept on the checkpoint so it survives both the current projection and a
   * restart, without being appended as a user history turn.
   */
  reinjectedSystemMessages?: readonly (string | readonly MessageContent[])[];
}

interface TimelineControlEntryBase {
  id: string;
  parentId: string | null;
  createdAt: number;
}

/**
 * Records a model switch (e.g. user changed the active model/provider).
 * Non-message: it never contributes to the provider projection.
 */
export interface ModelChangeEntry extends TimelineControlEntryBase {
  type: 'model_change';
  fromModel: string;
  toModel: string;
  fromProvider?: string;
  toProvider?: string;
  reason?: string;
}

/**
 * Records a mode switch (e.g. entering plan/research mode).
 * Non-message: it never contributes to the provider projection.
 */
export interface ModeChangeEntry extends TimelineControlEntryBase {
  type: 'mode_change';
  fromMode: string;
  toMode: string;
  reason?: string;
  source?: 'user' | 'agent' | 'system';
}

/**
 * Records a branch fork in the timeline (e.g. a sub-conversation detached from
 * a parent entry). Non-message: it never contributes to the provider projection.
 */
export interface BranchEntry extends TimelineControlEntryBase {
  type: 'branch';
  branchId: string;
  fromEntryId: string;
  label?: string;
}

/**
 * Records an application-specific state marker (e.g. a checkpoint).
 * Non-message: it never contributes to the provider projection.
 */
export interface CustomStateEntry extends TimelineControlEntryBase {
  type: 'custom_state';
  stateKind: string;
  payload: unknown;
}

export type MessageTimelineEntry =
  | MessageEntry
  | CompactionEntry
  | ModelChangeEntry
  | ModeChangeEntry
  | BranchEntry
  | CustomStateEntry;

export interface AgentContextProjection {
  messages: AgentMessage[];
  compaction?: CompactionEntry;
  warnings: string[];
}

export type ContextContributionPlacement =
  | 'stable-prefix'
  | 'history-prefix'
  | 'before-current-user'
  | 'tail';

export interface PromptSegment {
  readonly id: string;
  readonly contributorId: string;
  readonly placement: ContextContributionPlacement;
  readonly content: string | readonly MessageContent[];
}

export function isVisibleAgentMessage(message: AgentMessage): boolean {
  return message.visibility === 'visible';
}

/**
 * Shared deep-clone helper for the message domain. Both the legacy adapter
 * (envelope snapshots) and the boundary projectors (output isolation) need
 * structurally independent copies of message payloads.
 */
export function cloneValue<T>(value: T): T {
  return structuredClone(value);
}

export function findSafeCompactionBoundary(
  messages: readonly AgentMessage[],
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
    if (message?.role === 'user') {
      return { firstKeptIndex: index, firstKeptMessageId: message.id };
    }
  }

  return {
    firstKeptIndex: 0,
    firstKeptMessageId: messages[0]?.id,
  };
}

export function buildAgentContext(
  entries: readonly MessageTimelineEntry[],
): AgentContextProjection {
  const messageEntries = entries.filter(
    (entry): entry is MessageEntry => entry.type === 'message',
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
    .filter((entry): entry is MessageEntry => entry.type === 'message')
    .map((entry) => entry.message);

  const summaryMessage: AgentMessage = {
    role: 'compaction_summary',
    id: `${latestCompaction.id}:summary`,
    timestamp: latestCompaction.createdAt,
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

export class MessageTimeline {
  private readonly timeline: MessageTimelineEntry[];
  private readonly entryIds: Set<string>;
  private readonly messageIds: Set<string>;

  constructor(entries: readonly MessageTimelineEntry[] = []) {
    this.timeline = [];
    this.entryIds = new Set();
    this.messageIds = new Set();
    for (const entry of entries) {
      this.appendEntry(entry);
    }
  }

  appendMessage(entry: MessageEntry): void {
    this.appendEntry(entry);
  }

  appendCompaction(entry: CompactionEntry): void {
    this.appendEntry(entry);
  }

  appendModelChange(entry: ModelChangeEntry): void {
    this.appendEntry(entry);
  }

  appendModeChange(entry: ModeChangeEntry): void {
    this.appendEntry(entry);
  }

  appendBranch(entry: BranchEntry): void {
    this.appendEntry(entry);
  }

  appendCustomState(entry: CustomStateEntry): void {
    this.appendEntry(entry);
  }

  snapshot(): readonly MessageTimelineEntry[] {
    return [...this.timeline];
  }

  buildContext(): AgentContextProjection {
    return buildAgentContext(this.timeline);
  }

  private appendEntry(entry: MessageTimelineEntry): void {
    if (this.entryIds.has(entry.id)) {
      throw new Error(`Duplicate timeline entry id: ${entry.id}`);
    }
    if (entry.type === 'message' && entry.message.id && this.messageIds.has(entry.message.id)) {
      throw new Error(`Duplicate agent message id: ${entry.message.id}`);
    }

    this.timeline.push(entry);
    this.entryIds.add(entry.id);
    if (entry.type === 'message' && entry.message.id) {
      this.messageIds.add(entry.message.id);
    }
  }
}