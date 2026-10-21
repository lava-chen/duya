import type { MessageContent } from '@duya/agent-protocol/transcript';
import type {
  AgentMessage,
  MessageEntry,
  CompactionEntry,
  MessageTimelineEntry,
  RuntimeContextSource,
} from '@duya/agent-protocol/message-timeline';

export type {
  AgentMessageContent,
  AgentMessageVisibility,
  RuntimeContextSource,
  RuntimeContextMessage,
  CompactionSummaryMessage,
  LegacySystemMessage,
  LegacyCompactionBoundaryMessage,
  LegacyUnknownRoleMessage,
  CustomAgentMessages,
  AgentMessage,
  RuntimeContextAgentMessage,
  CompactionSummaryAgentMessage,
  UserAgentMessage,
  AssistantAgentMessage,
  ToolResultAgentMessage,
  CoreAgentMessage,
  MessageEntry,
  CompactionEntry,
  ModelChangeEntry,
  ModeChangeEntry,
  BranchEntry,
  CustomStateEntry,
  MessageTimelineEntry,
} from '@duya/agent-protocol/message-timeline';

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
 * Exhaustive per-source turn classification. Adding a source to
 * `RuntimeContextSource` without a key here is a compile error (Record
 * type), mirroring grok's exhaustive `match` in `starts_prompt_turn()`.
 */
export const STARTS_PROMPT_TURN: Record<RuntimeContextSource, boolean> = {
  agents_md: false,
  mailbox: false,
  background_notification: true, // subagent / bash completion wake-up
  attachment: false,
  memory: false,
  mode: false,
  system: false,
  todo_gate: false,
  working_directory_switch: false,
  auto_continue: false,
  goal_summary: false, // dual-tag turn+directive; counts as mid-turn (grok GoalSummary)
  research_continuation: false,
  dead_loop_nudge: false,
  premature_stop: false,
  send_message_reminder: false,
  goal_reply_fingerprint: false,
  goal_continuation: false,
  custom: false,
};

/**
 * Whether a synthetic {@link RuntimeContextMessage} starts a new prompt turn
 * or is a mid-turn injection. Aligns with grok's `starts_prompt_turn()`:
 * only server/background wake-ups (task/subagent completed, notification
 * drain) consume a turn boundary; steering directives (system reminders,
 * todo gate, working-directory switch, project instructions) are mid-turn and
 * must not change the turn relationship with neighbouring real user turns.
 */
export function runtimeContextStartsPromptTurn(source: RuntimeContextSource): boolean {
  return STARTS_PROMPT_TURN[source];
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
      return { firstKeptIndex: index, ...(message.id === undefined ? {} : { firstKeptMessageId: message.id }) };
    }
  }

  return {
    firstKeptIndex: 0,
    ...(messages[0]?.id === undefined ? {} : { firstKeptMessageId: messages[0].id }),
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
    ...(latestCompaction.tokensAfter === undefined ? {} : { tokensAfter: latestCompaction.tokensAfter }),
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
