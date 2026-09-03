/** Plan 481 T1 constants for the update_state tool. */

export const UPDATE_STATE_TOOL_NAME = 'update_state';

/** Max characters accepted in the `fact` field (longer input is clamped). */
export const MAX_FACT_CHARS = 500;

/** Max characters accepted in the `project` field. */
export const MAX_PROJECT_CHARS = 64;

/** Memory tiers the tool can write, mirrored from the 479 store. */
export const MEMORY_TIERS = ['agent', 'user', 'project'] as const;

export type MemoryTier = (typeof MEMORY_TIERS)[number];

/** Entry kinds accepted by the 479 tier index. */
export const TIER_ENTRY_KINDS = ['profile', 'log', 'note'] as const;

export type TierEntryKind = (typeof TIER_ENTRY_KINDS)[number];

/** Structured error codes surfaced to the model. */
export type UpdateStateErrorCode =
  | 'INVALID_INPUT'
  | 'NO_IDENTITY'
  | 'NO_BRIDGE'
  | 'BRIDGE_ERROR'
  | 'NOT_IMPLEMENTED'
  | 'NOT_FOUND';
