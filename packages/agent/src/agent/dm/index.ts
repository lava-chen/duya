/**
 * Agent-to-Agent DM Module (Plan 477)
 *
 * Public API exports for envelope types, codec, and utilities.
 */

export {
  AGENT_INBOUND_WAKE_CUE,
  AGENT_MESSAGE_MAX_TEXT_LENGTH,
  AGENT_DM_INTENTS,
  AGENT_DM_MAX_HOPS,
  type AgentDmEnvelope,
  type AgentAddress,
  type AgentDmIntent,
  type ImageRef,
  type DmMessageKind,
  type SendAcceptanceRecord,
  type SendAcceptanceOutcome,
  computeEnvelopeDigest,
  isAgentDmEnvelope,
  isAgentDmIntent,
} from "./types.js";

export {
  encodeEnvelope,
  decodeEnvelope,
  clampAgentMessage,
  buildDedupeKey,
  buildNonceKey,
  canonicalEnvelopeInput,
  prepareEnvelopeForSend,
} from "./envelope.js";

export {
  buildAgentInboundWakePrompt,
  buildAgentMessagingSystemPrompt,
  type AgentDirectoryEntry,
  type AgentGroupSummary,
  type AgentMessagingPromptOptions,
} from "./wake-prompt.js";

export {
  DmCycleDetector,
  DmSendLimiter,
  dmCycleDetector,
  dmSendLimiter,
  type DmEdge,
} from "./dm-cycle-detector.js";

export {
  agentMentionHandles,
  parseAgentMentions,
  buildMentionedAgentsContext,
  type MentionableAgent,
} from "./mentions.js";

export {
  BOT_SESSION_ID_PREFIX,
  getBotSessionId,
  parseAgentIdFromBotSession,
} from "./bot-session-id.js";
