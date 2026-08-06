/**
 * packages/ai/test/runtime-adapter.test.ts
 *
 * Canonical provider -> runtime config adapter tests. Verifies:
 *  - legacy ApiProvider -> ProviderRuntimeConfig works
 *  - LlmProvider-shaped source -> ProviderRuntimeConfig works
 *  - OpenAI / Anthropic / Ollama each get the right headers
 *  - secrets never appear in error messages
 */

import { describe, it, expect } from 'vitest';
import {
  buildHeaders,
  inferApiFormatFromLegacyProviderType,
  normalizeBaseUrl,
  redactSecrets,
  resolveLlmClientDiscriminator,
  toRuntimeConfig,
  toRuntimeConfigFromLegacy,
  toLegacyLlmProviderDiscriminator,
} from '../src/runtime-adapter.js';
import type {
  ProviderRuntimeConfig,
  RuntimeAuthSource,
  RuntimeLegacyProviderSource,
  RuntimeProviderSource,
} from '../src/runtime-adapter.js';

function legacy(overrides: Partial<RuntimeLegacyProviderSource> = {}): RuntimeLegacyProviderSource {
  return {
    id: 'p1',
    name: 'p1',
    providerType: 'openai-compatible',
    baseUrl: 'https://example.com/v1/',
    apiKey: 'sk-1234567890',
    ...overrides,
  };
}

function provider(overrides: Partial<RuntimeProviderSource> = {}): RuntimeProviderSource {
  return {
    id: 'p1',
    name: 'p1',
    apiFormat: 'anthropic',
    auth: { type: 'api-key', apiKey: 'sk-ant-1234567890' },
    endpoints: { baseUrl: 'https://api.anthropic.com/' },
    ...overrides,
  };
}

const auth = (a: RuntimeAuthSource): RuntimeAuthSource => a;

describe('inferApiFormatFromLegacyProviderType', () => {
  it('maps every legacy type to a runtime apiFormat', () => {
    expect(inferApiFormatFromLegacyProviderType('anthropic')).toBe('anthropic');
    expect(inferApiFormatFromLegacyProviderType('bedrock')).toBe('anthropic');
    expect(inferApiFormatFromLegacyProviderType('vertex')).toBe('anthropic');
    expect(inferApiFormatFromLegacyProviderType('openai')).toBe('openai-chat');
    expect(inferApiFormatFromLegacyProviderType('openai-compatible')).toBe('openai-chat');
    expect(inferApiFormatFromLegacyProviderType('openrouter')).toBe('openai-chat');
    expect(inferApiFormatFromLegacyProviderType('google')).toBe('openai-chat');
    expect(inferApiFormatFromLegacyProviderType('gemini-image')).toBe('openai-chat');
    expect(inferApiFormatFromLegacyProviderType('ollama')).toBe('ollama');
  });
});

describe('normalizeBaseUrl', () => {
  it('strips trailing slashes', () => {
    expect(normalizeBaseUrl('https://x.com/')).toBe('https://x.com');
    expect(normalizeBaseUrl('https://x.com///')).toBe('https://x.com');
  });
  it('handles empty', () => {
    expect(normalizeBaseUrl('')).toBe('');
    expect(normalizeBaseUrl(undefined)).toBe('');
  });
});

describe('buildHeaders', () => {
  it('Anthropic api_key style uses x-api-key', () => {
    const h = buildHeaders('anthropic', auth({ type: 'api-key', apiKey: 'sk-ant-1234567890' }), undefined);
    expect(h['x-api-key']).toBe('sk-ant-1234567890');
    expect(h['anthropic-version']).toBe('2023-06-01');
    expect(h['Authorization']).toBeUndefined();
  });
  it('Anthropic auth_token style uses Bearer', () => {
    const h = buildHeaders(
      'anthropic',
      auth({ type: 'api-key', apiKey: 'sk-ant-xxx', apiKeyField: 'ANTHROPIC_AUTH_TOKEN' }),
      undefined,
    );
    expect(h['Authorization']).toBe('Bearer sk-ant-xxx');
    expect(h['x-api-key']).toBeUndefined();
  });
  it('OpenAI uses Bearer', () => {
    const h = buildHeaders('openai-chat', auth({ type: 'api-key', apiKey: 'sk-oai-1234567890' }), undefined);
    expect(h['Authorization']).toBe('Bearer sk-oai-1234567890');
  });
  it('Ollama emits no auth', () => {
    const h = buildHeaders('ollama', auth({ type: 'none' }), undefined);
    expect(h['Authorization']).toBeUndefined();
  });
  it('Gemini emits x-goog-api-key', () => {
    const h = buildHeaders('gemini', auth({ type: 'api-key', apiKey: 'g-1234567890' }), undefined);
    expect(h['x-goog-api-key']).toBe('g-1234567890');
    expect(h['Authorization']).toBeUndefined();
  });
});

describe('toRuntimeConfig (LlmProvider-shaped source)', () => {
  it('produces an Anthropic config with x-api-key', () => {
    const cfg: ProviderRuntimeConfig = toRuntimeConfig(provider(), { modelId: 'claude-sonnet-4-5' });
    expect(cfg.apiFormat).toBe('anthropic');
    expect(cfg.baseUrl).toBe('https://api.anthropic.com');
    expect(cfg.headers['x-api-key']).toBe('sk-ant-1234567890');
    expect(cfg.model).toBe('claude-sonnet-4-5');
  });
  it('produces an OpenAI config with Bearer', () => {
    const cfg = toRuntimeConfig(
      provider({
        apiFormat: 'openai-chat',
        auth: { type: 'api-key', apiKey: 'sk-oai-1234567890' },
        endpoints: { baseUrl: 'https://api.openai.com/v1/' },
      }),
      { modelId: 'gpt-4o' },
    );
    expect(cfg.apiFormat).toBe('openai-chat');
    expect(cfg.headers['Authorization']).toBe('Bearer sk-oai-1234567890');
  });
  it('produces an Ollama config with no auth', () => {
    const cfg = toRuntimeConfig(
      provider({
        apiFormat: 'ollama',
        auth: { type: 'none' },
        endpoints: { baseUrl: 'http://localhost:11434/' },
      }),
      { modelId: 'llama3.2' },
    );
    expect(cfg.apiFormat).toBe('ollama');
    expect(cfg.apiKey).toBeUndefined();
    expect(cfg.headers['Authorization']).toBeUndefined();
  });
});

describe('toRuntimeConfigFromLegacy', () => {
  it('produces an OpenAI-compatible config', () => {
    const cfg = toRuntimeConfigFromLegacy(
      legacy({ providerType: 'openai-compatible', baseUrl: 'https://example.com/v1/' }),
      'gpt-4o',
    );
    expect(cfg.apiFormat).toBe('openai-chat');
    expect(cfg.baseUrl).toBe('https://example.com/v1');
    expect(cfg.headers['Authorization']).toBe('Bearer sk-1234567890');
    expect(cfg.model).toBe('gpt-4o');
  });
  it('produces an Anthropic config with api_key style', () => {
    const cfg = toRuntimeConfigFromLegacy(legacy({ providerType: 'anthropic' }), 'claude-sonnet-4-5');
    expect(cfg.apiFormat).toBe('anthropic');
    expect(cfg.headers['x-api-key']).toBe('sk-1234567890');
  });
  it('produces an Ollama config with no auth', () => {
    const cfg = toRuntimeConfigFromLegacy(
      legacy({ providerType: 'ollama', baseUrl: 'http://localhost:11434', apiKey: '' }),
      'llama3.2',
    );
    expect(cfg.apiFormat).toBe('ollama');
    expect(cfg.headers['Authorization']).toBeUndefined();
  });
});

describe('toLegacyLlmProviderDiscriminator', () => {
  it('maps to anthropic / openai / ollama correctly', () => {
    expect(toLegacyLlmProviderDiscriminator('anthropic')).toBe('anthropic');
    expect(toLegacyLlmProviderDiscriminator('openai-chat')).toBe('openai');
    expect(toLegacyLlmProviderDiscriminator('ollama')).toBe('ollama');
    expect(toLegacyLlmProviderDiscriminator('bedrock')).toBe('anthropic');
    expect(toLegacyLlmProviderDiscriminator('vertex')).toBe('anthropic');
    expect(toLegacyLlmProviderDiscriminator('gemini')).toBe('openai');
  });
});

describe('redactSecrets', () => {
  it('redacts Bearer tokens', () => {
    expect(redactSecrets('Bearer sk-1234567890abcdef')).toContain('[REDACTED]');
    expect(redactSecrets('Bearer sk-1234567890abcdef')).not.toContain('sk-1234567890abcdef');
  });
  it('redacts x-api-key', () => {
    expect(redactSecrets('x-api-key: sk-ant-1234567890')).toContain('[REDACTED]');
  });
  it('redacts api_key=', () => {
    expect(redactSecrets('api_key=sk-1234567890xyz')).toContain('[REDACTED]');
  });
  it('handles empty / null', () => {
    expect(redactSecrets('')).toBe('');
    expect(redactSecrets(null)).toBe('');
  });
  it('leaves short strings alone', () => {
    expect(redactSecrets('foo bar')).toBe('foo bar');
  });
});

describe('resolveLlmClientDiscriminator', () => {
  it('maps every runtime apiFormat to a valid LLMClient discriminator', () => {
    expect(resolveLlmClientDiscriminator('openai-chat')).toBe('openai');
    expect(resolveLlmClientDiscriminator('openai-responses')).toBe('openai');
    expect(resolveLlmClientDiscriminator('gemini')).toBe('openai');
    expect(resolveLlmClientDiscriminator('anthropic')).toBe('anthropic');
    expect(resolveLlmClientDiscriminator('bedrock')).toBe('anthropic');
    expect(resolveLlmClientDiscriminator('vertex')).toBe('anthropic');
    expect(resolveLlmClientDiscriminator('ollama')).toBe('ollama');
  });

  it('does not throw on any documented apiFormat', () => {
    const allFormats: Array<Parameters<typeof resolveLlmClientDiscriminator>[0]> = [
      'openai-chat',
      'openai-responses',
      'anthropic',
      'gemini',
      'ollama',
      'bedrock',
      'vertex',
    ];
    for (const f of allFormats) {
      expect(() => resolveLlmClientDiscriminator(f)).not.toThrow();
    }
  });
});