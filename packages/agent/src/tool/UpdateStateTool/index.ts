export { updateStateTool, UpdateStateTool, setMemoryTierBridge } from './UpdateStateTool.js';
export { resolveUpdateStateOperation, normalizeDedupeKey } from './UpdateStateTool.js';
export type {
  MemoryTierBridge,
  MemoryTierBridgeResponse,
  MemoryTierWritePayload,
  ResolvedOperation,
  UpdateStateInput,
} from './UpdateStateTool.js';
export {
  UPDATE_STATE_TOOL_NAME,
  MAX_FACT_CHARS,
  MAX_PROJECT_CHARS,
} from './constants.js';
export type { MemoryTier, TierEntryKind, UpdateStateErrorCode } from './constants.js';
