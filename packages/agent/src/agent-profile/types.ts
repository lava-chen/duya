/**
 * Agent Profile System - Core Types
 *
 * Agent profiles control both tool scope and prompt sections.
 */

// ============================================================
// Prompt Profile Override
// ============================================================

export interface PromptProfileOverride {
  /** Disable specific prompt sections */
  disableSections?: string[];
  /** Enable specific prompt sections (useful for re-enabling after base profile excludes them) */
  enableSections?: string[];
}

// ============================================================
// Agent Profile
// ============================================================

export interface AgentProfile {
  /** Unique identifier */
  id: string;
  /** Display name */
  name: string;
  /** Description of the agent's purpose */
  description?: string;

  /** Allowed tool group patterns (supports wildcards like 'file:*', 'search:*') */
  allowedTools?: string[];
  /** Denied tool group patterns */
  disallowedTools?: string[];

  /** Default model ID override */
  defaultModel?: string;

  /** Prompt sections control */
  promptProfile?: PromptProfileOverride;

  /**
   * Which prompt system to use. Built-in values: 'general', 'code',
   * 'research'. Subsystem values (e.g. 'conductor' from
   * `@duya/conductor`) are registered at runtime via
   * `PromptsRegistry.register()`; the type is open (string) so the
   * agent typecheck does not need to be updated when a new system
   * lands. Defaults to 'general' if not specified.
   */
  promptSystem?: 'general' | 'code' | 'research' | (string & {});

  /** Whether this profile is selectable by users in the UI */
  userVisible: boolean;
  /** Whether this is a preset profile */
  isPreset: boolean;
  /** Whether this profile is enabled */
  isEnabled: boolean;
  /** Creation timestamp */
  createdAt: number;
  /** Last update timestamp */
  updatedAt: number;
}

// ============================================================
// Database Row Type (for serialization)
// ============================================================

export interface AgentProfileDbRow {
  id: string;
  name: string;
  description: string | null;
  allowed_tools: string | null;
  disallowed_tools: string | null;
  default_model: string | null;
  prompt_system: string | null;
  user_visible: number;
  is_preset: number;
  is_enabled: number;
  created_at: number;
  updated_at: number;
}

// ============================================================
// Preset Definitions
// ============================================================

export const PRESET_AGENT_PROFILES: AgentProfile[] = [
  {
    id: 'general-purpose',
    name: 'General',
    description: 'General purpose assistant for most tasks',
    allowedTools: ['*'],
    // Conductor canvas tools are gated by the per-session conductorMode
    // toggle, not by the agent profile. Removing canvas_* from the default
    // denylist lets the tools appear when the user explicitly enables
    // conductor mode.
    promptProfile: {
      enableSections: ['generalTaskGuidance'],
      disableSections: ['taskHandling'],
    },
    promptSystem: 'general',
    userVisible: true,
    isPreset: true,
    isEnabled: true,
    createdAt: 0,
    updatedAt: 0,
  },
  {
    id: 'code-expert',
    name: 'Code',
    description: 'Code development and software engineering',
    allowedTools: ['*'],
    disallowedTools: ['show_widget', 'cron', 'duya:*', 'canvas:*', 'memory', 'SessionSearch'],
    promptSystem: 'code',
    userVisible: true,
    isPreset: true,
    isEnabled: true,
    createdAt: 0,
    updatedAt: 0,
  },
  {
    id: 'research',
    name: 'Research',
    description: 'Research, investigation and deep analysis',
    allowedTools: ['*'],
    // canvas_* removed: conductor canvas tools are gated by the session
    // conductorMode toggle. Research mode can still use canvas tools when
    // the user explicitly enables conductor mode.
    disallowedTools: ['Agent', 'skill_manage', 'duya_*', 'WebSearch', 'WebFetch'],
    promptProfile: {
      disableSections: ['taskHandling', 'actions'],
    },
    promptSystem: 'research',
    userVisible: true,
    isPreset: true,
    isEnabled: true,
    createdAt: 0,
    updatedAt: 0,
  },
  {
    id: 'explore',
    name: 'Explore',
    description: 'Read-only exploration — sub-agent only',
    allowedTools: ['file:read*', 'search:*'],
    disallowedTools: ['file:write*', 'file:edit*', 'exec:*', 'browser:*', 'gateway:*'],
    promptProfile: {
      disableSections: ['memory', 'skills', 'sessionGuidance', 'widgetGuidelines'],
    },
    userVisible: false,
    isPreset: true,
    isEnabled: true,
    createdAt: 0,
    updatedAt: 0,
  },
  {
    id: 'plan',
    name: 'Plan',
    description: 'Planning and architecture design — sub-agent only',
    allowedTools: ['file:read*', 'search:*'],
    disallowedTools: ['file:write*', 'file:edit*', 'exec:*', 'browser:*', 'gateway:*'],
    promptProfile: {
      disableSections: ['memory', 'skills', 'sessionGuidance', 'widgetGuidelines'],
    },
    userVisible: false,
    isPreset: true,
    isEnabled: true,
    createdAt: 0,
    updatedAt: 0,
  },
  {
    id: 'gateway',
    name: 'Gateway',
    description: 'Gateway agent for handling bridge/channel messages from external platforms',
    allowedTools: ['gateway:*', 'file:read*', 'search:*', 'shell:*'],
    disallowedTools: ['canvas:*', 'show_widget'],
    promptProfile: {
      enableSections: ['generalTaskGuidance'],
      disableSections: ['taskHandling', 'widgetGuidelines'],
    },
    promptSystem: 'general',
    userVisible: false,
    isPreset: true,
    isEnabled: true,
    createdAt: 0,
    updatedAt: 0,
  },
  {
    id: 'conductor-refine',
    name: 'Conductor Refine',
    description:
      'Side-panel agent that iteratively refines a single Conductor widget’s data from a screenshot + user instruction. Returns strict JSON only — the renderer applies the result via widget.update_data.',
    allowedTools: ['Read', 'vision_analyze'],
    disallowedTools: [
      'Agent',
      'canvas_*',
      'show_widget',
      'file:write*',
      'file:edit*',
      'exec:*',
      'browser:*',
      'gateway:*',
      'cron',
      'duya:*',
      'memory',
      'SessionSearch',
      'WebSearch',
      'WebFetch',
    ],
    promptProfile: {
      disableSections: [
        'taskHandling',
        'memory',
        'skills',
        'sessionGuidance',
        'agentsMd',
        'widgetGuidelines',
        'visionGuidelines',
        'actions',
      ],
    },
    promptSystem: 'general',
    userVisible: false,
    isPreset: true,
    isEnabled: true,
    createdAt: 0,
    updatedAt: 0,
  },
];
