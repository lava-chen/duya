/**
 * DuyaConfig — the complete `~/.duya/config.yaml` document shape.
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
  enabled_models?: string[];
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

export interface CronJob {
  id: string;
  name: string;
  description?: string;
  schedule_kind: 'at' | 'every' | 'cron';
  schedule_at?: string;
  schedule_every_ms?: number;
  schedule_cron_expr?: string;
  schedule_cron_tz?: string;
  schedule_end_at?: string;
  workflow_id?: string;
  working_directory: string;
  prompt: string;
  input_params: Record<string, unknown>;
  model: string;
  status: 'enabled' | 'disabled' | 'error';
  concurrency_policy: 'skip' | 'parallel' | 'queue' | 'replace';
  max_retries: number;
}

export interface ChannelAdapterEntry {
  id: string;
  enabled: boolean;
  [key: string]: unknown; // platform-specific fields; credentials split to secrets
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

  cron: { jobs: CronJob[] };

  session_reset: Record<string, unknown>;
  channels: ChannelsConfig;
  gateway_proxy: GatewayProxyConfig;
  approvals: Record<string, unknown>;
  command_allowlist: unknown[];

  mcp_servers: Record<string, McpServerEntry>;
  marketplaces: Record<string, unknown>;
  plugins: Record<string, PluginEntry>;

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
  cron: { jobs: [] },
  session_reset: {},
  channels: { auto_start: false, workspace: '', proxy_url: '', gateway_model: '', adapters: {} },
  gateway_proxy: { global_enabled: true, channels: {} },
  approvals: {},
  command_allowlist: [],
  mcp_servers: {},
  marketplaces: {},
  plugins: {},
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