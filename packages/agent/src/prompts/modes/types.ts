/**
 * PromptMode type definitions (simplified).
 *
 * Previous design: base ('full'|'minimal'|'bare') + overlays[] + overrides{enable,disable} — 3 layers.
 * Current design: flat enableSections / disableSections — 1 layer.
 *
 * Each PromptSystem config declares its own section universe. A profile's
 * enabled set = (config's all section names) ∪ enableSections − disableSections.
 * Subagent types still map to a default profile via SUBAGENT_TYPE_PROFILE_MAP.
 */

/**
 * Flat prompt profile: just enable/disable lists.
 *
 * `enableSections` is rarely needed — by default every section declared in
 * a PromptSystem config is enabled. Use it only to re-enable a section
 * that a parent profile disabled.
 */
export interface PromptProfile {
  enableSections?: string[]
  disableSections?: string[]
}

/**
 * Default prompt profile used when no override is specified.
 * Empty = enable everything declared in the PromptSystem config.
 */
export const DEFAULT_PROMPT_PROFILE: PromptProfile = {}

/**
 * Subagent type to prompt profile mapping.
 * Replaces the old base-mode system with explicit enable/disable lists.
 *
 * - Explore/research/plan: minimal — keep core context + tool guidance, drop governance
 * - verification: full — needs governance constraints (same as default)
 * - fork: bare — strong constraints, no conversation
 */
export const SUBAGENT_TYPE_PROFILE_MAP: Record<string, PromptProfile> = {
  Explore: {
    disableSections: ['memory', 'memoryContent', 'skills', 'sessionGuidance', 'sessionSearch', 'recentSessions', 'widgetGuidelines', 'visionGuidelines'],
  },
  explore: {
    disableSections: ['memory', 'memoryContent', 'skills', 'sessionGuidance', 'sessionSearch', 'recentSessions', 'widgetGuidelines', 'visionGuidelines'],
  },
  research: {
    disableSections: ['memory', 'memoryContent', 'skills', 'sessionGuidance', 'sessionSearch', 'recentSessions', 'widgetGuidelines'],
  },
  // verification: full profile (no disable) — keeps governance constraints
  verification: {},
  // fork: bare — drop conversation/governance, keep safety + project + environment
  fork: {
    disableSections: ['memory', 'memoryContent', 'skills', 'sessionGuidance', 'sessionSearch', 'recentSessions', 'personality', 'widgetGuidelines', 'visionGuidelines'],
  },
}

/**
 * Default profile for unknown subagent types.
 */
export const DEFAULT_SUBAGENT_PROFILE: PromptProfile = {
  disableSections: ['memory', 'memoryContent', 'skills', 'sessionGuidance', 'sessionSearch', 'recentSessions', 'widgetGuidelines'],
}
