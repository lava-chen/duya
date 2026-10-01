import { describe, it, expect } from 'vitest';
import {
  buildBotModelGroups,
  prefixedToRaw,
  findRawModelInGroups,
} from '../bot-model-options';
import type { Provider } from '../ipc-client';

function provider(partial: Partial<Provider>): Provider {
  return {
    id: 'p',
    name: 'P',
    providerType: 'openai',
    baseUrl: '',
    apiKey: '',
    hasApiKey: false,
    sortOrder: 0,
    extraEnv: '',
    protocol: '',
    headers: '',
    options: '{}',
    notes: '',
    createdAt: 0,
    updatedAt: 0,
    ...partial,
  } as Provider;
}

describe('bot-model-options', () => {
  describe('prefixedToRaw', () => {
    it('strips the provider prefix', () => {
      expect(prefixedToRaw('[Zhipu] glm-4')).toBe('glm-4');
      expect(prefixedToRaw('[A B] m c')).toBe('m c');
    });
    it('returns the input unchanged without a prefix', () => {
      expect(prefixedToRaw('glm-4')).toBe('glm-4');
    });
  });

  describe('findRawModelInGroups', () => {
    const groups = [
      { id: 'zhipu', name: 'Zhipu', models: [{ id: '[Zhipu] glm-4', display_name: 'glm-4' }] },
    ];
    it('finds the group exposing a raw model', () => {
      expect(findRawModelInGroups('glm-4', groups)?.name).toBe('Zhipu');
    });
    it('returns null when the model is absent', () => {
      expect(findRawModelInGroups('claude-4', groups)).toBeNull();
    });
  });

  describe('buildBotModelGroups', () => {
    it('reads enabled_models and prefixed ids', () => {
      const groups = buildBotModelGroups([
        provider({
          id: 'zhipu',
          name: 'Zhipu',
          hasApiKey: true,
          options: JSON.stringify({ enabled_models: ['glm-4', '"glm-4.5"'] }),
        }),
      ]);
      expect(groups).toHaveLength(1);
      expect(groups[0].name).toBe('Zhipu');
      expect(groups[0].models.map((m) => m.id)).toEqual(['[Zhipu] glm-4', '[Zhipu] glm-4.5']);
      expect(groups[0].models.map((m) => m.display_name)).toEqual(['glm-4', 'glm-4.5']);
    });

    it('falls back to defaultModel when enabled_models is empty', () => {
      const groups = buildBotModelGroups([
        provider({
          id: 'zhipu',
          name: 'Zhipu',
          hasApiKey: true,
          options: JSON.stringify({ defaultModel: 'glm-4' }),
        }),
      ]);
      expect(groups[0].models.map((m) => m.id)).toEqual(['[Zhipu] glm-4']);
    });

    it('skips providers without a key (unless keyless-local)', () => {
      const groups = buildBotModelGroups([
        provider({ id: 'nokey', name: 'NoKey', hasApiKey: false, options: JSON.stringify({ enabled_models: ['x'] }) }),
        provider({ id: 'ollama', name: 'Ollama', providerType: 'ollama', baseUrl: 'http://localhost:11434', hasApiKey: false, options: JSON.stringify({ enabled_models: ['llama3'] }) }),
      ]);
      expect(groups.map((g) => g.id)).toEqual(['ollama']);
    });

    it('treats malformed options JSON as having no models', () => {
      const groups = buildBotModelGroups([
        provider({ id: 'bad', name: 'Bad', hasApiKey: true, options: 'not-json{' }),
      ]);
      expect(groups).toHaveLength(0);
    });

    it('deduplicates the same prefixed model across providers', () => {
      const groups = buildBotModelGroups([
        provider({ id: 'a', name: 'A', hasApiKey: true, options: JSON.stringify({ enabled_models: ['m1'] }) }),
        provider({ id: 'b', name: 'A', hasApiKey: true, options: JSON.stringify({ enabled_models: ['m1', 'm2'] }) }),
      ]);
      const all = groups.flatMap((g) => g.models.map((m) => m.id));
      expect(all).toEqual(['[A] m1', '[A] m2']);
    });
  });
});
