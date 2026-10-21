import { describe, it, expect } from 'vitest';
import { inferProvider, isMiniMaxURL } from '../src/utils/infer-provider.js';

describe('inferProvider', () => {
  it('detects anthropic', () => {
    expect(inferProvider('https://api.anthropic.com')).toBe('anthropic');
  });
  it('detects openai /v1', () => {
    expect(inferProvider('https://api.openai.com/v1')).toBe('openai');
  });
  it('detects ollama localhost without /v1', () => {
    expect(inferProvider('http://localhost:11434')).toBe('ollama');
  });
  it('detects openrouter', () => {
    expect(inferProvider('https://openrouter.ai/api/v1')).toBe('openai');
  });
});

describe('isMiniMaxURL', () => {
  it('detects MiniMax domains', () => {
    expect(isMiniMaxURL('https://api.minimax.io')).toBe(true);
    expect(isMiniMaxURL('https://api.minimaxi.com')).toBe(true);
    expect(isMiniMaxURL('https://api.minimaxi.io')).toBe(false);
  });
});