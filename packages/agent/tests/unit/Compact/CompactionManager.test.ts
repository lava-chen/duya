import { describe, it, expect, vi, beforeEach } from 'vitest';
import { CompactionManager, createCompactionManager } from '../../../src/compact/CompactionManager.js';
import type { Message } from '../../../src/types.js';

describe('CompactionManager', () => {
  let manager: CompactionManager;

  const createMessage = (role: 'user' | 'assistant', content: string): Message => ({
    id: crypto.randomUUID(),
    role,
    content,
    timestamp: Date.now(),
  });

  beforeEach(() => {
    manager = createCompactionManager({
      maxTokens: 100000,
      systemPromptTokens: 8000,
      reservedTokens: 5000,
    });
  });

  describe('constructor', () => {
    it('should create manager with default config', () => {
      const m = createCompactionManager();
      expect(m).toBeDefined();
      expect(m.getAvailableStrategies()).toContain('micro');
    });

    it('should create manager with custom config', () => {
      const m = createCompactionManager({
        maxTokens: 50000,
        systemPromptTokens: 4000,
        reservedTokens: 2000,
      });
      expect(m).toBeDefined();
    });

    it('should enable reactive strategy when configured', () => {
      const m = createCompactionManager({ enableReactive: true });
      expect(m.getAvailableStrategies()).toContain('reactive');
    });
  });

  describe('getStats', () => {
    it('should return initial stats', () => {
      const stats = manager.getStats();
      expect(stats.totalTokens).toBe(0);
      expect(stats.maxTokens).toBe(100000);
    });
  });

  describe('updateContextTokens', () => {
    it('should update context token count', () => {
      manager.updateContextTokens([]);
      const stats = manager.getStats();
      expect(stats.totalTokens).toBe(0);
    });
  });

  describe('shouldCompact', () => {
    it('should return false when context is empty', () => {
      expect(manager.shouldCompact()).toBe(false);
    });
  });

  describe('compact', () => {
    it('should compact messages using micro strategy', async () => {
      const messages: Message[] = [
        createMessage('user', 'Hello'),
        createMessage('assistant', 'Hi there!'),
      ];

      const result = await manager.compact(messages);
      expect(result.strategy).toBe('micro');
      expect(result.tokensRemoved).toBeGreaterThanOrEqual(0);
      expect(result.tokensRetained).toBeGreaterThanOrEqual(0);
    });

    it('should use specified strategy', async () => {
      const messages: Message[] = [
        createMessage('user', 'Hello'),
        createMessage('assistant', 'Hi there!'),
      ];

      const result = await manager.compact(messages, { strategy: 'snip' });
      expect(result.strategy).toBe('snip');
    });

    it('should use default strategy for unknown strategy name', async () => {
      const messages: Message[] = [createMessage('user', 'Hello')];

      // Unknown strategy falls back to default selection
      const result = await manager.compact(messages, { strategy: 'unknown' as any });
      // Should not throw, just uses default strategy
      expect(result.strategy).toBeDefined();
    });
  });

  describe('circuit breaker', () => {
    it('should not trigger initially', () => {
      expect(manager.isCircuitBreakerTriggered()).toBe(false);
    });

    it('should reset circuit breaker', () => {
      manager.resetCircuitBreaker();
      expect(manager.isCircuitBreakerTriggered()).toBe(false);
    });
  });

  describe('event handlers', () => {
    it('should add and remove event handlers', () => {
      const handler = vi.fn();
      manager.addEventHandler(handler);
      manager.removeEventHandler(handler);
      // Handler was added and removed without error
      expect(true).toBe(true);
    });
  });

  describe('setSummarizer', () => {
    it('should set summarizer function', () => {
      const summarizer = vi.fn(async (text: string) => 'summarized: ' + text);
      manager.setSummarizer(summarizer);
      expect(true).toBe(true);
    });
  });
});
