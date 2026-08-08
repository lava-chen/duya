/**
 * migrate.ts — one-way migration of the legacy config sources into
 * `~/.duya/config.toml` + `~/.duya/secrets.json` (plan 334, Phase 3).
 *
 * Sources (deleted after a successful migration):
 *   - settings.json            -> providers / model / memory / agent / display / auxiliary
 *   - mcp.toml                 -> mcp_servers
 *   - SQLite `settings` table  -> channels / gateway_proxy / skills
 *   - SQLite `weixin_accounts` -> channels.adapters.weixin.accounts
 *   - SQLite `automation_crons`-> cron.jobs
 *   - plugins/registry.json    -> plugins
 *   - marketplaces/known_marketplaces.json -> marketplaces
 *   - boot.json                -> deleted (storage handled by boot-config)
 *
 * Idempotent: `config.toml` already existing short-circuits to `{ skipped: true }`.
 * Never deletes a source that failed to parse/decrypt (settings.json is
 * safeStorage-encrypted; an undecryptable file is kept, others still migrate).
 */

import fs from 'fs';
import path from 'path';
import { safeStorage } from 'electron';
import { parseUserMcpToml } from '@duya/plugin-core/src/mcp/user-config.js';
import { getLogger, LogComponent } from '../logging/logger';
import { ConfigStore } from './store';
import type { CronJob, SkillConfigEntry } from './schema';

const logger = getLogger();

export interface MigrateOptions {
  store: ConfigStore;
  configPath: string;
  secretsPath: string;
  settingsPath?: string;
  mcpTomlPath?: string;
  registryPath?: string;
  marketplacesPath?: string;
}

export interface MigrateResult {
  skipped: boolean;
  migrated?: boolean;
}

/** Row returned by the SQLite driver (better-sqlite3 or a test fake). */
interface SqliteRow {
  [column: string]: unknown;
}

/** Structural subset of better-sqlite3 used by the migration (test-injectable). */
export interface MigrateDb {
  prepare(sql: string): {
    get(...params: unknown[]): SqliteRow | undefined;
    all(...params: unknown[]): SqliteRow[];
  };
}

/**
 * Migrate every legacy source into `config.toml` + `secrets.json`, then delete
 * the successfully-migrated source files. Returns `{ skipped: true }` when
 * `config.toml` already exists (idempotent restart guard).
 */
export function migrateConfig(db: MigrateDb, opts: MigrateOptions): MigrateResult {
  if (fs.existsSync(opts.configPath)) {
    return { skipped: true };
  }

  const dir = path.dirname(opts.configPath);
  const migratedPaths: string[] = [];

  const settingsPath = opts.settingsPath ?? path.join(dir, 'settings.json');
  if (migrateSettingsJson(opts.store, settingsPath)) migratedPaths.push(settingsPath);

  const mcpTomlPath = opts.mcpTomlPath ?? path.join(dir, 'mcp.toml');
  if (migrateMcpToml(opts.store, mcpTomlPath)) migratedPaths.push(mcpTomlPath);

  migrateSqliteRows(opts.store, db);
  migrateSkillOverrides(opts.store, db);

  const registryPath = opts.registryPath ?? path.join(dir, '..', 'plugins', 'registry.json');
  if (migratePluginRegistry(opts.store, registryPath)) migratedPaths.push(registryPath);

  const marketplacesPath = opts.marketplacesPath ?? path.join(dir, '..', 'marketplaces', 'known_marketplaces.json');
  if (migrateKnownMarketplaces(opts.store, marketplacesPath)) migratedPaths.push(marketplacesPath);

  // Ensure config.toml exists even when nothing was migrated, so the
  // `fs.existsSync(configPath)` guard stays a reliable idempotency check.
  if (!fs.existsSync(opts.configPath)) {
    opts.store.set('_config_version', opts.store.get()._config_version);
  }

  // Sources are deleted only after every `store.set()` above has persisted
  // (each write flushes config.toml + secrets.json atomically). boot.json is
  // always eligible for deletion once the TOML merge succeeded.
  deleteSources(migratedPaths, path.join(dir, 'boot.json'));

  return { skipped: false, migrated: true };
}

// =============================================================================
// settings.json
// =============================================================================

/**
 * Read the legacy safeStorage-encrypted (base64) settings.json. Falls back to
 * plaintext JSON when encryption is unavailable (e.g. vitest/Node) or when
 * decryption fails. Returns `undefined` (and keeps the source) if neither
 * path yields valid JSON.
 */
function readSettingsFile(settingsPath: string): Record<string, unknown> | undefined {
  if (!fs.existsSync(settingsPath)) return undefined;
  try {
    const raw = fs.readFileSync(settingsPath, 'utf-8');
    const ss = getSafeStorage();
    if (ss && ss.isEncryptionAvailable()) {
      try {
        return JSON.parse(ss.decryptString(Buffer.from(raw, 'base64'))) as Record<string, unknown>;
      } catch {
        // fall through to plaintext JSON
      }
    }
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    // Encrypted-but-undecryptable or invalid JSON: keep the source file.
    return undefined;
  }
}

function migrateSettingsJson(store: ConfigStore, settingsPath: string): boolean {
  const settings = readSettingsFile(settingsPath);
  if (!settings) return false;

  // apiProviders -> providers.<id>.* (apiKey split to secrets.json)
  const apiProviders = settings.apiProviders;
  const activeProviderIds: string[] = [];
  if (apiProviders && typeof apiProviders === 'object') {
    for (const [id, p] of Object.entries(apiProviders as Record<string, Record<string, unknown>>)) {
      if (!p || typeof p !== 'object') continue;
      if (typeof p.name === 'string') store.set(`providers.${id}.name`, p.name);
      if (typeof p.providerType === 'string') store.set(`providers.${id}.providerType`, p.providerType);
      if (typeof p.baseUrl === 'string') store.set(`providers.${id}.baseUrl`, p.baseUrl);
      if (p.options !== undefined) store.set(`providers.${id}.options`, p.options);
      if (p.enabled_models !== undefined) store.set(`providers.${id}.enabled_models`, p.enabled_models);
      if (typeof p.apiKey === 'string' && p.apiKey) store.set(`providers.${id}.apiKey`, p.apiKey);
      if (p.isActive === true) activeProviderIds.push(id);
    }
  }

  // pointers -> model / memory
  if (typeof settings.defaultProviderId === 'string' && settings.defaultProviderId) {
    store.set('model.provider', settings.defaultProviderId);
  } else if (activeProviderIds.length === 1) {
    // Legacy single-active-provider model (old `migrateMultiProviderV1`): when
    // no explicit default exists but exactly one provider is flagged active,
    // promote it to the default so the soft-default model stays whole.
    store.set('model.provider', activeProviderIds[0]!);
  }
  if (typeof settings.memoryProviderId === 'string' && settings.memoryProviderId) {
    store.set('memory.provider', settings.memoryProviderId);
  }
  if (typeof settings.memoryModelId === 'string' && settings.memoryModelId) {
    store.set('memory.model', settings.memoryModelId);
  }

  // agentSettings -> model.default / agent.* (mappable fields only)
  const agentSettings = settings.agentSettings;
  if (agentSettings && typeof agentSettings === 'object') {
    const ag = agentSettings as Record<string, unknown>;
    if (typeof ag.defaultModel === 'string') store.set('model.default', ag.defaultModel);
    if (typeof ag.temperature === 'number') store.set('agent.temperature', ag.temperature);
    if (typeof ag.maxTokens === 'number') store.set('agent.max_tokens', ag.maxTokens);
    if (typeof ag.sandboxEnabled === 'boolean') store.set('agent.sandbox_enabled', ag.sandboxEnabled);
    if (typeof ag.maxConcurrentTools === 'number') store.set('agent.max_concurrent_tools', ag.maxConcurrentTools);
    if (typeof ag.defaultTimeout === 'number') store.set('agent.default_timeout', ag.defaultTimeout);
  }

  // uiPreferences -> display.*
  const ui = settings.uiPreferences;
  if (ui && typeof ui === 'object') {
    const uip = ui as Record<string, unknown>;
    if (typeof uip.theme === 'string') store.set('display.theme', uip.theme);
    if (typeof uip.sidebarWidth === 'number') store.set('display.sidebar_width', uip.sidebarWidth);
    if (typeof uip.fontSize === 'number') store.set('display.font_size', uip.fontSize);
    if (typeof uip.showLineNumbers === 'boolean') store.set('display.show_line_numbers', uip.showLineNumbers);
  }

  // visionSettings -> auxiliary.vision (apiKey split via .apiKey)
  const vision = settings.visionSettings;
  if (vision && typeof vision === 'object') {
    const v = vision as Record<string, unknown>;
    const target: Record<string, unknown> = {};
    if (typeof v.provider === 'string') target.provider = v.provider;
    if (typeof v.model === 'string') target.model = v.model;
    if (typeof v.baseUrl === 'string') target.baseUrl = v.baseUrl;
    if (typeof v.enabled === 'boolean') target.enabled = v.enabled;
    if (Object.keys(target).length > 0) store.set('auxiliary.vision', target);
    if (typeof v.apiKey === 'string' && v.apiKey) store.set('auxiliary.vision.apiKey', v.apiKey);
  }

  return true;
}

function getSafeStorage(): typeof safeStorage | undefined {
  // In the Electron main process this is the real API. Under vitest (plain
  // Node) `require('electron')` resolves to the binary path string, so the
  // named export is `undefined` — treat as "encryption unavailable" and fall
  // back to plaintext parsing.
  if (safeStorage && typeof safeStorage.isEncryptionAvailable === 'function') {
    return safeStorage;
  }
  return undefined;
}

// =============================================================================
// mcp.toml
// =============================================================================

function migrateMcpToml(store: ConfigStore, mcpTomlPath: string): boolean {
  if (!fs.existsSync(mcpTomlPath)) return false;
  try {
    const servers = parseUserMcpToml(fs.readFileSync(mcpTomlPath, 'utf-8'));
    for (const s of servers) {
      store.set(`mcp_servers.${s.name}`, {
        name: s.name,
        transport: s.transport,
        command: s.command,
        args: s.args,
        url: s.url,
        headers: s.headers,
        enabled: s.enabled,
        allowedAgentIds: s.allowedAgentIds,
        // env secrets are split to secrets.json by ConfigStore ('.env.')
        env: s.env,
      });
    }
    return true;
  } catch {
    // Parse failure: keep the source file.
    return false;
  }
}

// =============================================================================
// SQLite settings / weixin_accounts / automation_crons
// =============================================================================

/**
 * Migrate the SQLite `settings` table (gateway/channel keys), the
 * `weixin_accounts` table and the `automation_crons` table into config.toml.
 * Exported separately so tests can inject fake rows.
 */
export function migrateSqliteRows(store: ConfigStore, db: MigrateDb): void {
  const getSetting = (key: string): string | undefined => {
    const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value?: string } | undefined;
    return row?.value;
  };
  const parseSetting = (key: string): unknown => {
    const v = getSetting(key);
    if (v === undefined) return undefined;
    try {
      return JSON.parse(v);
    } catch {
      return v;
    }
  };

  // gatewayModel -> channels.gateway_model
  const gatewayModel = parseSetting('gatewayModel');
  if (typeof gatewayModel === 'string' && gatewayModel) store.set('channels.gateway_model', gatewayModel);

  // gatewayProxyConfig -> gateway_proxy (globalEnabled -> global_enabled)
  const gw = parseSetting('gatewayProxyConfig');
  if (gw && typeof gw === 'object') {
    const g = gw as Record<string, unknown>;
    const target: Record<string, unknown> = { channels: (g.channels as Record<string, unknown>) ?? {} };
    if (typeof g.globalEnabled === 'boolean') target.global_enabled = g.globalEnabled;
    store.set('gateway_proxy', target);
  }

  // channels top-level
  const autoStart = parseSetting('bridge_auto_start');
  if (autoStart === true || autoStart === false) store.set('channels.auto_start', autoStart);
  const workspace = parseSetting('bridge_workspace');
  if (typeof workspace === 'string') store.set('channels.workspace', workspace);
  const proxyUrl = parseSetting('bridge_proxy_url');
  if (typeof proxyUrl === 'string') store.set('channels.proxy_url', proxyUrl);

  // --- channel adapters (credentials -> channels.adapters.<platform>.credentials.*) ---

  // weixin
  const weixinEnabled = parseSetting('bridge_weixin_enabled');
  const weixinToken = parseSetting('weixin_bot_token');
  const weixinAid = parseSetting('weixin_account_id');
  const weixinBase = parseSetting('weixin_base_url');
  if (weixinEnabled === true || (typeof weixinToken === 'string' && weixinToken && typeof weixinAid === 'string' && weixinAid)) {
    store.set('channels.adapters.weixin.id', 'weixin');
    store.set('channels.adapters.weixin.enabled', weixinEnabled === true);
    if (typeof weixinToken === 'string' && weixinToken) store.set('channels.adapters.weixin.credentials.token', weixinToken);
    if (typeof weixinBase === 'string' && weixinBase) store.set('channels.adapters.weixin.base_url', weixinBase);
  }

  // telegram
  const telegramOn = parseSetting('bridge_telegram_enabled');
  const telegramToken = parseSetting('telegram_bot_token');
  if (telegramOn === true || (typeof telegramToken === 'string' && telegramToken)) {
    store.set('channels.adapters.telegram', { id: 'telegram', enabled: telegramOn === true });
    if (typeof telegramToken === 'string' && telegramToken) store.set('channels.adapters.telegram.credentials.token', telegramToken);
  }

  // qq
  const qqOn = parseSetting('bridge_qq_enabled');
  const qqAppId = parseSetting('bridge_qq_app_id');
  const qqAppSecret = parseSetting('bridge_qq_app_secret');
  if (qqOn === true || (typeof qqAppId === 'string' && qqAppId && typeof qqAppSecret === 'string' && qqAppSecret)) {
    store.set('channels.adapters.qq', { id: 'qq', enabled: qqOn === true, app_id: typeof qqAppId === 'string' ? qqAppId : '' });
    if (typeof qqAppSecret === 'string' && qqAppSecret) store.set('channels.adapters.qq.credentials.app_secret', qqAppSecret);
  }

  // feishu
  const feishuOn = parseSetting('bridge_feishu_enabled');
  const feishuAppId = parseSetting('bridge_feishu_app_id');
  const feishuAppSecret = parseSetting('bridge_feishu_app_secret');
  if (feishuOn === true || (typeof feishuAppId === 'string' && feishuAppId)) {
    store.set('channels.adapters.feishu', { id: 'feishu', enabled: feishuOn === true, app_id: typeof feishuAppId === 'string' ? feishuAppId : '' });
    if (typeof feishuAppSecret === 'string' && feishuAppSecret) store.set('channels.adapters.feishu.credentials.app_secret', feishuAppSecret);
  }

  // --- weixin_accounts -> channels.adapters.weixin.accounts (token to secrets) ---
  const accountRows = db.prepare(
    'SELECT account_id, user_id, name, base_url, cdn_base_url, token, enabled FROM weixin_accounts',
  ).all();
  if (accountRows.length > 0) {
    const accounts = accountRows.map((r) => ({
      account_id: String(r.account_id ?? ''),
      user_id: String(r.user_id ?? ''),
      name: String(r.name ?? ''),
      base_url: String(r.base_url ?? ''),
      cdn_base_url: String(r.cdn_base_url ?? ''),
      enabled: Boolean(r.enabled),
    }));
    store.set('channels.adapters.weixin.accounts', accounts);
    for (const r of accountRows) {
      if (typeof r.token === 'string' && r.token) {
        store.set(`channels.adapters.weixin.credentials.${String(r.account_id)}.token`, r.token);
      }
    }
  }

  // --- automation_crons -> cron.jobs ---
  const cronRows = db.prepare(
    'SELECT id, name, description, schedule_kind, schedule_at, schedule_every_ms, schedule_cron_expr, schedule_cron_tz, schedule_end_at, workflow_id, working_directory, prompt, input_params, model, status, concurrency_policy, max_retries FROM automation_crons',
  ).all();
  if (cronRows.length > 0) {
    const jobs: CronJob[] = cronRows.map((c) => ({
      id: String(c.id ?? ''),
      name: String(c.name ?? ''),
      description: typeof c.description === 'string' ? c.description : undefined,
      schedule_kind: (c.schedule_kind as CronJob['schedule_kind']) ?? 'every',
      schedule_at: typeof c.schedule_at === 'string' ? c.schedule_at : undefined,
      schedule_every_ms: typeof c.schedule_every_ms === 'number' ? c.schedule_every_ms : undefined,
      schedule_cron_expr: typeof c.schedule_cron_expr === 'string' ? c.schedule_cron_expr : undefined,
      schedule_cron_tz: typeof c.schedule_cron_tz === 'string' ? c.schedule_cron_tz : undefined,
      schedule_end_at: typeof c.schedule_end_at === 'string' ? c.schedule_end_at : undefined,
      workflow_id: typeof c.workflow_id === 'string' ? c.workflow_id : undefined,
      working_directory: String(c.working_directory ?? ''),
      prompt: String(c.prompt ?? ''),
      input_params: safeJson(typeof c.input_params === 'string' ? c.input_params : '{}'),
      model: String(c.model ?? ''),
      status: (c.status as CronJob['status']) ?? 'enabled',
      concurrency_policy: (c.concurrency_policy as CronJob['concurrency_policy']) ?? 'skip',
      max_retries: typeof c.max_retries === 'number' ? c.max_retries : 3,
    }));
    store.set('cron.jobs', jobs);
  }
}

function safeJson(text: string): Record<string, unknown> {
  try {
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    return {};
  }
}

// =============================================================================
// skillEnabledOverrides -> [[skills.config]] (decision 15)
// =============================================================================

function migrateSkillOverrides(store: ConfigStore, db: MigrateDb): void {
  const row = db
    .prepare("SELECT value FROM settings WHERE key = 'skillEnabledOverrides'")
    .get() as { value?: string } | undefined;
  if (!row?.value) return;
  let overrides: Record<string, boolean>;
  try {
    overrides = JSON.parse(row.value) as Record<string, boolean>;
  } catch {
    return;
  }
  const entries: SkillConfigEntry[] = [];
  for (const [name, enabled] of Object.entries(overrides)) {
    // Only disabled overrides land; enabled is the default state.
    if (enabled === false) entries.push({ name, enabled: false });
  }
  if (entries.length > 0) store.set('skills', entries);
}

// =============================================================================
// plugins / marketplaces
// =============================================================================

function migratePluginRegistry(store: ConfigStore, registryPath: string): boolean {
  if (!fs.existsSync(registryPath)) return false;
  try {
    const parsed = JSON.parse(fs.readFileSync(registryPath, 'utf-8')) as Record<string, unknown>;
    const installed = (parsed.installed ?? parsed.plugins ?? {}) as Record<string, Record<string, unknown>>;
    for (const [id, entry] of Object.entries(installed)) {
      if (!entry || typeof entry !== 'object') continue;
      const marketplace = typeof entry.marketplace === 'string' ? entry.marketplace : 'builtin';
      // Decision 11: only `enabled` is persisted; the rest is derived.
      store.set(`plugins.${id}@${marketplace}`, { enabled: Boolean(entry.enabled) });
    }
    return true;
  } catch {
    return false;
  }
}

function migrateKnownMarketplaces(store: ConfigStore, marketplacesPath: string): boolean {
  if (!fs.existsSync(marketplacesPath)) return false;
  try {
    const parsed = JSON.parse(fs.readFileSync(marketplacesPath, 'utf-8'));
    store.set('marketplaces', parsed);
    return true;
  } catch {
    return false;
  }
}

// =============================================================================
// source deletion
// =============================================================================

function deleteSources(migratedPaths: string[], bootPath: string): void {
  const toDelete = [...migratedPaths];
  if (fs.existsSync(bootPath)) toDelete.push(bootPath);
  for (const p of toDelete) {
    try {
      if (fs.existsSync(p)) fs.unlinkSync(p);
    } catch {
      // Never throw during cleanup; the config merge already succeeded.
      logger.warn('Failed to delete legacy config source', { path: p }, LogComponent.ConfigManager);
    }
  }
}
