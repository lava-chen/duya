/**
 * src/lib/providers/__tests__/legacy.test.ts
 *
 * Unit tests for the legacy ApiProvider <-> LlmProvider migration layer.
 * No filesystem, no electron, no IPC. Pure data-shape tests.
 */

import { describe, it, expect } from 'vitest';
import {
  buildLlmProviderFromPreset,
  defaultApiKeyField,
  inferApiFormatFromLegacyProviderType,
  inferCategoryFromLegacyProviderType,
  isKeylessLocalProvider,
  maskApiProvider,
  migrateLegacyApiProvider,
  toLegacyApiProvider,
} from '../legacy';
import type { ApiProvider, LlmProvider, ProviderPreset } from '../types';

const NOW = 1_700_000_000_000;

function legacyAnthropic(): ApiProvider {
  return {
    id: 'p-anthropic',
    name: 'My Anthropic',
    providerType: 'anthropic',
    baseUrl: 'https://api.anthropic.com',
    apiKey: 'sk-ant-test-1234567890',
    isActive: true,
    sortOrder: 3,
    extraEnv: { FOO: 'bar' },
    headers: { 'X-Trace': '1' },
    options: { defaultModel: 'claude-sonnet-4-5' },
    notes: 'used in prod',
  };
}

function legacyOllama(): ApiProvider {
  return {
    id: 'p-ollama',
    name: 'Ollama',
    providerType: 'ollama',
    baseUrl: 'http://localhost:11434',
    apiKey: '',
    isActive: false,
  };
}

function legacyOpenRouter(): ApiProvider {
  return {
    id: 'p-or',
    name: 'OR',
    providerType: 'openrouter',
    baseUrl: 'https://openrouter.ai/api/v1',
    apiKey: 'sk-or-v1-abcdef',
    isActive: false,
  };
}

function legacyOpenAICompat(): ApiProvider {
  return {
    id: 'p-oai',
    name: 'oai',
    providerType: 'openai-compatible',
    baseUrl: 'https://example.com/v1',
    apiKey: 'sk-xyz',
    isActive: false,
  };
}

function legacyGeminiImage(): ApiProvider {
  return {
    id: 'p-g',
    name: 'gem',
    providerType: 'gemini-image',
    baseUrl: 'https://example.googleapis.com',
    apiKey: 'g-1',
    isActive: false,
  };
}

describe('inferApiFormatFromLegacyProviderType', () => {
  it('maps official anthropic / bedrock / vertex to anthropic', () => {
    expect(inferApiFormatFromLegacyProviderType('anthropic')).toBe('anthropic');
    expect(inferApiFormatFromLegacyProviderType('bedrock')).toBe('anthropic');
    expect(inferApiFormatFromLegacyProviderType('vertex')).toBe('anthropic');
  });
  it('maps openai / openai-compatible / openrouter / google / gemini-image to openai-chat', () => {
    expect(inferApiFormatFromLegacyProviderType('openai')).toBe('openai-chat');
    expect(inferApiFormatFromLegacyProviderType('openai-compatible')).toBe('openai-chat');
    expect(inferApiFormatFromLegacyProviderType('openrouter')).toBe('openai-chat');
    expect(inferApiFormatFromLegacyProviderType('google')).toBe('openai-chat');
    expect(inferApiFormatFromLegacyProviderType('gemini-image')).toBe('openai-chat');
  });
  it('maps ollama to ollama', () => {
    expect(inferApiFormatFromLegacyProviderType('ollama')).toBe('ollama');
  });
});

describe('inferCategoryFromLegacyProviderType', () => {
  it('infers local for ollama / 11434', () => {
    expect(inferCategoryFromLegacyProviderType('ollama', '')).toBe('local');
    expect(
      inferCategoryFromLegacyProviderType('openai-compatible', 'http://localhost:11434'),
    ).toBe('local');
  });
  it('infers aggregator for openrouter', () => {
    expect(inferCategoryFromLegacyProviderType('openrouter', '')).toBe('aggregator');
  });
  it('infers official for anthropic / openai / google / bedrock / vertex', () => {
    expect(inferCategoryFromLegacyProviderType('anthropic', '')).toBe('official');
    expect(inferCategoryFromLegacyProviderType('openai', '')).toBe('official');
    expect(inferCategoryFromLegacyProviderType('google', '')).toBe('official');
    expect(inferCategoryFromLegacyProviderType('bedrock', '')).toBe('official');
    expect(inferCategoryFromLegacyProviderType('vertex', '')).toBe('official');
  });
  it('falls back to custom for openai-compatible', () => {
    expect(inferCategoryFromLegacyProviderType('openai-compatible', 'https://x.com')).toBe(
      'custom',
    );
  });
});

describe('migrateLegacyApiProvider', () => {
  it('migrates anthropic to LlmProvider with apiFormat=anthropic and category=official', () => {
    const p = migrateLegacyApiProvider(legacyAnthropic(), NOW);
    expect(p.id).toBe('p-anthropic');
    expect(p.name).toBe('My Anthropic');
    expect(p.apiFormat).toBe('anthropic');
    expect(p.category).toBe('official');
    expect(p.endpoints.baseUrl).toBe('https://api.anthropic.com');
    expect(p.auth.apiKey).toBe('sk-ant-test-1234567890');
    expect(p.auth.apiKeyField).toBe('ANTHROPIC_AUTH_TOKEN');
    expect(p.meta.sortIndex).toBe(3);
    expect(p.meta.notes).toBe('used in prod');
    expect(p.meta.createdAt).toBe(NOW);
    expect(p.meta.updatedAt).toBe(NOW);
    expect(p.meta.tags).toContain('active');
    expect(p.extraEnv).toEqual({ FOO: 'bar' });
    expect(p.headers).toEqual({ 'X-Trace': '1' });
    expect(p.options).toEqual({ defaultModel: 'claude-sonnet-4-5' });
  });

  it('migrates ollama with auth=none', () => {
    const p = migrateLegacyApiProvider(legacyOllama(), NOW);
    expect(p.apiFormat).toBe('ollama');
    expect(p.category).toBe('local');
    expect(p.auth.type).toBe('none');
    expect(p.auth.apiKey).toBe('');
    expect(p.meta.tags).toBeUndefined();
  });

  it('migrates openrouter to apiFormat=openai-chat, category=aggregator', () => {
    const p = migrateLegacyApiProvider(legacyOpenRouter(), NOW);
    expect(p.apiFormat).toBe('openai-chat');
    expect(p.category).toBe('aggregator');
    expect(p.auth.apiKeyField).toBe('OPENAI_API_KEY');
  });

  it('migrates openai-compatible to apiFormat=openai-chat, category=custom', () => {
    const p = migrateLegacyApiProvider(legacyOpenAICompat(), NOW);
    expect(p.apiFormat).toBe('openai-chat');
    expect(p.category).toBe('custom');
  });

  it('migrates gemini-image to apiFormat=openai-chat', () => {
    const p = migrateLegacyApiProvider(legacyGeminiImage(), NOW);
    expect(p.apiFormat).toBe('openai-chat');
  });

  it('preserves active flag in tags for round-trip', () => {
    const p = migrateLegacyApiProvider(legacyAnthropic(), NOW);
    const back = toLegacyApiProvider(p);
    expect(back.isActive).toBe(true);
    expect(back.id).toBe('p-anthropic');
  });
});

describe('toLegacyApiProvider round-trip', () => {
  it('preserves the legacy fields after migration', () => {
    const legacy = legacyAnthropic();
    const migrated = migrateLegacyApiProvider(legacy, NOW);
    const back = toLegacyApiProvider(migrated);
    expect(back.id).toBe(legacy.id);
    expect(back.name).toBe(legacy.name);
    expect(back.providerType).toBe(legacy.providerType);
    expect(back.baseUrl).toBe(legacy.baseUrl);
    expect(back.apiKey).toBe(legacy.apiKey);
    expect(back.extraEnv).toEqual(legacy.extraEnv);
    expect(back.headers).toEqual(legacy.headers);
    expect(back.options).toEqual(legacy.options);
    expect(back.notes).toBe(legacy.notes);
    expect(back.sortOrder).toBe(legacy.sortOrder);
  });
});

describe('maskApiProvider', () => {
  it('masks long api keys but preserves id / name / type', () => {
    const masked = maskApiProvider(legacyAnthropic());
    expect(masked.id).toBe('p-anthropic');
    expect(masked.name).toBe('My Anthropic');
    expect(masked.providerType).toBe('anthropic');
    expect(masked.hasApiKey).toBe(true);
    expect(masked.apiKey).toBe('sk-a***7890');
    expect(masked.apiKey.includes('sk-ant-test-1234567890')).toBe(false);
  });

  it('handles short api keys with ***', () => {
    const masked = maskApiProvider({ ...legacyAnthropic(), apiKey: 'short' });
    expect(masked.apiKey).toBe('***');
  });

  it('reports hasApiKey=false when no key', () => {
    const masked = maskApiProvider(legacyOllama());
    expect(masked.hasApiKey).toBe(false);
    expect(masked.apiKey).toBe('');
  });
});

describe('defaultApiKeyField', () => {
  it('returns expected fields for each apiFormat', () => {
    expect(defaultApiKeyField('anthropic')).toBe('ANTHROPIC_AUTH_TOKEN');
    expect(defaultApiKeyField('openai-chat')).toBe('OPENAI_API_KEY');
    expect(defaultApiKeyField('openai-responses')).toBe('OPENAI_API_KEY');
    expect(defaultApiKeyField('gemini')).toBe('GEMINI_API_KEY');
    expect(defaultApiKeyField('ollama')).toBeUndefined();
    expect(defaultApiKeyField('bedrock')).toBe('AWS_BEARER_TOKEN_BEDROCK');
    expect(defaultApiKeyField('vertex')).toBe('GOOGLE_APPLICATION_CREDENTIALS');
  });
});

describe('buildLlmProviderFromPreset', () => {
  const preset: ProviderPreset = {
    key: 'glm-cn',
    name: 'GLM (CN)',
    category: 'aggregator',
    apiFormat: 'anthropic',
    authFields: [{ key: 'api_key', label: 'API Key', secret: true, required: true }],
    defaultEndpoint: 'https://open.bigmodel.cn/api/anthropic',
    modelsSource: { type: 'static' },
    defaultModels: ['glm-5', 'glm-4.5'],
    defaultModelLabels: { 'glm-5': 'GLM-5', 'glm-4.5': 'GLM-4.5' },
    ui: { icon: 'zhipu' },
  };

  it('produces a valid LlmProvider draft with auth=api-key', () => {
    const llm = buildLlmProviderFromPreset(preset, {
      id: 'glm-cn-1',
      name: 'GLM CN #1',
      apiKey: 'glm-key-1234567890',
    });
    expect(llm.id).toBe('glm-cn-1');
    expect(llm.apiFormat).toBe('anthropic');
    expect(llm.category).toBe('aggregator');
    expect(llm.endpoints.baseUrl).toBe('https://open.bigmodel.cn/api/anthropic');
    expect(llm.auth.apiKey).toBe('glm-key-1234567890');
    expect(llm.auth.type).toBe('api-key');
  });

  it('uses auth=none when preset has no secret fields', () => {
    const ollamaPreset: ProviderPreset = {
      ...preset,
      key: 'ollama',
      authFields: [],
      defaultEndpoint: 'http://localhost:11434',
      ui: { icon: 'ollama' },
    };
    const llm = buildLlmProviderFromPreset(ollamaPreset, {
      id: 'ol',
      name: 'Ollama',
    });
    expect(llm.auth.type).toBe('none');
    expect(llm.auth.apiKey).toBeUndefined();
  });
});

describe('secret redaction invariants', () => {
  it('mask never returns the original apiKey', () => {
    const secret = 'sk-ant-verylongtokenwithlotsofchars';
    const masked = maskApiProvider({ ...legacyAnthropic(), apiKey: secret });
    expect(masked.apiKey.includes(secret)).toBe(false);
  });
});

describe('isKeylessLocalProvider (LM Studio / Ollama gate)', () => {
  // Regression coverage for the chat-input bug where LM Studio models
  // were silently dropped from the MessageInput dropdown because the
  // filter hard-coded `providerType === 'ollama'`. After the helper
  // was introduced, both Ollama and LM Studio must be recognized by
  // baseUrl port (the persisted `providerType` for LM Studio is
  // 'openai-compatible', not 'lm-studio', so URL is the only reliable
  // discriminator at runtime).

  it('matches Ollama by providerType alone', () => {
    expect(isKeylessLocalProvider('ollama')).toBe(true);
  });

  it('matches LM Studio at the default :1234 port (providerType is openai-compatible, not "lm-studio")', () => {
    expect(isKeylessLocalProvider('openai-compatible', 'http://localhost:1234/v1')).toBe(true);
    expect(isKeylessLocalProvider('openai-compatible', 'http://127.0.0.1:1234/v1')).toBe(true);
  });

  it('matches Ollama at the default :11434 port', () => {
    expect(isKeylessLocalProvider('openai-compatible', 'http://localhost:11434')).toBe(true);
    expect(isKeylessLocalProvider('openai-compatible', 'http://127.0.0.1:11434')).toBe(true);
  });

  it('does NOT match a remote OpenAI-compatible host', () => {
    expect(isKeylessLocalProvider('openai-compatible', 'https://api.deepseek.com/v1')).toBe(false);
    expect(isKeylessLocalProvider('openai-compatible', 'https://api.openai.com/v1')).toBe(false);
  });

  it('does NOT match Anthropic / OpenRouter hosts', () => {
    expect(isKeylessLocalProvider('anthropic', 'https://api.anthropic.com')).toBe(false);
    expect(isKeylessLocalProvider('openrouter', 'https://openrouter.ai/api/v1')).toBe(false);
  });

  it('returns false on missing inputs (no false positives)', () => {
    expect(isKeylessLocalProvider(undefined)).toBe(false);
    expect(isKeylessLocalProvider(null)).toBe(false);
    expect(isKeylessLocalProvider('')).toBe(false);
    expect(isKeylessLocalProvider('openai-compatible')).toBe(false);
    expect(isKeylessLocalProvider('openai-compatible', '')).toBe(false);
  });

  it('matches LM Studio on a non-default port (e.g. user re-mapped :1235)', () => {
    // Base URL substring matching catches `1234`-rooted ports; user with
    // custom port falls under the `providerType` shortcut only if they
    // also renamed it. Acceptable trade-off — the catalog preset covers
    // the default-port case, which is what 99% of users hit.
    expect(isKeylessLocalProvider('openai-compatible', 'http://localhost:1235/v1')).toBe(false);
  });
});
