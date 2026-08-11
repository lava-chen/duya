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
}

export interface AgentConfig {
  max_turns: number;
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
  voice: Record<string, unknown>;
  delegation: Record<string, unknown>;

  session_reset: Record<string, unknown>;
  channels: ChannelsConfig;
  gateway_proxy: GatewayProxyConfig;
  approvals: Record<string, unknown>;
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
}

export const DEFAULT_CONFIG: DuyaConfig = {
  _config_version: 1,
  storage: { database_path: '', rollout_root: '', attachments_root: '' },
  model: { default: '', provider: '', base_url: '' },
  providers: {},
  memory: { memory_enabled: true, user_profile_enabled: true, provider: '', model: '' },
  agent: {
    max_turns: 90,
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
  },
  terminal: {},
  browser: {},
  checkpoints: {},
  compression: {},
  auxiliary: {},
  display: {},
  privacy: {},
  security: { redact_secrets: true, secrets_encrypted: false },
  tts: {},
  stt: { enabled: true },
  voice: {},
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