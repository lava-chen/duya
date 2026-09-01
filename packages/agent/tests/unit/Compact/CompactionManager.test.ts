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
      expect(m.getAvailableStrategies()).toEqual(['session_memory']);
    });

    it('should create manager with custom config', () => {
      const m = createCompactionManager({
        maxTokens: 50000,
        systemPromptTokens: 4000,
        reservedTokens: 2000,
      });
      expect(m).toBeDefined();
    });

    it('has a single grok-aligned strategy (no micro/snip/reactive)', () => {
      const m = createCompactionManager();
      expect(m.getAvailableStrategies()).toEqual(['session_memory']);
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
      expect(manager.shouldCompact([])).toBe(false);
    });
  });

  describe('compact', () => {
    it('should compact messages using the session_memory strategy', async () => {
      const messages: Message[] = [
        createMessage('user', 'Hello'),
        createMessage('assistant', 'Hi there!'),
      ];

      const result = await manager.compact(messages);
      expect(result.strategy).toBe('session_memory');
      expect(result.tokensRemoved).toBeGreaterThanOrEqual(0);
      expect(result.tokensRetained).toBeGreaterThanOrEqual(0);
    });

    it('should use session_memory when explicitly specified', async () => {
      const messages: Message[] = [
        createMessage('user', 'Hello'),
        createMessage('assistant', 'Hi there!'),
      ];

      const result = await manager.compact(messages, { strategy: 'session_memory' });
      expect(result.strategy).toBe('session_memory');
    });

    it('should fall back to session_memory for unknown or legacy strategy names (micro/snip/reactive)', async () => {
      const messages: Message[] = [createMessage('user', 'Hello')];

      for (const legacy of ['micro', 'snip', 'reactive', 'unknown']) {
        const result = await manager.compact(messages, { strategy: legacy as any });
        expect(result.strategy).toBe('session_memory');
      }
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

  describe('preflight (plan 422 — grok alignment)', () => {
    it('throws "conversation is empty" when messages is []', async () => {
      await expect(manager.compact([])).rejects.toThrow(/conversation is empty/)
    })

    it('throws "conversation is empty" when messages is non-array', async () => {
      // The preflight rejects anything that isn't an array of messages, so a
      // future caller can't sneak null/undefined past the type checker.
      await expect(manager.compact(null as unknown as never)).rejects.toThrow(/conversation is empty/)
    })

    it('does not invoke the strategy when preflight throws', async () => {
      const summarizer = vi.fn(async () => 'should not be called')
      manager.setSummarizer(summarizer)
      await expect(manager.compact([])).rejects.toThrow()
      expect(summarizer).not.toHaveBeenCalled()
    })

    it('emits a compaction_error event when preflight throws', async () => {
      const handler = vi.fn()
      manager.addEventHandler(handler)
      await expect(manager.compact([])).rejects.toThrow()
      const errorEvents = handler.mock.calls.filter(([ev]) => ev.type === 'compaction_error')
      expect(errorEvents).toHaveLength(1)
      const payload = errorEvents[0][0] as { type: 'compaction_error'; error: string }
      expect(payload.error).toMatch(/conversation is empty/)
    })
  })

  describe('prefire (two-pass)', () => {
    const manyMessages = (n: number): Message[] =>
      Array.from({ length: n }, (_, i) =>
        createMessage(i % 2 === 0 ? 'user' : 'assistant', `msg ${i} `.repeat(20)),
      );

    it('shouldPrefire returns false below the prefire threshold', () => {
      manager.updateContextTokens(manyMessages(2));
      expect(manager.shouldPrefire(manyMessages(2))).toBe(false);
    });

    it('shouldPrefire returns false above the compaction threshold', () => {
      // Force usage into the compact band via observedPromptTokens anchor.
      manager.setObservedPromptTokens(90000);
      expect(manager.shouldPrefire(manyMessages(12))).toBe(false);
    });

    it('shouldPrefire returns true in the prefire band and no cache hit', async () => {
      const longSummary = 'prefire summary '.repeat(40);
      const summarizer = vi.fn(async () => longSummary);
      manager.setSummarizer(summarizer);
      const messages = manyMessages(12);
      manager.setObservedPromptTokens(70000);
      expect(manager.shouldPrefire(messages)).toBe(true);
      const summary = await manager.prefire(messages);
      expect(summary).toBe(longSummary.trim());
      // Cache satisfied — no longer triggers.
      expect(manager.shouldPrefire(messages)).toBe(false);
    });

    it('prefire returns empty string when no summarizer is set', async () => {
      const messages = manyMessages(12);
      manager.setObservedPromptTokens(70000);
      expect(await manager.prefire(messages)).toBe('');
    });

    it('cached prefire summary seeds the strategy on the next compaction', async () => {
      const longSummary = 'seeded prefire summary '.repeat(40);
      const summarizer = vi.fn(async () => longSummary);
      manager.setSummarizer(summarizer);
      const messages = [
        ...manyMessages(10),
        createMessage('user', 'final user turn'),
      ];
      const summary = await manager.prefire(messages);
      expect(summary).toBe(longSummary.trim());
      // getPrefireSummary returns the cached value for the same content.
      expect(manager.getPrefireSummary(messages)).toBe(longSummary.trim());
      // A different content set invalidates the cache.
      expect(manager.getPrefireSummary(manyMessages(3))).toBe('');
    });
  });

  describe('memory flush', () => {
    it('invokes the configured sink after compaction with the summary', async () => {
      const flush = vi.fn(async () => {});
      const summarizer = vi.fn(async () => {
        // A long, non-degenerate summary so the strategy stores it.
        return 'memory flush '.repeat(100);
      });
      manager.setMemoryFlushFn(flush);
      manager.setSummarizer(summarizer);

      const messages: Message[] = Array.from({ length: 40 }, (_, i) =>
        createMessage(i % 2 === 0 ? 'user' : 'assistant', `turn ${i} ` + 'detail '.repeat(300)),
      );
      await manager.compact(messages);
      expect(flush).toHaveBeenCalledTimes(1);
      const arg = flush.mock.calls[0][0] as string;
      expect(arg.length).toBeGreaterThan(0);
    });

    it('does not invoke the sink when none is configured', async () => {
      const summarizer = vi.fn(async () => 'short - degenerate, no summary stored');
      manager.setSummarizer(summarizer);
      const messages: Message[] = Array.from({ length: 30 }, (_, i) =>
        createMessage(i % 2 === 0 ? 'user' : 'assistant', `turn ${i} ` + 'detail '.repeat(30)),
      );
      await manager.compact(messages);
      // No sink → nothing to assert beyond not throwing.
      expect(true).toBe(true);
    });
  });
});
