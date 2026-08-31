/**
 * src/lib/providers/__tests__/presets.test.ts
 *
 * Tests for the BUILTIN_CATALOG-derived preset system.
 * The old hand-written presets/ directory has been removed;
 * all presets are now derived from @duya/ai BUILTIN_CATALOG.
 */

import { describe, it, expect } from 'vitest';
import {
  ALL_PRESETS,
  PRESET_BY_KEY,
  findPresetByKey,
  findPresetsByCategory,
} from '../catalog';

describe('preset registry', () => {
  it('exposes all presets via ALL_PRESETS', () => {
    expect(ALL_PRESETS.length).toBeGreaterThan(10);
    // No duplicate keys
    const keys = ALL_PRESETS.map((p) => p.key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('exposes each preset by key', () => {
    for (const p of ALL_PRESETS) {
      expect(PRESET_BY_KEY[p.key]).toBe(p);
      expect(findPresetByKey(p.key)).toBe(p);
    }
  });

  it('findPresetByKey returns undefined for missing', () => {
    expect(findPresetByKey('does-not-exist')).toBeUndefined();
  });

  it('findPresetsByCategory filters correctly', () => {
    const official = findPresetsByCategory('official');
    expect(official.every((p) => p.category === 'official')).toBe(true);
    expect(official.length).toBeGreaterThan(0);
  });

  it('resolves alias keys (aws-bedrock -> bedrock)', () => {
    const aliased = findPresetByKey('aws-bedrock');
    const canonical = findPresetByKey('bedrock');
    expect(aliased).toBeDefined();
    expect(aliased).toBe(canonical);
  });

  it('resolves alias keys (google-vertex -> vertex)', () => {
    const aliased = findPresetByKey('google-vertex');
    const canonical = findPresetByKey('vertex');
    expect(aliased).toBeDefined();
    expect(aliased).toBe(canonical);
  });
});

describe('preset shape', () => {
  it('every preset has required fields', () => {
    for (const p of ALL_PRESETS) {
      expect(p.key).toBeTruthy();
      expect(p.name).toBeTruthy();
      expect(p.category).toBeTruthy();
      expect(p.apiFormat).toBeTruthy();
      expect(Array.isArray(p.authFields)).toBe(true);
      expect(p.modelsSource).toBeTruthy();
    }
  });

  it('Anthropic presets use apiFormat=anthropic', () => {
    const anthropicPresets = ALL_PRESETS.filter((p) => p.apiFormat === 'anthropic');
    expect(anthropicPresets.length).toBeGreaterThan(0);
  });

  it('OpenAI presets use apiFormat=openai-chat', () => {
    const openaiPresets = ALL_PRESETS.filter((p) => p.apiFormat === 'openai-chat');
    expect(openaiPresets.length).toBeGreaterThan(0);
  });

  it('Ollama preset uses apiFormat=ollama with no auth', () => {
    const ollamaPresets = ALL_PRESETS.filter((p) => p.apiFormat === 'ollama');
    expect(ollamaPresets.length).toBe(1);
    expect(ollamaPresets[0].authFields.every((f) => !f.secret)).toBe(true);
  });

  it('Google Gemini uses apiFormat=gemini', () => {
    expect(ALL_PRESETS.some((p) => p.apiFormat === 'gemini')).toBe(true);
  });

  it('Bedrock uses apiFormat=bedrock', () => {
    expect(ALL_PRESETS.some((p) => p.apiFormat === 'bedrock')).toBe(true);
  });

  it('Custom presets fall through to custom category', () => {
    const customPresets = ALL_PRESETS.filter((p) => p.category === 'custom');
    expect(customPresets.length).toBeGreaterThan(0);
    expect(customPresets.every((p) => p.category === 'custom')).toBe(true);
  });

  it('Ollama preset has both candidates for endpoint auto-select', () => {
    const ollama = ALL_PRESETS.find((p) => p.apiFormat === 'ollama');
    expect(ollama).toBeDefined();
    expect(ollama!.endpointCandidates).toBeDefined();
    expect(ollama!.endpointCandidates!.length).toBeGreaterThanOrEqual(2);
  });
});
