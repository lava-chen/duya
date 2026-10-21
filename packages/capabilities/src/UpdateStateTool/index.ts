export {
  UpdateStateTool,
  normalizeDedupeKey,
  resolveUpdateStateOperation,
} from './UpdateStateTool.js';
export type { ResolvedOperation, UpdateStateInput } from './UpdateStateTool.js';
export {
  MAX_FACT_CHARS,
  MAX_PROJECT_CHARS,
  MEMORY_TIERS,
  TIER_ENTRY_KINDS,
  UPDATE_STATE_TOOL_NAME,
} from './constants.js';
export type { MemoryTier, TierEntryKind, UpdateStateErrorCode } from './constants.js';
export type {
  BotIdentityBridge,
  BotIdentityPatchPayload,
  MemoryTierBridge,
  MemoryTierBridgeResponse,
  MemoryTierWritePayload,
  UpdateStateContext,
  UpdateStatePort,
} from './ports.js';
