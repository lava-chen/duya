import { describe, it, expect } from 'vitest';
import { BUILTIN_CATALOG } from '../src/providers/catalog.js';

describe('BUILTIN_CATALOG', () => {
  it('migrates at least 20 vendors from the frontend presets', () => {
    expect(BUILTIN_CATALOG.list().length).toBeGreaterThanOrEqual(20);
  });

  it('contains anthropic-official', () => {
    expect(BUILTIN_CATALOG.get('anthropic-official')).toBeDefined();
  });

  it('contains ollama', () => {
    expect(BUILTIN_CATALOG.get('ollama')).toBeDefined();
  });

  it('contains lm-studio', () => {
    const entry = BUILTIN_CATALOG.get('lm-studio');
    expect(entry).toBeDefined();
    expect(entry?.protocol).toBe('openai-chat');
    expect(entry?.baseUrl).toBe('http://localhost:1234/v1');
    expect(entry?.providerCategory).toBe('local');
  });

  it('contains minimax-cn', () => {
    expect(BUILTIN_CATALOG.get('minimax-cn')).toBeDefined();
  });
});