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

/**
 * Default section sets for each base mode
 * Sections: intro, system, taskHandling, actions, toolUsage, toneAndStyle, outputEfficiency,
 *           memory, skills, mcp, sessionGuidance, agentsMd
 */
export const DEFAULT_BASE_SECTION_SETS: Record<PromptBaseMode, SectionSetConfig> = {
  full: {
    enable: ['intro', 'system', 'taskHandling', 'actions', 'toolUsage', 'toneAndStyle', 'outputEfficiency', 'memory', 'skills', 'mcp', 'sessionGuidance', 'widgetGuidelines', 'platform'],
    disable: [],
  },
  minimal: {
    enable: ['intro', 'system', 'taskHandling', 'actions', 'toolUsage', 'toneAndStyle', 'outputEfficiency', 'agentsMd'],
    disable: ['memory', 'skills', 'sessionGuidance', 'widgetGuidelines', 'conductorCanvas'],
  },
  bare: {
    // bare still retains essential guardrails
    enable: ['intro', 'system', 'actions', 'toolUsage'],
    disable: ['memory', 'skills', 'sessionGuidance', 'agentsMd', 'toneAndStyle'],
  },
}

/**
 * Overlay patches - small adjustments, not new top-level semantics
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
  conductor: {
    enable: ['conductorCanvas'],
    disable: ['taskHandling', 'agentsMd'],
  },
};

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
      const patch = OVERLAY_SECTION_PATCHES[overlay]
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
 * Default profile: full mode (backward compatible)
 */
export const DEFAULT_PROMPT_PROFILE: PromptProfile = {
  base: 'full',
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
