import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { ConfigStore, diffConfigPaths, type ConfigStoreOptions } from '../store';

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'duya-config-store-'));
}

let dir: string;
let opts: ConfigStoreOptions;

beforeEach(() => {
  dir = tmpDir();
  opts = {
    configPath: path.join(dir, 'config.toml'),
    secretsPath: path.join(dir, 'secrets.json'),
  };
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('ConfigStore', () => {
  it('load() returns defaults when config.toml does not exist', () => {
    const store = new ConfigStore(opts);
    const cfg = store.get();
    expect(cfg._config_version).toBe(1);
    // No implicit `agent.max_turns` — agent is uncapped by default
    // (pi-aligned). Users can opt-in via `agent.max_turns` in config.toml.
    expect(cfg.agent.max_turns).toBeUndefined();
  });

  it('set() updates snapshot by dotted path and persists TOML', () => {
    const store = new ConfigStore(opts);
    store.set('providers.minimax.baseUrl', 'https://api.minimax.chat');
    const onDisk = fs.readFileSync(opts.configPath, 'utf-8');
    expect(onDisk).toContain('baseUrl');
    expect(store.get().providers.minimax.baseUrl).toBe('https://api.minimax.chat');
  });

  it('secrets are split: apiKey goes to secrets.json, not config.toml', () => {
    const store = new ConfigStore(opts);
    store.set('providers.anthropic.apiKey', 'sk-secret');
    const tomlText = fs.readFileSync(opts.configPath, 'utf-8');
    expect(tomlText).not.toContain('sk-secret');
    const secrets = JSON.parse(fs.readFileSync(opts.secretsPath, 'utf-8') as string);
    expect(secrets['providers.anthropic.apiKey']).toBe('sk-secret');
    // ProviderEntry intentionally omits apiKey (split to secrets.json), so the
    // in-memory snapshot keeps it behind a cast.
    expect((store.get().providers.anthropic as unknown as Record<string, unknown>).apiKey).toBe('sk-secret');
  });

  it('write is atomic and mode 0o600', () => {
    const store = new ConfigStore(opts);
    store.set('timezone', 'Asia/Shanghai');
    // POSIX permission bits are meaningless on Windows (write-file-atomic
    // cannot apply them there), so only assert the mode on Unix-like hosts.
    if (process.platform !== 'win32') {
      const mode = fs.statSync(opts.configPath).mode & 0o777;
      expect(mode).toBe(0o600);
    }
  });

  it('subscribe() fires callback on set()', () => {
    const store = new ConfigStore(opts);
    const cb = vi.fn();
    store.subscribe(cb);
    store.set('timezone', 'UTC');
    expect(cb).toHaveBeenCalledTimes(1);
  });

  it('external edit to config.toml is hot-reloaded and reported to the external handler', async () => {
    const store = new ConfigStore(opts);
    store.set('mcp_servers', {
      foo: { name: 'foo', command: 'npx', args: ['-y', '@foo/mcp'], enabled: true },
    });
    const handler = vi.fn();
    const broadcast = vi.fn();
    store.setExternalChangeHandler(handler);
    store.subscribe(broadcast);

    // Simulate a user manually editing config.toml while DUYA is running.
    fs.writeFileSync(
      opts.configPath,
      '[mcp_servers.foo]\nname = "foo"\ncommand = "node"\nargs = ["-y", "@foo/mcp"]\nenabled = true\n',
      'utf-8',
    );

    await vi.waitFor(() => expect(handler).toHaveBeenCalled(), { timeout: 3000 });
    const cfg = store.get();
    expect(cfg.mcp_servers?.foo?.command).toBe('node');
    expect(
      handler.mock.calls.flat(Infinity).some((p) => p === 'mcp_servers.foo.command' || p === 'mcp_servers.foo'),
    ).toBe(true);
    // The external change also broadcasts so the renderer sees the new value.
    expect(broadcast).toHaveBeenCalled();
    store.close();
  });

  it('self-write via set() does not re-fire the external change handler (no reload loop)', async () => {
    const store = new ConfigStore(opts);
    const handler = vi.fn();
    store.setExternalChangeHandler(handler);
    // set() persists to disk; the watcher fires but the reload sees identical
    // content and must NOT report an external change (avoids a reload loop).
    store.set('timezone', 'UTC');
    await new Promise((r) => setTimeout(r, 700));
    expect(handler).not.toHaveBeenCalled();
    store.close();
  });

  it('unparseable config.toml is backed up before set() can overwrite it', () => {
    // Regression: a TOML parse failure (e.g. duplicate [hooks] table) used to
    // silently reset the in-memory snapshot to defaults, so the next set()
    // persisted the defaults over the user's real configuration (providers,
    // model, mcp_servers) with no way to recover it.
    const original = '[model]\ndefault = "deepseek-v4-flash"\nprovider = "deepseek"\n';
    fs.writeFileSync(opts.configPath, original + '\n[hooks]\nfiles = []\n[hooks]\nfiles = []\n', 'utf-8');
    const store = new ConfigStore(opts);
    // Parse failed -> snapshot is defaults, but the corrupt file was preserved.
    expect(store.get().model.default).toBe('');
    const backups = fs.readdirSync(dir).filter((f) => f.startsWith('config.toml.corrupt-'));
    expect(backups.length).toBe(1);
    expect(fs.readFileSync(path.join(dir, backups[0]!), 'utf-8')).toContain('deepseek-v4-flash');
    // A later set() must NOT destroy the only copy of the original bytes.
    store.set('timezone', 'UTC');
    expect(fs.readFileSync(path.join(dir, backups[0]!), 'utf-8')).toContain('deepseek-v4-flash');
    store.close();
  });
});

describe('diffConfigPaths', () => {
  it('returns changed leaf dotted paths', () => {
    const prev = { mcp_servers: { foo: { command: 'npx' }, bar: { command: 'x' } } };
    const next = { mcp_servers: { foo: { command: 'node' }, bar: { command: 'x' } } };
    expect(diffConfigPaths(prev, next)).toEqual(['mcp_servers.foo.command']);
  });

  it('returns the parent key when an entire nested object is added', () => {
    expect(diffConfigPaths({}, { mcp_servers: { foo: { command: 'npx' } } })).toEqual([
      'mcp_servers',
    ]);
  });

  it('is order-insensitive (structural equality)', () => {
    expect(diffConfigPaths({ a: 1, b: 2 }, { b: 2, a: 1 })).toEqual([]);
  });

  it('isEmpty when snapshots are equal', () => {
    expect(diffConfigPaths({ a: 1, b: [1, 2, 3] }, { a: 1, b: [1, 2, 3] })).toEqual([]);
  });
});