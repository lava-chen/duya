/**
 * Tests for memory worker model resolution.
 */
import { describe, it, expect } from 'vitest';
import {
  extractModelFromQualifiedId,
  protocolDefaultModel,
  resolveMemoryModel,
} from '../memory-model-resolution';
import type { ApiProvider } from '../../../../src/lib/providers/types';

const baseProvider: ApiProvider = {
  id: 'minimax-cn',
  name: 'MiniMax (CN)',
  providerType: 'minimax',
  baseUrl: 'https://api.minimax.chat/v1',
  apiKey: 'sk-test',
  isActive: true,
};

describe('extractModelFromQualifiedId', () => {
  it('extracts model id from qualified value', () => {
    expect(extractModelFromQualifiedId('minimax-cn:MiniMax-M3')).toBe('MiniMax-M3');
  });

  it('handles model ids containing colons', () => {
    expect(extractModelFromQualifiedId('openrouter:qwen/qwen2.5-72b')).toBe('qwen/qwen2.5-72b');
  });

  it('returns empty for null or empty values', () => {
    expect(extractModelFromQualifiedId(null)).toBe('');
    expect(extractModelFromQualifiedId('')).toBe('');
    expect(extractModelFromQualifiedId(undefined)).toBe('');
  });

  it('returns empty for malformed values', () => {
    expect(extractModelFromQualifiedId('MiniMax-M3')).toBe('');
  });
});

describe('protocolDefaultModel', () => {
  it('returns expected defaults', () => {
    expect(protocolDefaultModel('anthropic')).toBe('claude-3-5-sonnet-20241022');
    expect(protocolDefaultModel('openai')).toBe('gpt-4o-mini');
    expect(protocolDefaultModel('ollama')).toBe('llama3.2');
  });
});

describe('resolveMemoryModel', () => {
  it('uses memoryModelId override first', () => {
    const provider: ApiProvider = {
      ...baseProvider,
      options: {
        defaultModel: 'default-model',
        model: 'options-model',
        enabled_models: ['enabled-1'],
      },
    };
    expect(resolveMemoryModel(provider, 'some-id:explicit-model', 'openai')).toBe('explicit-model');
  });

  it('falls back to options.defaultModel', () => {
    const provider: ApiProvider = {
      ...baseProvider,
      options: { defaultModel: 'default-model' },
    };
    expect(resolveMemoryModel(provider, null, 'openai')).toBe('default-model');
  });

  it('falls back to options.model', () => {
    const provider: ApiProvider = {
      ...baseProvider,
      options: { model: 'options-model' },
    };
    expect(resolveMemoryModel(provider, null, 'openai')).toBe('options-model');
  });

  it('falls back to enabled_models[0]', () => {
    const provider: ApiProvider = {
      ...baseProvider,
      options: { enabled_models: ['MiniMax-M3', 'MiniMax-M2'] },
    };
    expect(resolveMemoryModel(provider, null, 'openai')).toBe('MiniMax-M3');
  });

  it('uses protocol default when nothing else is set', () => {
    expect(resolveMemoryModel(baseProvider, null, 'anthropic')).toBe('claude-3-5-sonnet-20241022');
    expect(resolveMemoryModel(baseProvider, null, 'openai')).toBe('gpt-4o-mini');
    expect(resolveMemoryModel(baseProvider, null, 'ollama')).toBe('llama3.2');
  });
});
