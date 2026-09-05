/**
 * Agent-to-Agent DM Module (Plan 477)
 *
 * Public API exports for envelope types, codec, and utilities.
 */

export {
  AGENT_INBOUND_WAKE_CUE,
  AGENT_MESSAGE_MAX_TEXT_LENGTH,
  type AgentDmEnvelope,
  type AgentAddress,
  type ImageRef,
  type DmMessageKind,
  type SendAcceptanceRecord,
  type SendAcceptanceOutcome,
  computeEnvelopeDigest,
  isAgentDmEnvelope,
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
