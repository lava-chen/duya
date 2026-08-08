import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { ConfigStore } from '../../../config/store';
import { ConfigStoreReader } from '../provider-store-config';
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