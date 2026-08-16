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

  /** Optional full agent global instructions (loaded from config `agents_md`),
   *  injected as an extra <system-reminder> block. Config-driven custom
   *  agents only; not persisted to the DB. */
  globalInstructions?: string;

  /** Whether this profile is selectable by users in the UI */
  userVisible: boolean;
  /** Whether this is a preset profile */
  isPreset: boolean;
  /** Whether this profile is enabled */
  isEnabled: boolean;
  /**
   * Structural grouping of the profile. 'main' are the user-facing main
   * agents (general-purpose / code-expert / research); 'subagent' are the
   * read-only sub-agent profiles; 'special' are infrastructure agents
   * (gateway / cron / conductor-refine / memory-curator) that never appear
   * in user-facing pickers. This is the canonical grouping — `userVisible`
   * is a legacy boolean kept for compatibility.
   */
  kind?: 'main' | 'subagent' | 'special';
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
  profile_kind: string | null;
  user_visible: number;
  is_preset: number;
  is_enabled: number;
  created_at: number;
  updated_at: number;
}

// ============================================================
// Preset Definitions
//
// Presets are grouped structurally by `kind`:
//   - MAIN_AGENT_PROFILES    user-facing main agents (main / code / research)
//   - SUBAGENT_AGENT_PROFILES read-only sub-agent profiles (explore / plan)
//   - SPECIAL_AGENT_PROFILES  infrastructure agents (gateway / cron / ...)
// PRESET_AGENT_PROFILES is the flat union kept for consumers that want the
// full registry at once.
// ============================================================

export const MAIN_AGENT_PROFILES: AgentProfile[] = [
  {
    id: 'general-purpose',
    kind: 'main',
    name: 'General',
    description: 'General purpose assistant for most tasks',
    allowedTools: ['*'],
    // send_artifact is a gateway-channel delivery tool (no channel consumes
    // it in desktop sessions) — keep it gateway-only.
    disallowedTools: ['send_artifact'],
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
    kind: 'main',
    name: 'Code',
    description: 'Code development and software engineering',
    allowedTools: ['*'],
    disallowedTools: ['show_widget', 'cron', 'duya:*', 'canvas:*', 'memory', 'send_artifact'],
    promptSystem: 'code',
    userVisible: true,
    isPreset: true,
    isEnabled: true,
    createdAt: 0,
    updatedAt: 0,
  },
  {
    id: 'research',
    kind: 'main',
    name: 'Research',
    description: 'Research, investigation and deep analysis',
    allowedTools: ['*'],
    // canvas_* removed: conductor canvas tools are gated by the session
    // conductorMode toggle. Research mode can still use canvas tools when
    // the user explicitly enables conductor mode.
    disallowedTools: ['task', 'duya_*', 'send_artifact'],
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
];

export const SUBAGENT_AGENT_PROFILES: AgentProfile[] = [
  {
    id: 'explore',
    kind: 'subagent',
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
    kind: 'subagent',
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
];

export const SPECIAL_AGENT_PROFILES: AgentProfile[] = [
  {
    id: 'gateway',
    kind: 'special',
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
      'task',
      // Self-management — gateway has no desktop settings UI to drive.
      'duya_cli',
      'memory',
      'read_module',
      'todo',
      'EnterPlanMode', 'ExitPlanMode', 'SwitchMode',
      'vision_analyze',
    ],
    promptProfile: {
      disableSections: ['memory', 'memoryContent', 'sessionGuidance', 'skills', 'generalTaskGuidance', 'rules', 'personality', 'agentsMd', 'projectContinuity'],
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
    kind: 'special',
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
      'task',
      'canvas:*',
      'EnterPlanMode', 'ExitPlanMode', 'SwitchMode',
      'send_artifact',
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
    kind: 'special',
    name: 'Conductor Refine',
    description:
      'Side-panel agent that iteratively refines a single Conductor widget’s data from a screenshot + user instruction. Returns strict JSON only — the renderer applies the result via widget.update_data.',
    allowedTools: ['Read', 'vision_analyze'],
    disallowedTools: [
      'task',
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
    kind: 'special',
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
      'task',
      // No interactive / UI / canvas surface — curator runs headless.
      'canvas:*', 'show_widget', 'AskUserQuestion',
      // No browser, no self-management, no module loader.
      'browser', 'duya_cli', 'read_module', 'todo', 'tool_search', 'skill',
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
        'agentsMd', 'projectContinuity',
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

/**
 * Flat union of every preset (main + subagent + special). Consumers that
 * need the full registry at once use this; consumers that care about the
 * grouping should import from the specific arrays above.
 */
export const PRESET_AGENT_PROFILES: AgentProfile[] = [
  ...MAIN_AGENT_PROFILES,
  ...SUBAGENT_AGENT_PROFILES,
  ...SPECIAL_AGENT_PROFILES,
];
