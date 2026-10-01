import { describe, it, expect, vi, beforeEach } from 'vitest';
import { CompactionManager, createCompactionManager } from '../../../src/compact/CompactionManager.js';
import type { Message } from '../../../src/types.js';

/**
 * A summary the degeneracy guard will actually accept.
 *
 * Plan 523 added `isDegenerateSummary`: new summarizer output is rejected
 * unless it carries at least MIN_SUMMARY_CHARS and at least three distinct
 * numbered section headings, and the retry ladder then throws
 * `SummaryDegenerateError` once every attempt degenerates. The stubs in
 * this file all predate that guard -- `'memory flush '.repeat(100)` and
 * friends are long but structurally empty -- so every compaction here was
 * failing inside the strategy before it reached the assertion it was
 * written for. This helper returns the 9-section shape the prompt asks
 * for, which is the same fixture SessionMemoryCompactStrategy.test.ts uses.
 */
function validSummary(extra = ''): string {
  return (
    '1. Primary Request and Intent: Finish the audit remediation and land the PR stack.\n\n' +
    '2. Key Technical Concepts: HTTP+SSE three-tier split, IPC invoke/handle, MessagePort channels.\n\n' +
    '3. Files and Code Sections: packages/agent/src/compact/CompactionManager.ts — the compaction facade.\n\n' +
    '4. Errors and Fixes: Fixed a preflight guard that ran after it had already dereferenced the conversation.\n\n' +
    '5. Problem Solving: Resolved cross-compaction state leakage by keeping the prefire seed on the manager.\n\n' +
    '6. All User Messages: 修复审计发现的问题并交付分轨 PR。\n\n' +
    `7. Pending and Next Steps: continue the remaining tracks.${extra}\n\n` +
    '8. Current Work: consolidating the test-debt remediation.\n\n' +
    '9. Optional Next Step: open the next stacked PR.\n'
  );
}

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
      expect(m.getMaxTokens()).toBeGreaterThan(0);
    });

    it('should create manager with custom config', () => {
      const m = createCompactionManager({
        maxTokens: 50000,
        systemPromptTokens: 4000,
        reservedTokens: 2000,
      });
      expect(m).toBeDefined();
    });

    /**
     * `getAvailableStrategies()` is gone. Strategy enumeration was dropped
     * when the grok-aligned single strategy landed; the surviving way to
     * assert that micro/snip/reactive are gone is the fallback behaviour,
     * covered by the `compact` case below.
     */
  });

  describe('getStats', () => {
    it('should return initial stats', () => {
      const stats = manager.getStats();
      expect(stats.totalTokens).toBe(0);
      expect(stats.maxTokens).toBe(100000);
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

  /**
   * The circuit breaker is gone, replaced by the `Suppression` machine
   * (`isSuppressed` / `suppress` / `trySuppress` / `clearOnTurnStart` /
   * `clearOnBudgetChange`). Its behaviour — including the "not triggered
   * initially" case and the turn-scoped self-heal — is covered in
   * `src/compact/__tests__/CompactionManager.loop-guards.test.ts` under
   * "failure suppression (flat)".
   */

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

  /**
   * `shouldPrefire` / `prefire` / `getPrefireSummary` are gone. Prefire is
   * now a background pass: `maybeStartPrefire` returns void and kicks the
   * pass off, `hasFreshPrefire` reports availability, and
   * `takePrefireSummary` awaits and consumes. The state machine these five
   * cases used to reach into — threshold gating, the in-flight guard, the
   * no-summarizer case, consume-and-clear, and cache invalidation on a
   * different content set — is covered directly in
   * `src/compact/__tests__/BackgroundPrefire.test.ts`, which asserts each
   * of those against the class that now owns them.
   */

  describe('memory flush', () => {
    it('invokes the configured sink after compaction with the summary', async () => {
      const flush = vi.fn(async () => {});
      const summarizer = vi.fn(async () => validSummary());
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

    it('completes without a sink configured', async () => {
      // Previously this stubbed a degenerate summarizer and asserted
      // `expect(true).toBe(true)` -- a tautology that could not fail, while
      // the degenerate output actually made compact() throw. The real
      // contract is that a missing sink is simply not called.
      const summarizer = vi.fn(async () => validSummary());
      manager.setSummarizer(summarizer);
      const messages: Message[] = Array.from({ length: 30 }, (_, i) =>
        createMessage(i % 2 === 0 ? 'user' : 'assistant', `turn ${i} ` + 'detail '.repeat(30)),
      );
      await expect(manager.compact(messages)).resolves.toBeDefined();
    });
  });
});
