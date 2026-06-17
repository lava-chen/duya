/**
 * Conductor Agent Prompt Profile Configuration
 * Standalone prompt profile for conductor agent
 */

import type { PromptProfile } from '@duya/agent/prompts/modes/types';

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
};
