/**
 * provider-types — pure `toLLMProvider` mapping tests.
 *
 * Moved from the deleted `config-manager.test.ts` (plan 334 Phase 6a): the
 * mapping now lives in `config/provider-types.ts` (electron-free) so the
 * agent-server bundle can import it without dragging in Electron.
 */
import { describe, it, expect } from 'vitest';
import { toLLMProvider, type ApiProvider } from '../provider-types';

describe('toLLMProvider', () => {
  it('converts anthropic provider type', () => {
    expect(toLLMProvider('anthropic')).toBe('anthropic');
  });

  it('converts openai provider type', () => {
    expect(toLLMProvider('openai')).toBe('openai');
  });

  it('converts ollama provider type', () => {
    expect(toLLMProvider('ollama')).toBe('ollama');
  });

  it('converts openai-compatible to ollama when pointing to local ollama', () => {
    expect(toLLMProvider('openai-compatible', 'http://localhost:11434')).toBe('ollama');
    expect(toLLMProvider('openai-compatible', 'http://127.0.0.1:11434')).toBe('ollama');
  });

  it('converts openai-compatible to openai for other URLs', () => {
    expect(toLLMProvider('openai-compatible', 'https://api.example.com')).toBe('openai');
  });

  it('falls back to anthropic for unknown types', () => {
    expect(toLLMProvider('unknown' as ApiProvider['providerType'])).toBe('anthropic');
  });
});