/**
 * Prompt Mode Registry (simplified).
 *
 * Previous: 3-layer base + overlays + overrides with DEFAULT_BASE_SECTION_SETS,
 *           OVERLAY_SECTION_PATCHES, resolveOverlayPatch, applyProfileOverrides.
 * Current:  flat enableSections / disableSections. Each PromptSystem config
 *           declares its own section universe; profile just toggles them.
 */

import type { PromptProfile } from './types.js'
import { DEFAULT_PROMPT_PROFILE, SUBAGENT_TYPE_PROFILE_MAP, DEFAULT_SUBAGENT_PROFILE } from './types.js'

// Re-export types and constants for callers that import from here.
export {
  DEFAULT_PROMPT_PROFILE,
  SUBAGENT_TYPE_PROFILE_MAP,
  DEFAULT_SUBAGENT_PROFILE,
}

/**
 * Check if a section is enabled for the given profile.
 *
 * Default: enabled (every section declared in the PromptSystem config is on).
 * When `enableSections` is non-empty it is a whitelist. This lets a profile
 * opt into a compact, task-appropriate prompt instead of inheriting every
 * dynamic section declared by the system configuration.
 * Without a whitelist, `disableSections` removes named sections.
 */
export function isSectionEnabled(profile: PromptProfile, sectionName: string): boolean {
  const disable = profile.disableSections
  const enable = profile.enableSections
  if (enable && enable.length > 0) return enable.includes(sectionName)
  if (disable && disable.includes(sectionName)) return false
  return true
}

/**
 * Resolve the full enabled-section set for a profile.
 * Mirrors `isSectionEnabled` but returns the Set for callers that need it.
 */
export function resolveEnabledSections(profile: PromptProfile): Set<string> {
  // Note: this can only resolve "explicitly enabled" — the implicit default
  // (everything not disabled) is handled by PromptSystem.getStaticSections
  // via isSectionEnabled(). This function is kept for backward-compat
  // callers that just want the explicit enable list minus disable list.
  const enabled = new Set<string>(profile.enableSections ?? [])
  if (profile.disableSections) {
    for (const s of profile.disableSections) enabled.delete(s)
  }
  return enabled
}

/**
 * Get prompt profile for an AgentProfile.
 * AgentProfile.promptProfile is already a flat {enableSections?, disableSections?} —
 * just pass it through (or default to empty).
 */
export function getPromptProfileForAgentProfile(
  agentProfile: import('../../agent-profile/types.js').AgentProfile
): PromptProfile {
  return agentProfile.promptProfile ?? DEFAULT_PROMPT_PROFILE
}

/**
 * Get prompt profile for a subagent type.
 * Falls back to DEFAULT_SUBAGENT_PROFILE for unknown types.
 */
export function getPromptProfileForSubagentType(subagentType?: string): PromptProfile {
  if (!subagentType) return DEFAULT_SUBAGENT_PROFILE
  return SUBAGENT_TYPE_PROFILE_MAP[subagentType] ?? DEFAULT_SUBAGENT_PROFILE
}

/**
 * Backward-compat: previously returned a full PromptProfile from a base + override.
 * Now the override IS the profile — just return it (or default).
 */
export function applyProfileOverrides(
  override: import('../../agent-profile/types.js').PromptProfileOverride | undefined,
  _base: PromptProfile = DEFAULT_PROMPT_PROFILE,
): PromptProfile {
  if (!override) return DEFAULT_PROMPT_PROFILE
  return {
    enableSections: override.enableSections,
    disableSections: override.disableSections,
  }
}

/**
 * Backward-compat: previously resolved sections for an AgentProfile.
 */
export function resolveEnabledSectionsForAgentProfile(
  agentProfile: import('../../agent-profile/types.js').AgentProfile
): Set<string> {
  return resolveEnabledSections(getPromptProfileForAgentProfile(agentProfile))
}
