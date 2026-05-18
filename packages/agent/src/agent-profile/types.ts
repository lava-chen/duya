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
    disallowedTools: ['file:Glob', 'file:Grep', 'canvas:*'],
    promptProfile: {
      disableSections: ['taskHandling'],
    },
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
    disallowedTools: ['show_widget', 'cron', 'duya:*', 'canvas:*', 'skill_manage', 'memory', 'SessionSearch'],
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
    allowedTools: ['file:read*', 'search:*', 'browser:*'],
    disallowedTools: ['file:write*', 'file:edit*', 'exec:*'],
    promptProfile: {
      disableSections: ['taskHandling', 'actions'],
    },
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
];
