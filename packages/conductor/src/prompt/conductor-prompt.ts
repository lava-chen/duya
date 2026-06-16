/**
 * @deprecated Placeholder. Real profile moved in Phase 3.
 */

export const CONDUCTOR_PROMPT_PROFILE = {
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
} as const;
