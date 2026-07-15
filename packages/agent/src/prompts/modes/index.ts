/**
 * Prompt Mode Registry
 * Default base section sets and overlay patches
 *
 * Note: This is NOT a "every section can be toggled" generic configuration platform.
 * We only maintain a few default combinations and allow very limited overrides (internal use only).
 */

import type {
  PromptBaseMode,
  PromptOverlay,
  SectionSetConfig,
  OverlayPatchConfig,
  PromptProfile,
} from './types.js'
import { PromptsRegistry } from '../PromptsRegistry.js'

/**
 * Default prompt profile used when no override is specified
 */
export const DEFAULT_PROMPT_PROFILE: PromptProfile = { base: 'full' }

/**
 * Default section sets for each base mode
 * Project instructions and grounding are execution invariants for every
 * workspace-capable base mode. Profiles that do not operate on a workspace
 * (for example gateway) disable them explicitly.
 */
export const DEFAULT_BASE_SECTION_SETS: Record<PromptBaseMode, SectionSetConfig> = {
  full: {
    enable: [
      'intro', 'system', 'projectGrounding', 'projectContinuity', 'agentsMd',
      'taskHandling', 'actions', 'toolUsage', 'toneAndStyle', 'outputEfficiency',
      'visualVerification',
      'memory', 'memoryContent', 'skills', 'mcp', 'sessionGuidance', 'sessionSearch', 'recentSessions',
      'widgetGuidelines', 'visionGuidelines', 'platform', 'environment',
      'language', 'outputStyle', 'scratchpad',
    ],
    disable: [],
  },
  minimal: {
    enable: [
      'intro', 'system', 'projectGrounding', 'agentsMd', 'actions', 'toolUsage',
      'visualVerification', 'environment', 'language',
    ],
    disable: [
      'projectContinuity', 'memory', 'memoryContent', 'skills',
      'sessionGuidance', 'sessionSearch', 'recentSessions', 'widgetGuidelines', 'conductorCanvas',
    ],
  },
  bare: {
    // Bare is lean, but project constraints and environment remain safety rails.
    enable: [
      'intro', 'system', 'projectGrounding', 'agentsMd', 'actions', 'toolUsage',
      'environment', 'language',
    ],
    disable: [
      'projectContinuity', 'memory', 'memoryContent', 'skills',
      'sessionGuidance', 'sessionSearch', 'recentSessions', 'toneAndStyle',
    ],
  },
}

/**
 * Overlay patches - small adjustments, not new top-level semantics.
 *
 * Built-in overlays (`coding`, `chat`) are statically defined here.
 * Subsystem overlays (e.g. `conductor` from `@duya/conductor`) are
 * registered at runtime via `PromptsRegistry.registerOverlayPatch()`
 * and resolved dynamically by `resolveOverlayPatch()` below.
 */
export const OVERLAY_SECTION_PATCHES: Record<PromptOverlay, OverlayPatchConfig> = {
  coding: {
    enable: ['taskHandling', 'outputEfficiency'],
  },
  chat: {
    enable: ['toneAndStyle'],
    // chat overlay != "no tool instructions", it just weakens verbose tool guidance
    // Specific behavior controlled internally by toolUsage section based on profile
  },
};

/**
 * Resolve an overlay patch from either the built-in map or the
 * runtime registry. The dynamic lookup is what lets subsystems
 * (conductor) contribute overlay patches without agent knowing
 * about them at compile time.
 */
function resolveOverlayPatch(overlay: PromptOverlay | string): OverlayPatchConfig | undefined {
  if (overlay in OVERLAY_SECTION_PATCHES) {
    return OVERLAY_SECTION_PATCHES[overlay as PromptOverlay];
  }
  return PromptsRegistry.getOverlayPatch(overlay);
}

/**
 * Resolve which sections are enabled for a given profile
 * Returns a Set of enabled section names
 */
export function resolveEnabledSections(profile: PromptProfile): Set<string> {
  const baseConfig = DEFAULT_BASE_SECTION_SETS[profile.base]

  // Start with base enabled sections
  const enabled = new Set(baseConfig.enable)

  // Apply overlay patches
  if (profile.overlays) {
    for (const overlay of profile.overlays) {
      const patch = resolveOverlayPatch(overlay)
      if (!patch) continue
      if (patch.enable) {
        for (const section of patch.enable) {
          enabled.add(section)
        }
      }
      if (patch.disable) {
        for (const section of patch.disable) {
          enabled.delete(section)
        }
      }
    }
  }

  // Apply overrides (internal use only)
  if (profile.overrides?.enableSections) {
    for (const section of profile.overrides.enableSections) {
      enabled.add(section)
    }
  }
  if (profile.overrides?.disableSections) {
    for (const section of profile.overrides.disableSections) {
      enabled.delete(section)
    }
  }

  return enabled
}

/**
 * Check if a section is enabled for the given profile
 */
export function isSectionEnabled(profile: PromptProfile, sectionName: string): boolean {
  return resolveEnabledSections(profile).has(sectionName)
}

/**
 * Apply AgentProfile's promptProfile override to a base profile
 * All profiles default to 'full' base, then apply overrides
 */
export function applyProfileOverrides(
  override: import('../../agent-profile/types.js').PromptProfileOverride | undefined,
  base: PromptProfile = DEFAULT_PROMPT_PROFILE
): PromptProfile {
  if (!override) {
    return base
  }

  return {
    ...base,
    overrides: {
      enableSections: override.enableSections ?? [],
      disableSections: override.disableSections ?? [],
    },
  }
}

/**
 * Get prompt profile for an AgentProfile
 * Combines base profile with AgentProfile's promptProfile override
 */
export function getPromptProfileForAgentProfile(
  agentProfile: import('../../agent-profile/types.js').AgentProfile
): PromptProfile {
  return applyProfileOverrides(agentProfile.promptProfile)
}

/**
 * Resolve enabled sections for an AgentProfile
 */
export function resolveEnabledSectionsForAgentProfile(
  agentProfile: import('../../agent-profile/types.js').AgentProfile
): Set<string> {
  const profile = getPromptProfileForAgentProfile(agentProfile)
  return resolveEnabledSections(profile)
}

/**
 * Subagent type to prompt profile mapping
 * This is the single source of truth for mapping agent roles to prompt profiles
 */
export const SUBAGENT_TYPE_PROFILE_MAP: Record<string, PromptProfile> = {
  // Research/exploration agents: minimal (execution focused)
  Explore: { base: 'minimal' },
  explore: { base: 'minimal' },
  research: { base: 'minimal' },

  // Verification/audit agents: full (needs governance constraints)
  verification: { base: 'full' },

  // Fork/background workers: bare (strong constraints, no conversation)
  fork: { base: 'bare' },
}

/**
 * Get prompt profile for a subagent type
 * Falls back to minimal if not specified
 */
export function getPromptProfileForSubagentType(subagentType?: string): PromptProfile {
  if (!subagentType) {
    return { base: 'minimal' }
  }

  const profile = SUBAGENT_TYPE_PROFILE_MAP[subagentType]
  if (profile) {
    return profile
  }

  // Default for unknown subagent types: minimal
  return { base: 'minimal' }
}
