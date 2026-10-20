import type { Message, MessageContent } from './transcript/content.js';

/** Canonical origin classifier for durable message rows. */
export type MessageSource =
  | 'user'
  | 'send_message'
  | 'tool_use'
  | 'thinking'
  | 'scratchpad'
  | 'system'
  | 'channel_mirror'
  | 'reaction'
  | 'agent_dm'
  | 'group'
  | 'group_system'
  | 'channel_activity'
  | 'routine_activity';

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
  | 'todo_gate'
  | 'working_directory_switch'
  | 'auto_continue'
  | 'goal_summary'
  | 'research_continuation'
  | 'dead_loop_nudge'
  | 'premature_stop'
  | 'send_message_reminder'
  | 'goal_reply_fingerprint'
  | 'goal_continuation'
  | 'custom';

export interface RuntimeContextMessage {
  role: 'runtime_context';
  id: string;
  timestamp: number;
  visibility: AgentMessageVisibility;
  source: RuntimeContextSource;
  content: AgentMessageContent;
  metadata?: Readonly<Record<string, unknown>>;
}

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

export interface LegacySystemMessage {
  role: 'legacy_system';
  id: string;
  timestamp: number;
  visibility: AgentMessageVisibility;
  payload: { content: AgentMessageContent; name?: string };
}

export interface LegacyCompactionBoundaryMessage {
  role: 'legacy_compaction_boundary';
  id: string;
  timestamp: number;
  visibility: AgentMessageVisibility;
  payload: {
    compactBoundaryId?: string;
    content: AgentMessageContent;
    compactedMessageCount?: number;
    compactedMessageIds?: readonly string[];
  };
}

export interface LegacyUnknownRoleMessage {
  role: 'legacy_unknown_role';
  id: string;
  timestamp: number;
  visibility: AgentMessageVisibility;
  payload: { role: string; content: AgentMessageContent };
}

export interface CustomAgentMessages {
  runtimeContext: RuntimeContextMessage;
  compactionSummary: CompactionSummaryMessage;
  legacySystem: LegacySystemMessage;
  legacyCompactionBoundary: LegacyCompactionBoundaryMessage;
  legacyUnknownRole: LegacyUnknownRoleMessage;
}

export type AgentMessage = Message | CustomAgentMessages[keyof CustomAgentMessages];
export type RuntimeContextAgentMessage = RuntimeContextMessage;
export type CompactionSummaryAgentMessage = CompactionSummaryMessage;
export type UserAgentMessage = Message & { role: 'user' };
export type AssistantAgentMessage = Message;
export type ToolResultAgentMessage = Message & { role: 'tool' };
export type CoreAgentMessage = Message | RuntimeContextMessage | CompactionSummaryMessage;

/** Durable message row stored in the append-only session timeline. */
export interface MessageEntry {
  type: 'message';
  id: string;
  parentId: string | null;
  createdAt: number;
  message: AgentMessage;
  source?: MessageSource;
  /** Host-captured producing run; absent on legacy/imported timeline entries. */
  runId?: string;
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
  reinjectedSystemMessages?: readonly (string | readonly MessageContent[])[];
}

interface TimelineControlEntryBase {
  id: string;
  parentId: string | null;
  createdAt: number;
}

export interface ModelChangeEntry extends TimelineControlEntryBase {
  type: 'model_change';
  fromModel: string;
  toModel: string;
  fromProvider?: string;
  toProvider?: string;
  reason?: string;
}

export interface ModeChangeEntry extends TimelineControlEntryBase {
  type: 'mode_change';
  fromMode: string;
  toMode: string;
  reason?: string;
  source?: 'user' | 'agent' | 'system';
}

export interface BranchEntry extends TimelineControlEntryBase {
  type: 'branch';
  branchId: string;
  fromEntryId: string;
  label?: string;
}

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

/** Namespace key for thread/fork metadata on an AgentMessage. */
export const THREAD_METADATA_KEY = 'threadMeta';

/** Sources visible to the user in a direct bot conversation. */
export const BOT_DIRECT_VISIBLE_SOURCES: readonly MessageSource[] = [
  'send_message',
  'user',
  'reaction',
  'agent_dm',
  'channel_activity',
  'routine_activity',
] as const;

/** Sources that remain internal to bot execution. */
export const BOT_INTERNAL_SOURCES: readonly MessageSource[] = [
  'tool_use',
  'thinking',
  'scratchpad',
  'system',
] as const;

/** Sources visible in a shared room transcript. */
export const ROOM_VISIBLE_SOURCES: readonly MessageSource[] = [
  'user',
  'group',
  'group_system',
] as const;

/** Sources included in the group orchestrator's room history. */
export const ROOM_HISTORY_SOURCES: readonly MessageSource[] = ['user', 'group'] as const;

/** Fallback source for persisted messages without a more specific origin. */
export const DEFAULT_MESSAGE_SOURCE: MessageSource = 'scratchpad';

export function isBotDirectVisible(source: MessageSource | undefined): boolean {
  return source !== undefined && BOT_DIRECT_VISIBLE_SOURCES.includes(source);
}
