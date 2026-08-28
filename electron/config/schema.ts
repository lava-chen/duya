/**
 * DuyaConfig — the complete `~/.duya/config.toml` document shape.
 * Single source of truth for the config surface. Secrets live in
 * `~/.duya/secrets.json`, never here.
 */

// ==== leaf shapes referenced by the top-level document ====
export interface StorageConfig {
  database_path: string;
  rollout_root: string;
  attachments_root: string;
}

export interface ModelConfig {
  default: string;
  provider: string;
  base_url: string;
}

export interface ProviderEntry {
  id: string;
  name: string;
  /** User-facing alias (nickname) for the provider, independent of
   *  the vendor name. Optional. Persisted to `config.toml` and
   *  loaded into the whole app via the provider DTO. */
  alias?: string;
  providerType: string;
  baseUrl: string;
  options?: Record<string, unknown>;
  // apiKey intentionally absent — split to secrets.json
}

export interface MemoryConfig {
  memory_enabled: boolean;
  user_profile_enabled: boolean;
  provider: string;
  model: string;
  /** `[memory.rag]` — retrievable memory index (plan 428). */
  rag?: MemoryRagConfig;
}

/**
 * `[memory.rag]` — vector + keyword index over user-configured scan paths.
 * Embedding provider/model resolve through the provider framework
 * (`embedding_provider`/`embedding_model` empty → memory provider/model);
 * credentials and endpoints are never stored here.
 */
export interface MemoryRagConfig {
  enabled: boolean;
  /** Index sqlite path; empty → `~/.duya/rag/memory-rag.db`. */
  index_path: string;
  /** Extra scan roots (absolute or `~/`-prefixed); the memory root is
   *  always scanned first. */
  scan_paths: string[];
  embedding_enabled: boolean;
  /** Provider id from the provider framework; empty → memory provider. */
  embedding_provider: string;
  /** Model id; empty → memory model. */
  embedding_model: string;
}

/** `[ide]` — external IDE integration for the file preview "Open" action.
 *  `default` holds the id of the preferred IDE (e.g. `vscode`, `cursor`,
 *  `trae`, `zed`). Leave empty to auto-pick the first detected IDE. */
export interface IdeConfig {
  default: string;
}

/**
 * `[computer_use]` — Computer Use Mode (plan 454) access policy. Default
 * is deny-by-default: every window_switch / click / type is refused
 * unless the foreground app matches `allowed_apps` (substring on
 * processName or window title, case-insensitive).
 *
 *   - `default_access`: "deny" (safe) or "allow" (trust-all)
 *   - `allowed_apps`: list of substrings; if any matches the
 *     foreground app's processName or title, the action proceeds
 *   - `denied_apps`: overrides `allowed_apps` — if a substring here
 *     matches, the action is always refused
 *   - `max_image_budget`: override the global
 *     DUYA_COMPUTER_USE_IMAGE_BUDGET; the agent truncates older
 *     screenshots in the projected message array to keep the LLM
 *     request bounded
 *
 * Matching is case-insensitive substring; glob wildcards (* / ?) are
 * supported in each entry. Both `processName` and `window title` are
 * tested independently — a process name match alone is enough to
 * permit, but a denied-pattern match is enough to refuse.
 */
export interface ComputerUseConfig {
  default_access?: 'deny' | 'allow';
  allowed_apps?: string[];
  denied_apps?: string[];
  max_image_budget?: number;
}

export interface AgentConfig {
  /**
   * Optional per-run agentic-turn cap. Absent (the default) means
   * uncapped — the agent loop runs until natural completion, token
   * exhaustion, abort, or a tool `terminate: true` signal. Pi-aligned
   * design: no implicit fallback. Set this to a positive integer as an
   * opt-in safety net for long-running automation.
   */
  max_turns?: number;
  gateway_timeout: number;
  restart_drain_timeout: number;
  tool_use_enforcement: string;
  gateway_timeout_warning: number;
  gateway_notify_interval: number;
  temperature: number;
  max_tokens: number;
  sandbox_enabled: boolean;
  max_concurrent_tools: number;
  default_timeout: number;
  /** Default permission mode for new sessions ('ask' | 'auto' | 'bypass'). */
  default_permission_mode: string;
  /**
   * Default handling for a chat message sent while the agent is already
   * running. 'followup' injects it at the next model-turn boundary
   * (steering); 'queued' holds it until just before the final answer, or
   * promotes it to a fresh user turn when the run ends. Mirrors the
   * mailbox row `kind` vocabulary.
   */
  busy_message_mode: 'followup' | 'queued';
}

/** [agents.<id>] — user-defined agent profile driven entirely by config.toml.
 *  id (map key) is the agent_profile_id used by sessions. Mirrors the
 *  openclaw AgentConfig surface (workspace / model / tools), kept minimal:
 *  model / workspace / system-prompt path / tools / plugins. */
export interface CustomAgentToolsConfig {
  /** Base tool profile: 'full' | 'coding' | 'minimal' | 'research' (maps to allow/deny presets). */
  profile?: string;
  /** Additional allowed tool patterns (wildcards supported, e.g. 'file:*'). */
  allow?: string[];
  /** Denied tool patterns; deny wins. */
  deny?: string[];
}

export interface CustomAgentConfig {
  /** Display name (falls back to the map key). */
  name?: string;
  /** One-line role description. */
  description?: string;
  /** Provider/model ref, e.g. 'anthropic/claude-sonnet-4-20250514'. Empty → fallback to config.model.default. */
  model?: string;
  /** This agent's own working directory. Empty → default workspace (~/.duya/workspace). */
  workspace?: string;
  /** Path to this agent's global instruction file (系统提示词配置路径). Empty → <workspace>/AGENTS.md. */
  agents_md?: string;
  /** Tool allow/deny/profile. */
  tools?: CustomAgentToolsConfig;
  /** Plugin / mcp references enabled for this agent (e.g. 'mcp:github'). */
  plugins?: string[];
}

/**
 * Desktop voice input config (`[voice]`). STT engine is local whisper.cpp by
 * default; cloud (OpenAI-compatible `/v1/audio/transcriptions`) is optional.
 * All fields are editable directly in config.toml.
 */
export interface VoiceConfig {
  enabled?: boolean;
  input_device?: string;
  stt?: {
    engine?: 'local' | 'cloud';
    end_silence_ms?: number;
    no_speech_timeout_ms?: number;
    chunk_ms?: number;
    language?: string;
    local?: {
      model?: string;
      /** Explicit whisper.cpp CLI path; overrides detection. */
      binary_path?: string;
      /** Mirror for ggml model downloads (default: huggingface.co). */
      model_url_base?: string;
      /** Mirror for prebuilt runtime downloads (default: github releases). */
      runtime_url_base?: string;
    };
    cloud?: {
      provider?: string;
      base_url?: string;
      size?: string;
    };
  };
}

export interface ChannelAdapterEntry {
  id: string;
  enabled: boolean;
  [key: string]: unknown; // platform-specific fields; credentials split to secrets
}

/** Telegram adapter DM topic config (`options.dm_topics_config`). */
export interface TelegramDmTopicsConfig {
  chat_id: number;
  topics: Array<{
    name: string;
    thread_id?: number;
    icon_color?: number;
    icon_custom_emoji_id?: string;
  }>;
}

/**
 * Options supported by the Telegram adapter (`channels.adapters.telegram.options`).
 * These mirror `packages/gateway/src/adapters/telegram/index.ts` and the group
 * gating module so users can align every setting directly in config.toml.
 * The bot token stays in secrets.json (`channels.adapters.telegram.credentials.token`).
 */
export interface TelegramAdapterOptions {
  account?: string;
  reply_to_mode?: 'first' | 'all' | 'off';
  disable_link_previews?: boolean;
  bot_api_server?: string;
  cron_thread_id?: number;
  status_indicator?: boolean;
  status_online?: string;
  status_offline?: string;
  require_pairing?: boolean;
  dm_topics?: boolean;
  dm_topics_group?: string;
  dm_topics_config?: TelegramDmTopicsConfig[];
  stt?: { enabled?: boolean };
  commands?: Array<{ command: string; description: string }>;
  command_menu?: {
    max_commands?: number;
    priority_mode?: 'prepend' | 'append' | 'replace';
    priority?: string[];
  };
  webhook_url?: string;
  webhook_port?: number;
  webhook_path?: string;
  webhook_secret?: string;
  // group gating (packages/gateway/src/adapters/telegram/handlers/group-gating.ts)
  free_response_chats?: string[];
  ignored_threads?: string[];
  require_mention?: boolean;
  mention_patterns?: string[];
  observe_unmentioned_group_messages?: boolean;
  allowed_chats?: string[];
  group_allowed_chats?: string[];
  allow_from?: string[];
  allow_admin_from?: string[];
  group_allow_from?: string[];
  group_allow_admin_from?: string[];
  user_allowed_commands?: string[];
  group_user_allowed_commands?: string[];
}

export interface TelegramAdapterEntry {
  id: string;
  enabled: boolean;
  options?: TelegramAdapterOptions;
  accounts?: Array<Record<string, unknown>>;
  credentials?: Record<string, unknown>; // token split to secrets.json
}

export interface ChannelsConfig {
  auto_start: boolean;
  workspace: string;
  proxy_url: string;
  gateway_model: string;
  adapters: Record<string, ChannelAdapterEntry>;
}

export interface GatewayProxyConfig {
  global_enabled: boolean;
  channels: Record<string, unknown>;
}

export interface McpServerEntry {
  name: string;
  transport?: 'stdio' | 'streamable-http';
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  headers?: Record<string, string>;
  enabled: boolean;
  allowedAgentIds?: string[];
  /** Short, stable prefix for model-visible tool names (`mcp_<nameOverride>_<tool>`). */
  nameOverride?: string;
  /** Startup (spawn + handshake + listTools) timeout in seconds. */
  startupTimeoutSec?: number;
  /** Default per-tool-call timeout in seconds for this server. */
  toolTimeoutSec?: number;
  /** Per-tool-call timeout overrides, keyed by tool name, in seconds. */
  toolTimeouts?: Record<string, number>;
}

export interface PluginEntry {
  enabled: boolean;
  version?: string;
  autoUpdate?: boolean;
  trustLevel?: string;
  scope?: string;
  marketplace?: string;
}

/** [[skills.config]] entry — per-skill enabled override (decision 15). */
export interface SkillConfigEntry {
  name: string;
  enabled: boolean;
}

/** [projects] entry — reserved per-project trust (decision 16, not wired). */
export interface ProjectEntry {
  trust_level: 'trusted' | 'untrusted';
  permission_mode?: string;
  sandbox?: string;
}

/**
 * `[performance]` (plan 426 Phase 3). `lowPower` gates renderer polling
 * slowdown, backdrop-filter downgrade, worker TTL shortening, and main
 * process service throttling. `'auto'` detects low-spec hardware once at
 * startup (`totalmem < 8GB || cpus <= 4`); no hot reload.
 */
export interface PerformanceConfig {
  lowPower: 'auto' | 'on' | 'off';
}

/** [apps] entry — reserved app/connector toggle (decision 17, not wired). */
export interface AppEntry {
  enabled: boolean;
}

export interface DuyaConfig {
  _config_version: number;

  storage: StorageConfig;
  model: ModelConfig;
  providers: Record<string, ProviderEntry>;
  memory: MemoryConfig;

  agent: AgentConfig;
  ide: IdeConfig;
  terminal: Record<string, unknown>;
  browser: Record<string, unknown>;
  checkpoints: Record<string, unknown>;
  compression: Record<string, unknown>;
  auxiliary: Record<string, unknown>;
  display: Record<string, unknown>;
  privacy: Record<string, unknown>;
  security: { redact_secrets: boolean; secrets_encrypted: boolean };
  tts: Record<string, unknown>;
  stt: Record<string, unknown>;
  voice: VoiceConfig;
  delegation: Record<string, unknown>;

  /** [computer_use] — Computer Use Mode (plan 454) access policy. */
  computer_use?: ComputerUseConfig;

  session_reset: Record<string, unknown>;
  channels: ChannelsConfig;
  gateway_proxy: GatewayProxyConfig;
  approvals: Record<string, unknown>;
  /** [app_connection_approvals."provider:toolAlias"] — Plan 449 global tool approvals. */
  app_connection_approvals: Record<string, 'allow'>;
  command_allowlist: unknown[];

  mcp_servers: Record<string, McpServerEntry>;
  plugins: Record<string, PluginEntry>;

  skills: SkillConfigEntry[]; // [[skills.config]] (decision 15)
  projects: Record<string, ProjectEntry>; // reserved (decision 16)
  features: Record<string, boolean>; // reserved (decision 17)
  apps: Record<string, AppEntry>; // reserved (decision 17)

  logging: Record<string, unknown>;
  code_execution: Record<string, unknown>;
  timezone: string;
  quick_commands: Record<string, unknown>;
  personalities: Record<string, unknown>;
  /** [agents.<id>] — config-driven custom agent profiles (Plan 424). */
  agents: Record<string, CustomAgentConfig>;
  /** [performance] — low-power mode switch (plan 426 Phase 3). */
  performance: PerformanceConfig;
}

export const DEFAULT_CONFIG: DuyaConfig = {
  _config_version: 1,
  storage: { database_path: '', rollout_root: '', attachments_root: '' },
  model: { default: '', provider: '', base_url: '' },
  providers: {},
  memory: {
    memory_enabled: true,
    user_profile_enabled: true,
    provider: '',
    model: '',
    rag: {
      enabled: false,
      index_path: '',
      scan_paths: [],
      embedding_enabled: true,
      embedding_provider: '',
      embedding_model: '',
    },
  },
  agent: {
    // No `max_turns` default — the agent is uncapped unless the user
    // explicitly sets it in `~/.duya/config.toml` (pi-aligned).
    gateway_timeout: 1800,
    restart_drain_timeout: 60,
    tool_use_enforcement: 'auto',
    gateway_timeout_warning: 900,
    gateway_notify_interval: 600,
    temperature: 0.7,
    max_tokens: 8192,
    sandbox_enabled: true,
    max_concurrent_tools: 3,
    default_timeout: 60000,
    default_permission_mode: 'ask',
    busy_message_mode: 'queued',
  },
  ide: { default: '' },
  terminal: {},
  browser: {
    // When true, web links clicked inside DUYA open in the system default
    // browser. When false, they open in DUYA's built-in side-panel browser.
    open_links_in_external_browser: true,
  },
  checkpoints: {},
  compression: {},
  auxiliary: {},
  display: {},
  privacy: {},
  security: { redact_secrets: true, secrets_encrypted: false },
  tts: {},
  stt: { enabled: true },
  // Computer Use Mode (plan 454) access policy. Default is
  // deny-by-default; the user must explicitly opt in to which apps
  // the model may automate. Override via config.toml
  // [computer_use] allowed_apps / denied_apps.
  computer_use: {
    default_access: 'deny',
    allowed_apps: [],
    denied_apps: [],
    max_image_budget: 5,
  },
  voice: {
    enabled: false,
    input_device: '',
    stt: {
      engine: 'local',
      end_silence_ms: 900,
      no_speech_timeout_ms: 4000,
      chunk_ms: 200,
      language: 'zh',
      local: {
        model: 'ggml-base.bin',
        binary_path: '',
        model_url_base: '',
        runtime_url_base: '',
      },
      cloud: { provider: '', base_url: '', size: 'whisper-1' },
    },
  },
  delegation: {},
  session_reset: {},
  channels: {
    auto_start: false,
    workspace: '',
    proxy_url: '',
    gateway_model: '',
    adapters: {
      // Telegram adapter template so the full option surface is visible and
      // editable in config.toml. The bot token lives in secrets.json under
      // `channels.adapters.telegram.credentials.token`.
      telegram: {
        id: 'telegram',
        enabled: false,
        options: {
          account: '',
          reply_to_mode: 'first',
          disable_link_previews: false,
          bot_api_server: '',
          cron_thread_id: 0,
          status_indicator: false,
          status_online: 'Online',
          status_offline: 'Offline',
          require_pairing: false,
          dm_topics: false,
          dm_topics_group: '',
          dm_topics_config: [],
          stt: { enabled: true },
          commands: [],
          command_menu: { max_commands: 60, priority_mode: 'prepend', priority: [] },
          webhook_url: '',
          webhook_port: 0,
          webhook_path: '',
          webhook_secret: '',
          free_response_chats: [],
          ignored_threads: [],
          require_mention: true,
          mention_patterns: [],
          observe_unmentioned_group_messages: false,
          allowed_chats: [],
          group_allowed_chats: [],
          allow_from: [],
          allow_admin_from: [],
          group_allow_from: [],
          group_allow_admin_from: [],
          user_allowed_commands: [],
          group_user_allowed_commands: [],
        },
        accounts: [],
      },
    },
  },
  gateway_proxy: { global_enabled: true, channels: {} },
  approvals: {},
  app_connection_approvals: {},
  command_allowlist: [],
  mcp_servers: {},
  plugins: {},
  skills: [], // [[skills.config]] (decision 15)
  projects: {}, // reserved (decision 16)
  features: {}, // reserved (decision 17)
  apps: {}, // reserved (decision 17)
  logging: {},
  code_execution: {},
  timezone: '',
  quick_commands: {},
  personalities: {},
  agents: {},
  performance: { lowPower: 'auto' },
  steering: {
    todo_gate: true,
    anti_dead_loop: { enabled: true, nudge_at: 8, hard_nudge_at: 12, hard_stop_at: 16 },
    tool_intent_nudge_max: 2,
  },
  hooks: { files: [] },
};

/** Deep-merge `partial` over a fresh copy of DEFAULT_CONFIG. */
export function mergeConfig(partial: Partial<DuyaConfig>): DuyaConfig {
  const base = JSON.parse(JSON.stringify(DEFAULT_CONFIG)) as DuyaConfig;
  return deepMerge(base, partial) as DuyaConfig;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function deepMerge(target: Record<string, unknown>, source: unknown): unknown {
  if (!isPlainObject(source)) return source;
  for (const [k, v] of Object.entries(source)) {
    const cur = target[k];
    target[k] = isPlainObject(cur) && isPlainObject(v) ? deepMerge(cur, v) : v;
  }
  return target;
}