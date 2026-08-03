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
      // General sessions need core operating guidance, but must not inherit
      // every volatile capability, skill, and session-history section.
      enableSections: [
        'identity', 'communication', 'finalAnswer', 'system', 'tasks',
        'destructiveActions', 'tools', 'project', 'duyaDesktopContext',
        'language', 'platform', 'environment', 'memory',
      ],
      disableSections: ['rules', 'memoryContent'],
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
    disallowedTools: ['show_widget', 'cron', 'duya:*', 'canvas:*', 'memory'],
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
    disallowedTools: ['Agent', 'duya_*'],
    promptProfile: {
      disableSections: ['rules'],
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
    description: 'Channel agent for messaging platforms — handles tasks directly and can consult other sessions when useful',
    // Gateway is a capable channel agent. It allows ['*'] then denies:
    //   - write tools that require a desktop permission surface
    //   - interactive/UI/canvas/management tools (no desktop surface)
    //   - recursive subagent spawning (avoid runaway)
    // Read-only shell commands are intentionally available so channel tasks
    // such as locating and sending a local file can complete without making
    // the user copy data into the gateway workspace first.
    identityPrompt:
      'You are Duya, a capable channel agent running in a messaging platform. ' +
      'Handle the user\'s request directly with the tools available to you. ' +
      'Use other sessions only when their existing context is genuinely relevant.',
    allowedTools: ['*'],
    disallowedTools: [
      // Write operations need an interactive permission surface that channel
      // sessions do not have. Bash/PowerShell remain available; their own
      // security classifier gates commands that require approval.
      'write', 'edit',
      // Interactive/UI/canvas — no desktop surface in a channel.
      'canvas:*',
      'show_widget',
      'AskUserQuestion',
      // Recursive subagent spawning — avoid runaway in a stateless channel.
      'Agent',
      // Self-management — gateway has no desktop settings UI to drive.
      'duya_cli',
      'memory',
      'read_module',
      'task',
      'EnterPlanMode', 'ExitPlanMode', 'SwitchMode',
      'vision_analyze',
    ],
    promptProfile: {
      disableSections: ['memory', 'memoryContent', 'sessionGuidance', 'skills', 'generalTaskGuidance', 'rules', 'personality', 'agentsMd', 'projectGrounding', 'projectContinuity'],
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
      'EnterPlanMode', 'ExitPlanMode', 'SwitchMode',
    ],
    promptProfile: {
      // The 'rules' chapter (which fuses the old 'doingTasks' and
      // parts of the old 'actions' section) repeatedly instructs "ask
      // the user before proceeding" — in a cron context there is no
      // user to ask, so the agent would hang. Remove it.
      disableSections: ['rules'],
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
    ],
    promptProfile: {
      disableSections: [
        'rules',
        'memory',
        'skills',
        'sessionGuidance',
        'agentsMd',
        'projectGrounding',
        'projectContinuity',
        'widgetGuidelines',
        'visionGuidelines',
      ],
    },
    promptSystem: 'general',
    userVisible: false,
    isPreset: true,
    isEnabled: true,
    createdAt: 0,
    updatedAt: 0,
  },
  {
    id: 'memory-curator',
    name: 'Memory Curator',
    description:
      'Phase 2 memory curation agent — root-bound file tools only, no shell/MCP/skills',
    // Defense-in-depth whitelist: the curator process entry only registers
    // these 5 tools, so the profile filter is a second layer in case the
    // profile is ever reused in a process that registers more tools.
    allowedTools: ['read', 'write', 'edit', 'grep', 'glob'],
    disallowedTools: [
      // No shell — the curator never executes commands.
      'bash', 'powershell',
      // No recursive subagent spawning.
      'Agent',
      // No interactive / UI / canvas surface — curator runs headless.
      'canvas:*', 'show_widget', 'AskUserQuestion',
      // No browser, no self-management, no module loader.
      'browser', 'duya_cli', 'read_module', 'task', 'tool_search', 'skill',
      // No mode-switching side effects.
      'EnterPlanMode', 'ExitPlanMode', 'SwitchMode',
      // No session-to-session messaging or vision.
      'session_search', 'message_session', 'vision_analyze',
    ],
    promptProfile: {
      // Memory content is the curator's INPUT data, not context about
      // itself. Skills, AGENTS.md, project grounding, and the "ask the
      // user" rules are all irrelevant or harmful in a headless curation
      // run (design §7.3, §7.5).
      disableSections: [
        'memory', 'memoryContent', 'skills', 'sessionGuidance',
        'agentsMd', 'projectGrounding', 'projectContinuity',
        'visionGuidelines', 'rules',
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
