export const UPDATE_STATE_TOOL_NAME = 'update_state';
export const MAX_FACT_CHARS = 500;
export const MAX_PROJECT_CHARS = 64;
export const MEMORY_TIERS = ['agent', 'user', 'project'] as const;
export type MemoryTier = (typeof MEMORY_TIERS)[number];
export const TIER_ENTRY_KINDS = ['profile', 'log', 'note'] as const;
export type TierEntryKind = (typeof TIER_ENTRY_KINDS)[number];
export type UpdateStateErrorCode =
  | 'INVALID_INPUT'
  | 'NO_IDENTITY'
  | 'NO_BRIDGE'
  | 'BRIDGE_ERROR'
  | 'NOT_IMPLEMENTED'
  | 'NOT_FOUND';
