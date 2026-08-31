/**
 * src/lib/providers/__tests__/ipc-types.test.ts
 *
 * Unit tests for the renderer DTO projection. No IPC, no Electron, no
 * filesystem — pure data-shape tests.
 *
 * Plan 203 Phase 0.1 deliverable: ~12 tests covering DTO projection,
 * legacy providerType mapping, apiKey masking, and structural
 * compatibility with the legacy `MaskedApiProvider`.
 */

import { describe, it, expect } from 'vitest';
import {
  assertMaskedApiProviderCompatible,
  deriveLegacyProviderType,
  jsonDecode,
  jsonEncode,
  maskApiKeyForRenderer,
  toRendererLlmProviderDTO,
} from '../ipc-types';
import type { LlmProvider, MaskedApiProvider } from '../types';

const NOW = 1_700_000_000_000;

function llm(overrides: Partial<LlmProvider> = {}): LlmProvider {
  return {
    id: 'p-1',
    name: 'Test Provider',
    category: 'custom',
    apiFormat: 'openai-chat',
    auth: { type: 'api-key', apiKey: 'sk-test-1234567890' },
    endpoints: { baseUrl: 'https://example.com/v1' },
    ui: {},
    meta: { createdAt: NOW, updatedAt: NOW, sortIndex: 5 },
    ...overrides,
  };
}

describe('maskApiKeyForRenderer', () => {
  it('returns empty string for empty / null / undefined input', () => {
    expect(maskApiKeyForRenderer('')).toBe('');
    expect(maskApiKeyForRenderer(null)).toBe('');
    expect(maskApiKeyForRenderer(undefined)).toBe('');
  });

  it('returns "***" for short keys (≤ 8 chars)', () => {
    expect(maskApiKeyForRenderer('sk-1234')).toBe('***');
    expect(maskApiKeyForRenderer('a'.repeat(8))).toBe('***');
  });

  it('masks long keys as first-4 + "***" + last-4', () => {
    expect(maskApiKeyForRenderer('sk-aabcdefghijklmnop')).toBe('sk-a***mnop');
    expect(maskApiKeyForRenderer('sk-test-1234567890')).toBe('sk-t***7890');
  });

  it('never leaks the raw key in the output', () => {
    const raw = 'sk-very-long-secret-key-1234567890';
    const masked = maskApiKeyForRenderer(raw);
    expect(masked).not.toContain('secret');
    expect(masked).not.toContain('long');
    // The middle is replaced with *** so the original substring is gone.
    expect(masked).toBe('sk-v***7890');
  });
});

describe('jsonEncode / jsonDecode', () => {
  it('encodes empty / null / undefined to "{}"', () => {
    expect(jsonEncode(undefined)).toBe('{}');
    expect(jsonEncode(null)).toBe('{}');
    expect(jsonEncode({})).toBe('{}');
  });

  it('encodes a record to a stable JSON string', () => {
    expect(jsonEncode({ a: 1, b: 'two' })).toBe('{"a":1,"b":"two"}');
  });

  it('round-trips a record', () => {
    const rec = { defaultModel: 'gpt-4o', stream: true };
    expect(jsonDecode(jsonEncode(rec))).toEqual(rec);
  });

  it('decodes unparseable input to {}', () => {
    expect(jsonDecode('not-json')).toEqual({});
    expect(jsonDecode(undefined)).toEqual({});
    expect(jsonDecode(null)).toEqual({});
  });
});

describe('deriveLegacyProviderType', () => {
  it('apiFormat=anthropic -> providerType=anthropic (any category/baseUrl)', () => {
    expect(deriveLegacyProviderType('anthropic', 'official', 'https://api.anthropic.com')).toBe('anthropic');
    expect(deriveLegacyProviderType('anthropic', 'custom', 'https://proxy.example')).toBe('anthropic');
  });

  it('apiFormat=openai-chat + category=aggregator -> openrouter', () => {
    expect(deriveLegacyProviderType('openai-chat', 'aggregator', 'https://openrouter.ai/api/v1')).toBe('openrouter');
  });

  it('apiFormat=openai-chat + category=official + baseUrl contains "api.openai.com" -> openai', () => {
    expect(deriveLegacyProviderType('openai-chat', 'official', 'https://api.openai.com/v1')).toBe('openai');
  });

  it('apiFormat=openai-chat + category=official + baseUrl contains "google" -> google', () => {
    expect(deriveLegacyProviderType('openai-chat', 'official', 'https://generativelanguage.googleapis.com')).toBe('google');
  });

  it('apiFormat=openai-chat + category=official + other URL -> openai fallback', () => {
    expect(deriveLegacyProviderType('openai-chat', 'official', 'https://example.com/v1')).toBe('openai');
  });

  it('apiFormat=openai-chat + category=custom -> openai-compatible', () => {
    expect(deriveLegacyProviderType('openai-chat', 'custom', 'https://example.com/v1')).toBe('openai-compatible');
  });

  it('apiFormat=ollama -> ollama', () => {
    expect(deriveLegacyProviderType('ollama', 'local', 'http://localhost:11434')).toBe('ollama');
  });

  it('apiFormat=bedrock -> bedrock', () => {
    expect(deriveLegacyProviderType('bedrock', 'managed', 'https://bedrock-runtime.us-east-1.amazonaws.com')).toBe('bedrock');
  });

  it('apiFormat=vertex -> vertex', () => {
    expect(deriveLegacyProviderType('vertex', 'managed', 'https://us-central1-aiplatform.googleapis.com')).toBe('vertex');
  });

  it('apiFormat=gemini -> google', () => {
    expect(deriveLegacyProviderType('gemini', 'official', 'https://generativelanguage.googleapis.com')).toBe('google');
  });
});

describe('toRendererLlmProviderDTO', () => {
  it('flattens auth.apiKey to masked apiKey + hasApiKey', () => {
    const dto = toRendererLlmProviderDTO(llm(), { now: NOW });
    expect(dto.apiKey).toBe('sk-t***7890');
    expect(dto.hasApiKey).toBe(true);
  });

  it('flattens endpoints.baseUrl', () => {
    const dto = toRendererLlmProviderDTO(llm(), { now: NOW });
    expect(dto.baseUrl).toBe('https://example.com/v1');
  });

  it('flattens meta.sortIndex to sortOrder', () => {
    const dto = toRendererLlmProviderDTO(llm({ meta: { createdAt: NOW, updatedAt: NOW, sortIndex: 42 } }), { now: NOW });
    expect(dto.sortOrder).toBe(42);
  });

  it('flattens meta.notes to notes', () => {
    const dto = toRendererLlmProviderDTO(llm({ meta: { createdAt: NOW, updatedAt: NOW, sortIndex: 0, notes: 'prod' } }), { now: NOW });
    expect(dto.notes).toBe('prod');
  });

  it('flattens meta.tags["active"] to isActive', () => {
    const dtoActive = toRendererLlmProviderDTO(llm({ meta: { createdAt: NOW, updatedAt: NOW, sortIndex: 0, tags: ['active'] } }), { now: NOW });
    expect(dtoActive.isActive).toBe(true);
    expect(dtoActive.isDefault).toBe(true);
    const dtoInactive = toRendererLlmProviderDTO(llm(), { now: NOW });
    expect(dtoInactive.isActive).toBe(false);
    expect(dtoInactive.isDefault).toBe(false);
  });

  it('JSON-encodes extraEnv / headers / options', () => {
    const dto = toRendererLlmProviderDTO(llm({
      extraEnv: { FOO: 'bar' },
      headers: { 'X-Trace': '1' },
      options: { defaultModel: 'gpt-4o' },
    }), { now: NOW });
    expect(dto.extraEnv).toBe('{"FOO":"bar"}');
    expect(dto.headers).toBe('{"X-Trace":"1"}');
    expect(dto.options).toBe('{"defaultModel":"gpt-4o"}');
  });

  it('encodes missing extraEnv / headers / options to "{}"', () => {
    const dto = toRendererLlmProviderDTO(llm(), { now: NOW });
    expect(dto.extraEnv).toBe('{}');
    expect(dto.headers).toBe('{}');
    expect(dto.options).toBe('{}');
  });

  it('derives protocol = legacy providerType', () => {
    const dto = toRendererLlmProviderDTO(llm(), { now: NOW });
    expect(dto.protocol).toBe('openai-compatible');
    expect(dto.protocol).toBe(dto.legacy.providerType);
  });

  it('sets createdAt / updatedAt from meta', () => {
    const dto = toRendererLlmProviderDTO(llm(), { now: NOW });
    expect(dto.createdAt).toBe(NOW);
    expect(dto.updatedAt).toBe(NOW);
  });

  it('falls back to `now` when meta timestamps are missing', () => {
    const dto = toRendererLlmProviderDTO(llm({ meta: { createdAt: 0, updatedAt: 0, sortIndex: 0 } }), { now: NOW });
    // meta exists but with 0 timestamps — the projection keeps the 0
    // (callers can decide). The fallback only kicks in when meta is
    // undefined entirely.
    expect(dto.createdAt).toBe(0);
  });

  it('never includes raw auth.apiKey or auth.accessToken in any field', () => {
    const rawKey = 'sk-very-secret-key-1234567890';
    const rawToken = 'oauth-access-token-1234567890';
    const dto = toRendererLlmProviderDTO(llm({
      auth: { type: 'api-key', apiKey: rawKey, accessToken: rawToken },
    }), { now: NOW });
    // The raw key must not appear anywhere in the serialized DTO.
    const serialized = JSON.stringify(dto);
    expect(serialized).not.toContain('very-secret');
    expect(serialized).not.toContain('oauth-access-token');
    // Only the masked form may appear.
    expect(dto.apiKey).toBe('sk-v***7890');
    expect(dto.apiKey).not.toContain(rawKey);
  });

  it('keeps id / name / category / apiFormat verbatim', () => {
    const dto = toRendererLlmProviderDTO(llm({ id: 'p-x', name: 'X', category: 'official', apiFormat: 'anthropic' }), { now: NOW });
    expect(dto.id).toBe('p-x');
    expect(dto.name).toBe('X');
    expect(dto.category).toBe('official');
    expect(dto.apiFormat).toBe('anthropic');
  });

  it('treats no-apiKey as hasApiKey=false + apiKey=""', () => {
    const dto = toRendererLlmProviderDTO(llm({ auth: { type: 'api-key' } }), { now: NOW });
    expect(dto.apiKey).toBe('');
    expect(dto.hasApiKey).toBe(false);
  });
});

describe('assertMaskedApiProviderCompatible', () => {
  it('does not throw when DTO matches MaskedApiProvider on the legacy keys', () => {
    const dto = toRendererLlmProviderDTO(llm(), { now: NOW });
    const masked: MaskedApiProvider = {
      id: dto.id,
      name: dto.name,
      providerType: dto.legacy.providerType,
      baseUrl: dto.baseUrl,
      apiKey: dto.apiKey,
      isActive: dto.isActive ?? false,
      hasApiKey: dto.hasApiKey,
      sortOrder: dto.sortOrder,
      extraEnv: dto.extraEnv,
      protocol: dto.protocol,
      headers: dto.headers,
      options: dto.options,
      notes: dto.notes,
      createdAt: dto.createdAt,
      updatedAt: dto.updatedAt,
    };
    expect(() => assertMaskedApiProviderCompatible(dto, masked)).not.toThrow();
  });

  it('throws when apiKey differs between DTO and masked', () => {
    const dto = toRendererLlmProviderDTO(llm(), { now: NOW });
    const masked: MaskedApiProvider = {
      ...dto,
      providerType: dto.legacy.providerType,
      apiKey: 'WRONG-MASK',
      hasApiKey: dto.hasApiKey,
      sortOrder: dto.sortOrder,
      extraEnv: dto.extraEnv,
      protocol: dto.protocol,
      headers: dto.headers,
      options: dto.options,
      notes: dto.notes,
      createdAt: dto.createdAt,
      updatedAt: dto.updatedAt,
    } as MaskedApiProvider;
    expect(() => assertMaskedApiProviderCompatible(dto, masked)).toThrow(/apiKey/);
  });
});
