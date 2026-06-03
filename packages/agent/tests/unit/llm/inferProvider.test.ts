import { describe, it, expect } from 'vitest';
import { inferProvider } from '../../../src/llm/index.js';
import type { LLMProvider } from '../../../src/types.js';

describe('inferProvider', () => {
  it('should infer anthropic for pure anthropic URLs', () => {
    expect(inferProvider('https://api.anthropic.com')).toBe('anthropic');
  });

  it('should infer openai for openai base URLs', () => {
    expect(inferProvider('https://api.openai.com')).toBe('openai');
    expect(inferProvider('https://api.openai.com/v1')).toBe('openai');
  });

  it('should infer openai for URLs with /v1 path', () => {
    expect(inferProvider('https://api.anthropic.com/v1')).toBe('openai');
    expect(inferProvider('https://api.example.com/v1/chat/completions')).toBe('openai');
  });

  it('should infer openai for openrouter URLs', () => {
    expect(inferProvider('https://openrouter.ai/api/v1')).toBe('openai');
  });

  it('should infer anthropic for anthropic-themed URLs', () => {
    expect(inferProvider('https://anthropic.example.com')).toBe('anthropic');
  });

  it('should return anthropic by default for unknown URLs', () => {
    expect(inferProvider('https://unknown.example.com')).toBe('anthropic');
  });
});
