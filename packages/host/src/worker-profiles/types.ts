/**
 * Agent profile persistence types and preset declarations.
 *
 * The cross-layer profile contract is owned by @duya/agent-core and re-exported
 * here for existing package consumers.
 */

import type { AgentProfile } from '@duya/agent-core';

export type {
  AgentProfile,
  AgentProfileKind,
  PromptProfileOverride,
} from '@duya/agent-core';

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
  prompt_profile: string | null;
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
    promptProfile: {
      // General sessions need core operating guidance, but must not inherit
      // every volatile session-history section. Expressed as a DENYLIST, not
      // the old enableSections whitelist: sections added to the config later
      // default to visible for General — the safe failure direction (the
      // whitelist silently hid the skills catalog for its entire lifetime,
      // plan 535 A-6 / plan 557 phase 2). Cut sections:
      //   configProtection / outputStyle / mcp / scratchpad /
      //   sessionSearch / sessionGuidance /
      //   visionGuidelines / visualVerification
      disableSections: [
        'configProtection', 'outputStyle', 'mcp', 'scratchpad',
        'sessionSearch', 'sessionGuidance',
        'visionGuidelines', 'visualVerification',
      ],
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
    disallowedTools: ['show_widget', 'cron', 'duya:*', 'memory', 'send_artifact'],
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
    disallowedTools: ['write', 'edit', 'bash', 'powershell', 'browser'],
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
    disallowedTools: ['write', 'edit', 'bash', 'powershell', 'browser'],
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
    // Gateway is a capable channel agent with full desktop-level tooling
    // (write/edit, shell, todo, vision, self-management via duya_cli).
    // It still denies:
    //   - interactive tools that require a desktop UI
    //   - recursive subagent spawning (avoid runaway)
    //   - interactive permission/mode flows that need a desktop UI
    identityPrompt:
      'You are Duya, a capable channel agent running in a messaging platform. ' +
      'Handle the user\'s request directly with the tools available to you. ' +
      'Use other sessions only when their existing context is genuinely relevant.',
    allowedTools: ['*'],
    disallowedTools: [
      'show_widget',
      'AskUserQuestion',
      // Recursive subagent spawning — avoid runaway in a stateless channel.
      'task',
      'memory',
      'read_module',
      'EnterPlanMode', 'ExitPlanMode', 'SwitchMode',
    ],
    promptProfile: {
      // Code-profile-only sections (no-ops in the gateway config) stay
      // disabled; memory/sessionGuidance/skills/tasks are enabled for
      // full-capability parity with the desktop agent.
      disableSections: ['memoryContent', 'rules', 'personality', 'agentsMd', 'projectContinuity'],
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
      // Curator runs headless.
      'show_widget', 'AskUserQuestion',
      // No browser, no self-management, no module loader.
      'browser', 'duya_cli', 'read_module', 'todo', 'tool_catalog', 'skill',
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
