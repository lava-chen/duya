import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { ConfigStore, type ConfigStoreOptions } from '../store';

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
    expect(cfg.agent.max_turns).toBe(90);
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
});