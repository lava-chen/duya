import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { ConfigStore } from '../store';
import { migrateConfig, migrateSqliteRows, type MigrateOptions } from '../migrate';

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'duya-migrate-'));
}

interface FakeStmt {
  get(...args: unknown[]): unknown;
  all(...args: unknown[]): unknown[];
}

function fakeDb(settings: Array<{ key: string; value: string }>, opts?: { crons?: unknown[]; weixin?: unknown[] }): { prepare: (sql: string) => FakeStmt } {
  const crons = opts?.crons ?? [];
  const weixin = opts?.weixin ?? [];
  return {
    prepare(sql: string): FakeStmt {
      return {
        get(...args: unknown[]) {
          const key = args[0] as string;
          const row = settings.find((s) => s.key === key);
          return row ? { value: row.value } : undefined;
        },
        all() {
          if (sql.includes('FROM weixin_accounts')) return weixin;
          if (sql.includes('FROM automation_crons')) return crons;
          return [];
        },
      };
    },
  };
}

let dir: string;
let cfgPath: string;
let secretsPath: string;

beforeEach(() => {
  dir = tmpDir();
  cfgPath = path.join(dir, 'config.toml');
  secretsPath = path.join(dir, 'secrets.json');
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

function optsFor(extra?: Partial<MigrateOptions>): MigrateOptions {
  const store = new ConfigStore({ configPath: cfgPath, secretsPath });
  return {
    store,
    configPath: cfgPath,
    secretsPath,
    settingsPath: path.join(dir, 'settings.json'),
    mcpTomlPath: path.join(dir, 'mcp.toml'),
    registryPath: path.join(dir, 'registry.json'),
    marketplacesPath: path.join(dir, 'known_marketplaces.json'),
    ...extra,
  };
}

describe('migrateConfig', () => {
  it('skips when config.toml already exists', () => {
    fs.writeFileSync(cfgPath, 'timezone = "UTC"\n');
    const opts = optsFor();
    const res = migrateConfig(fakeDb([]), opts);
    expect(res.skipped).toBe(true);
    expect(res.migrated).toBeUndefined();
  });

  it('is idempotent: second run skips', () => {
    const opts = optsFor();
    const res1 = migrateConfig(fakeDb([]), opts);
    expect(res1).toEqual({ skipped: false, migrated: true });
    const res2 = migrateConfig(fakeDb([]), opts);
    expect(res2.skipped).toBe(true);
  });

  it('migrates settings.json into providers; apiKey goes to secrets, not config.toml', () => {
    fs.writeFileSync(
      path.join(dir, 'settings.json'),
      JSON.stringify({
        apiProviders: {
          anthropic: { id: 'anthropic', name: 'Anthropic', providerType: 'anthropic', baseUrl: 'https://api.anthropic.com', apiKey: 'sk-anthropic-secret' },
        },
        defaultProviderId: 'anthropic',
        memoryProviderId: 'anthropic',
        memoryModelId: 'claude-3-5-sonnet',
        agentSettings: { defaultModel: 'claude-3-5-sonnet', temperature: 0.5, maxTokens: 4096, sandboxEnabled: false, maxConcurrentTools: 2, defaultTimeout: 30000, enableDetailedProgress: true, enableRetry: true },
      }),
    );
    const opts = optsFor();
    const res = migrateConfig(fakeDb([]), opts);
    expect(res.migrated).toBe(true);

    const store = opts.store;
    expect(store.get().providers.anthropic).toMatchObject({ name: 'Anthropic', providerType: 'anthropic', baseUrl: 'https://api.anthropic.com' });
    expect(store.get().model.provider).toBe('anthropic');
    expect(store.get().model.default).toBe('claude-3-5-sonnet');
    expect(store.get().memory.provider).toBe('anthropic');
    expect(store.get().memory.model).toBe('claude-3-5-sonnet');
    expect(store.get().agent.temperature).toBe(0.5);
    expect(store.get().agent.sandbox_enabled).toBe(false);

    const tomlText = fs.readFileSync(cfgPath, 'utf-8');
    expect(tomlText).not.toContain('sk-anthropic-secret');
    const secrets = JSON.parse(fs.readFileSync(secretsPath, 'utf-8') as string);
    expect(secrets['providers.anthropic.apiKey']).toBe('sk-anthropic-secret');
  });

  it('migrates mcp.toml into mcp_servers', () => {
    fs.writeFileSync(
      path.join(dir, 'mcp.toml'),
      '[mcp_servers.my-srv]\ntransport = "stdio"\ncommand = "npx"\nargs = ["-y", "@x/mcp"]\nenabled = true\n',
    );
    const opts = optsFor();
    migrateConfig(fakeDb([]), opts);
    expect(opts.store.get().mcp_servers['my-srv']?.command).toBe('npx');
    expect(opts.store.get().mcp_servers['my-srv']?.enabled).toBe(true);
  });

  it('migrates registry.json into plugins as "<id>@<marketplace>"', () => {
    fs.writeFileSync(
      path.join(dir, 'registry.json'),
      JSON.stringify({ installed: { 'my-plugin': { enabled: true, version: '1.0.0', marketplace: 'official' } } }),
    );
    const opts = optsFor();
    migrateConfig(fakeDb([]), opts);
    const pl = opts.store.get().plugins;
    expect(pl['my-plugin@official']).toEqual({ enabled: true });
  });

  it('deletes successfully-migrated source files', () => {
    fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify({ agentSettings: { defaultModel: 'm' } }));
    fs.writeFileSync(path.join(dir, 'mcp.toml'), '[mcp_servers.x]\nenabled = true\n');
    fs.writeFileSync(path.join(dir, 'registry.json'), JSON.stringify({ installed: {} }));
    fs.writeFileSync(path.join(dir, 'known_marketplaces.json'), JSON.stringify({ official: { url: 'https://x' } }));
    fs.writeFileSync(path.join(dir, 'boot.json'), JSON.stringify({ databasePath: '/tmp/duya.db' }));

    const opts = optsFor();
    migrateConfig(fakeDb([]), opts);
    expect(fs.existsSync(path.join(dir, 'settings.json'))).toBe(false);
    expect(fs.existsSync(path.join(dir, 'mcp.toml'))).toBe(false);
    expect(fs.existsSync(path.join(dir, 'registry.json'))).toBe(false);
    expect(fs.existsSync(path.join(dir, 'known_marketplaces.json'))).toBe(false);
    expect(fs.existsSync(path.join(dir, 'boot.json'))).toBe(false);
  });
});

describe('migrateSqliteRows', () => {
  it('migrates gatewayModel and cron.jobs', () => {
    const settings = [{ key: 'gatewayModel', value: JSON.stringify('gpt-4o') }];
    const crons = [
      {
        id: 'c1', name: 'daily', description: 'daily run', schedule_kind: 'cron', schedule_cron_expr: '0 8 * * *',
        working_directory: '/wd', prompt: 'do it', input_params: '{"a":1}', model: 'gpt-4o', status: 'enabled',
        concurrency_policy: 'skip', max_retries: 3,
      },
    ];
    const db = fakeDb(settings, { crons });
    const store = new ConfigStore({ configPath: cfgPath, secretsPath });
    migrateSqliteRows(store, db);

    expect(store.getByPath('channels.gateway_model')).toBe('gpt-4o');
    expect(store.get().cron.jobs.length).toBe(1);
    const job = store.get().cron.jobs[0];
    expect(job?.id).toBe('c1');
    expect(job?.model).toBe('gpt-4o');
    expect(job?.schedule_cron_expr).toBe('0 8 * * *');
    expect(job?.input_params).toEqual({ a: 1 });
  });
});
