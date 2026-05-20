/**
 * Conductor Agent Prompt Profile Configuration
 * Standalone prompt profile for conductor agent
 */

import type { PromptProfile } from '../modes/types.js'

/**
 * Conductor-specific prompt profile
 * Uses full base with conductor-specific overrides
 */
export const CONDUCTOR_PROMPT_PROFILE: PromptProfile = {
  base: 'full',
  overrides: {
    disableSections: [
      'taskHandling',
      'memory',
      'skills',
      'sessionGuidance',
      'agentsMd',
      'widgetGuidelines',
      'visionGuidelines',
    ],
  },
}