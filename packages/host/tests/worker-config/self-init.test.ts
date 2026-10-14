import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createWorkerSelfInitMessage } from '../../src/worker-config/self-init.js';

const roots: string[] = [];

function createConfigRoot(): string {
  const root = mkdtempSync(path.join(tmpdir(), 'duya-worker-self-init-'));
  roots.push(root);
  writeFileSync(path.join(root, 'config.toml'), `
[model]
provider = "default-provider"
default = "model-from-config"

[providers.default-provider]
providerType = "anthropic"
baseUrl = "https://default.example"

[providers.frozen-provider]
providerType = "openrouter"
baseUrl = "https://frozen.example"
options.defaultModel = "provider-model"
options.enabled_models = ["provider-model", "manifest-model"]
`, 'utf8');
  writeFileSync(path.join(root, 'secrets.json'), JSON.stringify({
    'providers.default-provider.apiKey': 'default-secret',
    'providers.frozen-provider.apiKey': 'frozen-secret',
  }), 'utf8');
  return root;
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('createWorkerSelfInitMessage', () => {
  it('honors the manifest-frozen provider and model inside the worker init command', () => {
    const configRoot = createConfigRoot();
    const result = createWorkerSelfInitMessage({
      sessionId: 'session-1',
      manifest: {
        cwd: 'C:\\workspace\\project',
        agent: { providerId: 'frozen-provider', model: 'manifest-model' },
      },
    }, { configRoot, workingDirectoryFallback: 'fallback-cwd' });

    expect(result).toEqual({
      ok: true,
      message: {
        type: 'init',
        sessionId: 'session-1',
        providerConfig: {
          apiKey: 'frozen-secret',
          baseURL: 'https://frozen.example',
          model: 'manifest-model',
          provider: 'openai',
          authStyle: 'api_key',
        },
        workingDirectory: 'C:\\workspace\\project',
        language: 'zh',
      },
    });
  });

  it('falls back to the configured provider and worker cwd without a manifest', () => {
    const configRoot = createConfigRoot();
    const result = createWorkerSelfInitMessage({ sessionId: 'session-2' }, {
      configRoot,
      workingDirectoryFallback: 'worker-cwd',
    });

    expect(result).toEqual({
      ok: true,
      message: {
        type: 'init',
        sessionId: 'session-2',
        providerConfig: {
          apiKey: 'default-secret',
          baseURL: 'https://default.example',
          model: 'model-from-config',
          provider: 'anthropic',
          authStyle: 'api_key',
        },
        workingDirectory: 'worker-cwd',
        language: 'zh',
      },
    });
  });

  it('returns the specific provider-resolution failure for the worker to report', () => {
    const result = createWorkerSelfInitMessage({ sessionId: 'session-3' }, {
      configRoot: path.join(tmpdir(), 'missing-duya-worker-config'),
      workingDirectoryFallback: 'worker-cwd',
    });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected provider resolution to fail');
    expect(result.message).toContain('worker self-init could not resolve a provider:');
    expect(result.message).toContain('No provider configuration found');
  });
});
