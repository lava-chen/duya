import { describe, it, expect } from 'vitest';
import { createAIClient } from '../src/index.js';

describe('createAIClient ollama branch', () => {
  it('constructs a lazy ollama client without making a network request', () => {
    const client = createAIClient({
      apiKey: '',
      baseURL: 'http://localhost:11434',
      model: 'qwen2.5',
      apiFormat: 'ollama',
      providerId: 'ollama',
    });
    // Lazy proxy: should already expose streamChat/chat without touching the network.
    expect(typeof client.streamChat).toBe('function');
    expect(typeof client.chat).toBe('function');
  });

  it('chat() throws for the native ollama client', async () => {
    const client = createAIClient({
      apiKey: '',
      baseURL: 'http://localhost:11434',
      model: 'qwen2.5',
      apiFormat: 'ollama',
      providerId: 'ollama',
    });
    await expect(client.chat?.([{ role: 'user', content: 'hi' }])).rejects.toThrow(/not supported/);
  });
});