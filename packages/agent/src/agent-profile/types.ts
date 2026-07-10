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
   * 'research', 'gateway'. Subsystem values (e.g. 'conductor' from
   * `@duya/conductor`) are registered at runtime via
   * `PromptsRegistry.register()`; the type is open (string) so the
   * agent typecheck does not need to be updated when a new system
   * lands. Defaults to 'general' if not specified.
   */
  promptSystem?: 'general' | 'code' | 'research' | 'gateway' | (string & {});

  /**
   * Optional one-line identity prompt prepended to the system prompt
   * by `buildAgentIdentityBlock`. When provided, it replaces the
   * generic "You are a \"<name>\" agent." block so a profile can
   * express its role in a single concise sentence. Preset-only field
   * (not persisted to the DB); user-created profiles fall back to the
   * generic block.
   */
  identityPrompt?: string;

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
    // Tool names must match the actual registered names (lowercase for
    // file/shell tools): read/glob/grep. The previous patterns
    // 'file:read*' / 'search:*' matched zero tools because the registry
    // stores names without namespace prefixes.
    allowedTools: ['read', 'glob', 'grep'],
    disallowedTools: ['write', 'edit', 'bash', 'powershell', 'browser', 'canvas:*'],
    promptProfile: {
      disableSections: ['memory', 'memoryContent', 'skills', 'sessionGuidance', 'visionGuidelines'],
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
    allowedTools: ['read', 'glob', 'grep'],
    disallowedTools: ['write', 'edit', 'bash', 'powershell', 'browser', 'canvas:*'],
    promptProfile: {
      disableSections: ['memory', 'memoryContent', 'skills', 'sessionGuidance', 'visionGuidelines'],
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
    description: 'Relay agent for messaging channels — passes messages between users and other session agents',
    // Gateway is a relay, not a worker. It allows ['*'] then denies:
    //   - write/exec tools (it should delegate, not do the work)
    //   - interactive/UI/canvas/management tools (no desktop surface)
    //   - recursive subagent spawning (avoid runaway)
    // MessageSession + SessionSearch are intentionally ALLOWED so the
    // gateway can talk to other session agents — that is its core job.
    identityPrompt:
      'You are a "Gateway" relay agent running in a messaging channel. ' +
      'Your job is to relay messages between the user and other session agents — ' +
      'not to do the work yourself. Answer quick questions directly; delegate ' +
      'anything that takes longer via MessageSession.',
    allowedTools: ['*'],
    disallowedTools: [
      // Write/exec — gateway relays, does not do work itself.
      'write', 'edit', 'bash', 'powershell',
      // Interactive/UI/canvas — no desktop surface in a channel.
      'canvas:*',
      'show_widget',
      'AskUserQuestion',
      // Recursive subagent spawning — avoid runaway in a stateless channel.
      'Agent',
      // Self-management — gateway has no desktop settings UI to drive.
      'duya_cli',
      'skill_manage',
      'memory',
      'read_module',
      'task',
      'enter_worktree', 'exit_worktree',
      'enter_plan_mode', 'exit_plan_mode', 'switch_mode',
      'team_create', 'team_delete',
      'list_mcp_resources', 'read_mcp_resource',
      'vision_analyze',
      'WebSearch', 'WebFetch',
    ],
    promptProfile: {
      // GatewayPromptSystem ignores generalTaskGuidance/actions/toolUsage
      // anyway (it does not render them), but keep the overrides for
      // clarity and in case a future caller falls back to GeneralPromptSystem.
      disableSections: ['memory', 'memoryContent', 'sessionGuidance', 'skills', 'generalTaskGuidance', 'actions', 'toolUsage', 'agentsMd', 'outputEfficiency'],
    },
    promptSystem: 'gateway',
    userVisible: false,
    isPreset: true,
    isEnabled: true,
    createdAt: 0,
    updatedAt: 0,
  },
  {
    id: 'cron',
    name: 'Cron',
    description: 'Cron agent for scheduled tasks — no user interaction available',
    // Cron runs without a user to answer questions. Deny interactive/UI
    // tools that would hang forever waiting for a response, plus recursive
    // agent spawning and mode-switching side effects. Keep read/write/edit/
    // shell/search tools so the cron job can perform real work.
    allowedTools: ['*'],
    disallowedTools: [
      'AskUserQuestion',
      'show_widget',
      'Agent',
      'canvas:*',
      'team_create', 'team_delete',
      'enter_plan_mode', 'exit_plan_mode', 'switch_mode',
      'enter_worktree', 'exit_worktree',
    ],
    promptProfile: {
      // The 'actions' section repeatedly instructs "ask the user before
      // proceeding" — in a cron context there is no user to ask, so the
      // agent would hang. Remove it.
      disableSections: ['actions'],
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
