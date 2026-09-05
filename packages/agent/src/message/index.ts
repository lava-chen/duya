/**
 * Public entry for the message domain (`@duya/agent/message`).
 *
 * Exposes the structural AgentMessage domain plus the boundary projectors so
 * the desktop renderer can build the visible transcript from the SAME
 * projector the agent uses, instead of maintaining a parallel visibility
 * filter. This is a bundle-safe subpath: it imports only the pure message
 * modules (message-framework / message-projectors / message-factories)
 * and never pulls in native deps such as better-sqlite3.
 */

// Boundary projectors (runtime)
export {
  projectModelMessages,
  projectRuntimeContextToProviderMessage,
  extractLegacySystemSegments,
  projectPersistenceMessages,
  projectTranscriptMessages,
  projectTimelinePersistenceMessages,
  getLegacyCompactionCheckpoint,
  COMPACTION_CHECKPOINT_MESSAGE_TYPE,
  type ModelMessageProjection,
  type ProjectModelMessagesOptions,
  type ProjectTranscriptOptions,
  type LegacyCompactionCheckpoint,
} from './message-projectors.js';

// Thread / fork branched layer (plan 486) — pure functions shared by the
// agent runtime and (later) the thread UI.
export {
  THREAD_METADATA_KEY,
  readThreadMeta,
  isBranchedMessage,
  isReplyMessage,
  isBranchedEntry,
  mergeThreadMetadata,
  toThreadMessageView,
  indexThreadViews,
  resolveBranchRoot,
  threadChainContains,
  branchThreadDescendants,
  branchReplyCounts,
  getThread,
  validateReplyTarget,
  resolveReplyMeta,
  renderReplyQuotePrefix,
  messageToQuoteText,
  applyReplyQuoteContext,
  collectMessageIds,
  type ThreadMeta,
  type ThreadMessageView,
} from './threads.js';

// Persistence-row ingest (Message -> AgentMessage)
export {
  ingestMessage,
  ingestMessages,
  type IngestMessageOptions,
} from './message-factories.js';

// Message origin classifier (plan 489 P0.1) — canonical MessageSource union
// + the bot-direct visibility helpers shared by the worker and the desktop
// main process.
export {
  BOT_DIRECT_VISIBLE_SOURCES,
  BOT_INTERNAL_SOURCES,
  DEFAULT_MESSAGE_SOURCE,
  isBotDirectVisible,
} from './message-source.js';
export type { MessageSource } from './message-source.js';

// AgentMessage domain types
export type {
  AgentMessage,
  AgentMessageContent,
  AgentMessageVisibility,
  CustomAgentMessages,
  CoreAgentMessage,
  UserAgentMessage,
  AssistantAgentMessage,
  ToolResultAgentMessage,
  RuntimeContextAgentMessage,
  CompactionSummaryAgentMessage,
  RuntimeContextMessage,
  CompactionSummaryMessage,
  LegacySystemMessage,
  LegacyCompactionBoundaryMessage,
  LegacyUnknownRoleMessage,
  RuntimeContextSource,
  MessageEntry,
  MessageTimelineEntry,
  CompactionEntry,
  AgentContextProjection,
} from './message-framework.js';

export { MessageTimeline, buildAgentContext } from './message-framework.js';

// Agent-side legacy Message shape (snake_case), re-exported so the renderer
// bridge can type both sides of the round-trip conversion without importing
// from the main entry.
export type { Message, MessageContent } from '../types.js';