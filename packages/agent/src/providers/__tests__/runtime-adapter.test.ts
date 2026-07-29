/**
 * packages/agent/src/providers/__tests__/runtime-adapter.test.ts
 *
 * Mirror of the renderer-side runtime adapter test, but for the agent
 * package. Verifies that:
 *  - legacy ApiProvider -> ProviderRuntimeConfig works
 *  - LlmProvider-domain -> ProviderRuntimeConfig works
 *  - OpenAI / Anthropic / Ollama each get the right headers
 *  - secrets never appear in error messages
 */

import { describe, it, expect } from 'vitest';
import {
  buildHeaders,
  inferApiFormatFromLegacyProviderType,
  inferAuthStyle,
  normalizeBaseUrl,
  redactSecrets,
  resolveLlmClientDiscriminator,
  toRuntimeConfig,
  toRuntimeConfigFromDomain,
  toLegacyLlmProviderDiscriminator,
} from '../ProviderRuntimeAdapter.js';
import type { LegacyApiProvider, LlmProviderDomain } from '../ProviderRuntimeAdapter.js';
import type {
  ProviderRuntimeConfig,
  RuntimeAuthStyle,
} from '../runtime-types.js';

function legacy(overrides: Partial<LegacyApiProvider> = {}): LegacyApiProvider {
  return {
    id: 'p1',
    name: 'p1',
    providerType: 'openai-compatible',
    baseUrl: 'https://example.com/v1/',
    apiKey: 'sk-1234567890',
    isActive: false,
    ...overrides,
  };
}

function domainAnthropic(): LlmProviderDomain {
  return {
    id: 'p1',
    name: 'p1',
    apiFormat: 'anthropic',
    auth: { type: 'api-key', apiKey: 'sk-ant-1234567890' },
    endpoints: { baseUrl: 'https://api.anthropic.com/' },
  };
}

function domainOpenAI(): LlmProviderDomain {
  return {
    id: 'p1',
    name: 'p1',
    apiFormat: 'openai-chat',
    auth: { type: 'api-key', apiKey: 'sk-oai-1234567890' },
    endpoints: { baseUrl: 'https://api.openai.com/v1/' },
  };
}

function domainOllama(): LlmProviderDomain {
  return {
    id: 'p1',
    name: 'p1',
    apiFormat: 'ollama',
    auth: { type: 'none' },
    endpoints: { baseUrl: 'http://localhost:11434/' },
  };
}

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

describe('inferAuthStyle', () => {
  it('returns none for ollama', () => {
    expect(inferAuthStyle('ollama', 'ollama', undefined)).toBe<RuntimeAuthStyle>('none');
  });
  it('returns bearer for openrouter', () => {
    expect(inferAuthStyle('openai-chat', 'openrouter', undefined)).toBe<RuntimeAuthStyle>('bearer');
  });
  it('returns auth_token for anthropic with ANTHROPIC_AUTH_TOKEN', () => {
    expect(inferAuthStyle('anthropic', 'anthropic', 'ANTHROPIC_AUTH_TOKEN')).toBe<RuntimeAuthStyle>('auth_token');
  });
  it('returns api_key for anthropic without AUTH_TOKEN field', () => {
    expect(inferAuthStyle('anthropic', 'anthropic', undefined)).toBe<RuntimeAuthStyle>('api_key');
  });
  it('returns bearer for openai-chat', () => {
    expect(inferAuthStyle('openai-chat', 'openai', undefined)).toBe<RuntimeAuthStyle>('bearer');
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
    const h = buildHeaders('anthropic', 'sk-ant-1234567890', undefined, 'api_key');
    expect(h['x-api-key']).toBe('sk-ant-1234567890');
    expect(h['anthropic-version']).toBe('2023-06-01');
    expect(h['Authorization']).toBeUndefined();
  });
  it('Anthropic auth_token style uses Bearer', () => {
    const h = buildHeaders('anthropic', 'sk-ant-xxx', undefined, 'auth_token');
    expect(h['Authorization']).toBe('Bearer sk-ant-xxx');
    expect(h['x-api-key']).toBeUndefined();
  });
  it('OpenAI uses Bearer', () => {
    const h = buildHeaders('openai-chat', 'sk-oai-1234567890', undefined, 'bearer');
    expect(h['Authorization']).toBe('Bearer sk-oai-1234567890');
  });
  it('Ollama emits no auth', () => {
    const h = buildHeaders('ollama', '', undefined, 'none');
    expect(h['Authorization']).toBeUndefined();
  });
  it('Gemini emits x-goog-api-key', () => {
    const h = buildHeaders('gemini', 'g-1234567890', undefined, 'api_key');
    expect(h['x-goog-api-key']).toBe('g-1234567890');
    expect(h['Authorization']).toBeUndefined();
  });
});

describe('toRuntimeConfig (legacy bridge)', () => {
  it('produces an OpenAI-compatible config', () => {
    const cfg: ProviderRuntimeConfig = toRuntimeConfig(
      legacy({ providerType: 'openai-compatible', baseUrl: 'https://example.com/v1/' }),
      { modelId: 'gpt-4o' },
    );
    expect(cfg.apiFormat).toBe('openai-chat');
    expect(cfg.baseUrl).toBe('https://example.com/v1');
    expect(cfg.headers['Authorization']).toBe('Bearer sk-1234567890');
    expect(cfg.model).toBe('gpt-4o');
    expect(cfg.authStyle).toBe('bearer');
  });
  it('produces an Anthropic config with api_key style', () => {
    const cfg = toRuntimeConfig(
      legacy({ providerType: 'anthropic' }),
      { modelId: 'claude-sonnet-4-5' },
    );
    expect(cfg.apiFormat).toBe('anthropic');
    expect(cfg.headers['x-api-key']).toBe('sk-1234567890');
    expect(cfg.authStyle).toBe('api_key');
  });
  it('produces an Ollama config with no auth', () => {
    const cfg = toRuntimeConfig(
      legacy({ providerType: 'ollama', baseUrl: 'http://localhost:11434', apiKey: '' }),
      { modelId: 'llama3.2' },
    );
    expect(cfg.apiFormat).toBe('ollama');
    expect(cfg.authStyle).toBe('none');
    expect(cfg.headers['Authorization']).toBeUndefined();
  });
});

describe('toRuntimeConfigFromDomain (Anthropic)', () => {
  it('builds a config with x-api-key', () => {
    const cfg = toRuntimeConfigFromDomain(domainAnthropic(), { modelId: 'claude-sonnet-4-5' });
    expect(cfg.apiFormat).toBe('anthropic');
    expect(cfg.headers['x-api-key']).toBe('sk-ant-1234567890');
    expect(cfg.model).toBe('claude-sonnet-4-5');
  });
});

describe('toRuntimeConfigFromDomain (OpenAI-compatible)', () => {
  it('builds a config with Bearer', () => {
    const cfg = toRuntimeConfigFromDomain(domainOpenAI(), { modelId: 'gpt-4o' });
    expect(cfg.apiFormat).toBe('openai-chat');
    expect(cfg.headers['Authorization']).toBe('Bearer sk-oai-1234567890');
  });
});

describe('toRuntimeConfigFromDomain (Ollama)', () => {
  it('builds a config with no auth', () => {
    const cfg = toRuntimeConfigFromDomain(domainOllama(), { modelId: 'llama3.2' });
    expect(cfg.apiFormat).toBe('ollama');
    expect(cfg.apiKey).toBeUndefined();
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

describe('Phase 3: resolveLlmClientDiscriminator', () => {
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
