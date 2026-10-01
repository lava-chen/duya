/**
 * compact-config.test.ts — main-side compact (summarization) model config
 * resolution: wake/cron/bot runs must honor the same auxiliary.compact
 * settings the renderer injects into interactive chats (grok dedicated
 * summarization session parity).
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { ConfigStore } from '../../config/store';
import { _setConfigStoreForTest } from '../../config/store-instance';
import { resolveCompactModelConfig } from '../compact-config';

let tmpRoot: string;
let store: ConfigStore;

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'duya-compact-config-'));
  store = new ConfigStore({
    configPath: path.join(tmpRoot, 'config.toml'),
    secretsPath: path.join(tmpRoot, 'secrets.json'),
  });
  _setConfigStoreForTest(store);
});

afterEach(() => {
  _setConfigStoreForTest(undefined);
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

describe('resolveCompactModelConfig', () => {
  it('maps the enabled auxiliary.compact settings to CompactModelConfig', () => {
    store.set('auxiliary.compact', {
      provider: 'openai',
      model: 'gpt-4o-mini',
      baseUrl: 'https://example.invalid/v1',
      apiKey: 'k',
      enabled: true,
    });
    expect(resolveCompactModelConfig()).toEqual({
      provider: 'openai',
      model: 'gpt-4o-mini',
      baseURL: 'https://example.invalid/v1',
      apiKey: 'k',
      enabled: true,
    });
  });

  it('returns undefined when disabled', () => {
    store.set('auxiliary.compact', {
      provider: 'openai',
      model: 'gpt-4o-mini',
      baseUrl: 'https://example.invalid/v1',
      apiKey: 'k',
      enabled: false,
    });
    expect(resolveCompactModelConfig()).toBeUndefined();
  });

  it('returns undefined when the model or provider is missing', () => {
    store.set('auxiliary.compact', { provider: 'openai', enabled: true });
    expect(resolveCompactModelConfig()).toBeUndefined();
    store.set('auxiliary.compact', { model: 'gpt-4o-mini', enabled: true });
    expect(resolveCompactModelConfig()).toBeUndefined();
  });

  it('accepts baseURL spelled either way', () => {
    store.set('auxiliary.compact', {
      provider: 'openai',
      model: 'm',
      baseURL: 'https://b.invalid',
      enabled: true,
    });
    expect(resolveCompactModelConfig()?.baseURL).toBe('https://b.invalid');
  });
});
