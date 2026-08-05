/**
 * Public entry for the message domain (`@duya/agent/message`).
 *
 * Exposes the structural AgentMessage domain plus the boundary projectors so
 * the desktop renderer can build the visible transcript from the SAME
 * projector the agent uses, instead of maintaining a parallel visibility
 * filter. This is a bundle-safe subpath: it imports only the pure message
 * modules (message-framework / message-projectors / legacy-message-adapter)
 * and never pulls in native deps such as better-sqlite3.
 */

// Boundary projectors (runtime)
export {
  projectModelMessages,
  extractLegacySystemSegments,
  projectPersistenceMessages,
  projectTranscriptMessages,
  projectTimelinePersistenceMessages,
  getLegacyCompactionCheckpoint,
  COMPACTION_CHECKPOINT_MESSAGE_TYPE,
  type ModelMessageProjection,
  type ProjectModelMessagesOptions,
  type ProjectBoundaryOptions,
  type NativeCustomToLegacyProjector,
  type LegacyCompactionCheckpoint,
} from './message-projectors.js';

// Legacy adapter (lossless round-trip)
export {
  legacyMessageToAgentMessage,
  legacyMessagesToAgentMessages,
  agentMessageToLegacyMessage,
  agentMessagesToLegacyMessages,
  hasLegacyEnvelope,
  type LegacyAgentMessage,
  type LegacyMessageAdapterOptions,
  type LegacySystemAgentMessage,
  type LegacyCompactionBoundaryAgentMessage,
  type LegacyUnknownRoleAgentMessage,
  type LegacyCustomAgentMessage,
} from './legacy-message-adapter.js';

// AgentMessage domain types
export type {
  AgentMessage,
  AgentMessageBase,
  AgentMessageContent,
  AgentMessagePersistence,
  AgentMessageVisibility,
  AgentCustomMessage,
  CoreAgentMessage,
  UserAgentMessage,
  AssistantAgentMessage,
  ToolResultAgentMessage,
  RuntimeContextAgentMessage,
  CompactionSummaryAgentMessage,
  RuntimeContextSource,
  MessageEntry,
  MessageTimelineEntry,
  CompactionEntry,
  ModelChangeEntry,
  ModeChangeEntry,
  BranchEntry,
  CustomStateEntry,
  AgentContextProjection,
  CustomMessageProjector,
} from './message-framework.js';

export { MessageTimeline, buildAgentContext } from './message-framework.js';

// Agent-side legacy Message shape (snake_case), re-exported so the renderer
// bridge can type both sides of the round-trip conversion without importing
// from the main entry.
export type { Message, MessageContent } from '../types.js';