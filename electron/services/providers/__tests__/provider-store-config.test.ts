import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { ConfigStore } from '../../../config/store';
import { ConfigStoreReader } from '../provider-store-config';
import { ProviderStore } from '../provider-store';
import type { ApiProvider } from '../../../../src/lib/providers/types';

let dir: string;
let cfgPath: string;
let secretsPath: string;

function makeStore(initial: Record<string, unknown> = {}): ConfigStore {
  const store = new ConfigStore({ configPath: cfgPath, secretsPath });
  for (const [k, v] of Object.entries(initial)) store.set(k, v);
  return store;
}

describe('ConfigStoreReader', () => {
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'duya-reader-'));
    cfgPath = path.join(dir, 'config.toml');
    secretsPath = path.join(dir, 'secrets.json');
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('readAll returns providers from config.providers with apiKey merged', () => {
    const store = makeStore({
      'providers.anthropic.name': 'Anthropic',
      'providers.anthropic.providerType': 'anthropic',
      'providers.anthropic.baseUrl': 'https://api.anthropic.com',
      'providers.anthropic.apiKey': 'sk-merger',
    });
    const reader = new ConfigStoreReader(store);
    const all = reader.readAll();
    expect(all['anthropic']).toBeDefined();
    expect(all['anthropic']?.apiKey).toBe('sk-merger');
  });

  it('readDefault reads model.provider', () => {
    const store = makeStore({
      'model.provider': 'anthropic',
      'providers.anthropic.name': 'Anthropic',
      'providers.anthropic.providerType': 'anthropic',
      'providers.anthropic.baseUrl': 'https://api.anthropic.com',
    });
    const reader = new ConfigStoreReader(store);
    expect(reader.readDefault()?.id).toBe('anthropic');
  });

  it('readMemory / writeMemory read+write memory.provider', () => {
    const store = makeStore({
      'memory.provider': 'ollama',
      'providers.ollama.name': 'Ollama',
      'providers.ollama.providerType': 'ollama',
      'providers.ollama.baseUrl': 'http://localhost:11434',
    });
    const reader = new ConfigStoreReader(store);
    expect(reader.readMemory()?.id).toBe('ollama');
    reader.writeMemory('openai');
    expect(store.getByPath('memory.provider')).toBe('openai');
  });

  it('readMemoryModel / writeMemoryModel read+write memory.model', () => {
    const store = makeStore({ 'memory.model': 'llama3.2' });
    const reader = new ConfigStoreReader(store);
    expect(reader.readMemoryModel()).toBe('llama3.2');
    reader.writeMemoryModel('gpt-4o-mini');
    expect(store.getByPath('memory.model')).toBe('gpt-4o-mini');
  });

  it('writeAll maps ApiProvider map back to config.providers', () => {
    const store = makeStore();
    const reader = new ConfigStoreReader(store);
    reader.writeAll({
      mini: { id: 'mini', name: 'Mini', providerType: 'openai-compatible', baseUrl: 'http://x', apiKey: 'k' } as ApiProvider,
    });
    expect(store.get().providers['mini']).toBeDefined();
  });

  it('onChange delegates to store.subscribe', () => {
    const store = makeStore();
    const reader = new ConfigStoreReader(store);
    let fired = 0;
    const unsub = reader.onChange(() => {
      fired += 1;
    });
    store.set('timezone', 'UTC');
    expect(fired).toBe(1);
    unsub();
  });
});
describe('ProviderStore ↔ config.toml end-to-end (add / edit models / delete / reload)', () => {
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'duya-e2e-'));
    cfgPath = path.join(dir, 'config.toml');
    secretsPath = path.join(dir, 'secrets.json');
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  function makeProviderStore(): ProviderStore {
    const configStore = new ConfigStore({ configPath: cfgPath, secretsPath });
    const reader = new ConfigStoreReader(configStore);
    return new ProviderStore(reader);
  }

  it('add → config.toml → restart reload: full round-trip', () => {
    const store = makeProviderStore();
    const r = store.upsertLlmProvider({
      id: 'minimax-cn',
      name: 'MiniMax CN',
      category: 'official',
      apiFormat: 'anthropic',
      auth: { type: 'api-key', apiKey: 'sk-cp-test' },
      endpoints: { baseUrl: 'https://api.minimaxi.com/anthropic' },
      ui: {},
      meta: { createdAt: 0, updatedAt: 0, sortIndex: 0 },
      options: {
        enabled_models: ['MiniMax-M3', 'MiniMax-M2.7', 'MiniMax-M2.5', 'MiniMax-M2.1', 'MiniMax-M2'],
        defaultModel: 'MiniMax-M3',
      },
    });
    expect(r.ok).toBe(true);

    // config.toml carries the provider + models; the apiKey is split out.
    const toml = fs.readFileSync(cfgPath, 'utf-8');
    expect(toml).toContain('api.minimaxi.com/anthropic');
    expect(toml).toContain('MiniMax-M2.7');
    expect(toml).not.toContain('sk-cp-test');
    const secrets = JSON.parse(fs.readFileSync(secretsPath, 'utf-8'));
    expect(secrets['providers.minimax-cn.apiKey']).toBe('sk-cp-test');

    // Simulate app restart: a brand-new ProviderStore over the same files.
    const store2 = makeProviderStore();
    const p = store2.getLlmProvider('minimax-cn');
    expect(p).toBeTruthy();
    expect(p!.apiFormat).toBe('anthropic');
    expect(p!.endpoints.baseUrl).toBe('https://api.minimaxi.com/anthropic');
    expect((p!.options as Record<string, unknown>).enabled_models).toEqual([
      'MiniMax-M3', 'MiniMax-M2.7', 'MiniMax-M2.5', 'MiniMax-M2.1', 'MiniMax-M2',
    ]);
    expect(p!.auth.apiKey).toBe('sk-cp-test');
  });

  it('editing the model list updates config.toml in place', () => {
    const store = makeProviderStore();
    store.upsertLlmProvider({
      id: 'deepseek',
      name: 'DeepSeek',
      category: 'official',
      apiFormat: 'openai-chat',
      auth: { type: 'api-key', apiKey: 'sk-ds' },
      endpoints: { baseUrl: 'https://api.deepseek.com/v1' },
      ui: {},
      meta: { createdAt: 0, updatedAt: 0, sortIndex: 0 },
      options: { enabled_models: ['deepseek-chat'], defaultModel: 'deepseek-chat' },
    });
    const r2 = store.upsertLlmProvider({
      id: 'deepseek',
      name: 'DeepSeek',
      category: 'official',
      apiFormat: 'openai-chat',
      auth: { type: 'api-key' }, // untouched → key preserved by the store
      endpoints: { baseUrl: 'https://api.deepseek.com/v1' },
      ui: {},
      meta: { createdAt: 0, updatedAt: 0, sortIndex: 0 },
      options: { enabled_models: ['deepseek-chat', 'deepseek-reasoner'], defaultModel: 'deepseek-chat' },
    });
    expect(r2.ok).toBe(true);
    const toml = fs.readFileSync(cfgPath, 'utf-8');
    expect(toml).toContain('deepseek-reasoner');
    expect(toml).not.toContain('deepseek-v4');
    const store2 = makeProviderStore();
    const p = store2.getLlmProvider('deepseek');
    expect((p!.options as Record<string, unknown>).enabled_models).toEqual(['deepseek-chat', 'deepseek-reasoner']);
    expect(p!.auth.apiKey).toBe('sk-ds'); // key survived the edit
  });

  it('deleting a provider removes it from config.toml', () => {
    const store = makeProviderStore();
    store.upsertLlmProvider({
      id: 'temp',
      name: 'Temp',
      category: 'official',
      apiFormat: 'openai-chat',
      auth: { type: 'api-key', apiKey: 'sk-temp' },
      endpoints: { baseUrl: 'https://x.example/v1' },
      ui: {},
      meta: { createdAt: 0, updatedAt: 0, sortIndex: 0 },
      options: { enabled_models: ['m1'], defaultModel: 'm1' },
    });
    expect(fs.readFileSync(cfgPath, 'utf-8')).toContain('temp');
    expect(store.deleteLlmProvider('temp')).toBe(true);
    const toml = fs.readFileSync(cfgPath, 'utf-8');
    expect(toml).not.toContain('x.example');
    expect(toml).not.toContain('providers.temp');
    expect(toml).not.toContain('enabled_models');
    const store2 = makeProviderStore();
    expect(store2.getLlmProvider('temp')).toBeUndefined();
  });
});
