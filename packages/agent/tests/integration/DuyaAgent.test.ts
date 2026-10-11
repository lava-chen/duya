/**
 * duyaAgent public-surface contract.
 *
 * ## Why this file no longer needs an API key
 *
 * This suite used to be a live-API integration suite: every case began
 * `if (!API_KEY) return;` and then drove `agent.streamChat(...)`. That shape
 * was worse than useless in CI:
 *
 *  - **Without a key, all 12 cases reported GREEN while asserting nothing.**
 *    A suite that skips itself is green in every failure statistic there is,
 *    so the "tests pass" signal carried zero information about these cases.
 *  - **With a key, all 12 would have thrown.** `duyaAgent.streamChat` no longer
 *    exists -- the turn loop moved to `RunEngineImpl` (plan 610 A3). Verified
 *    by declaration-site search, not by reading prose: `streamChat` has NO
 *    declaration in `DuyaAgent.ts`; every remaining mention is a doc comment.
 *
 * So the file is split by what each case actually NEEDS, not by what it
 * happened to be written against:
 *
 *  - Cases touching only surviving methods (`clearMessages`, `addMessage`,
 *    `getMessages`, `getSessionInfo`, `getContextStats`, `shouldCompact`,
 *    `interrupt`) need **no network at all**. They are real assertions about
 *    the agent's public surface and they now RUN. Their `if (!API_KEY) return;`
 *    guards are gone, because that guard was suppressing tests that never
 *    needed a credential in the first place -- a test hidden behind an early
 *    return is not a skipped test, it is a test that does not exist.
 *  - Cases that genuinely require a live provider call to mean anything are
 *    under `describe.skip`, with the reason stated inline. `skip` is the
 *    honest signal: vitest reports them as skipped instead of counting them as
 *    passes, so the file can never again report green for assertions it did
 *    not make.
 *
 * What replaced the deleted coverage: the engine path is covered by the proof
 * suites in `packages/agent/src/process/__tests__/` (`engine-*`), which drive
 * the real `RunEngineImpl` through `driveRunWithEngine` with a scripted
 * provider -- no credentials, no network, and unlike this file they CAN fail.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { duyaAgent } from '../../src/index.js';
import { ToolRegistry } from '../../src/tool/registry.js';

/**
 * An agent constructed without credentials.
 *
 * These cases never open a provider connection, so there is nothing to
 * authenticate. Passing a dummy key keeps the constructor's contract intact
 * (it still validates that a key is present) without implying a live call.
 */
function offlineAgent(): duyaAgent {
  return new duyaAgent({
    apiKey: 'offline-surface-probe',
    provider: 'anthropic',
    model: 'MiniMax-M2.7',
  });
}

describe('duyaAgent public surface (offline)', () => {
  let agent: duyaAgent;
  let toolRegistry: ToolRegistry;

  beforeEach(() => {
    toolRegistry = new ToolRegistry();
    toolRegistry.register(
      {
        name: 'echo',
        description: 'Echo input back',
        input_schema: { type: 'object', properties: { msg: { type: 'string' } } },
      },
      {
        execute: async (input) => ({
          id: crypto.randomUUID(),
          name: 'echo',
          result: `Echo: ${JSON.stringify(input)}`,
        }),
      }
    );
    toolRegistry.register(
      {
        name: 'add',
        description: 'Add two numbers',
        input_schema: {
          type: 'object',
          properties: { a: { type: 'number' }, b: { type: 'number' } },
        },
      },
      {
        execute: async (input: Record<string, unknown>) => ({
          id: crypto.randomUUID(),
          name: 'add',
          result: String((input.a as number) + (input.b as number)),
        }),
      }
    );
    agent = offlineAgent();
  });

  afterEach(() => {
    agent?.interrupt();
  });

  describe('message management', () => {
    it('starts empty and records the messages added to it', () => {
      // Read the same collection twice, so an assertion cannot be satisfied by
      // a constant: the count has to actually move.
      expect(agent.getMessages().length).toBe(0);

      agent.addMessage({ role: 'user', content: 'Test message', timestamp: Date.now() });

      const messages = agent.getMessages();
      expect(messages.length).toBe(1);
      expect(messages[0].content).toBe('Test message');
    });

    it('clears the accumulated history', () => {
      agent.addMessage({ role: 'user', content: 'first', timestamp: Date.now() });
      agent.addMessage({ role: 'assistant', content: 'second', timestamp: Date.now() });
      expect(agent.getMessages().length).toBe(2);

      agent.clearMessages();

      // Not merely "less than before" -- exactly empty, so a partial clear is
      // a failure rather than a pass.
      expect(agent.getMessages().length).toBe(0);
    });

    it('accounts for the message count in the session info it reports', () => {
      const before = agent.getSessionInfo();

      agent.addMessage({ role: 'user', content: 'counted', timestamp: Date.now() });

      const after = agent.getSessionInfo();
      // The two sides are different code: one is the history, the other is the
      // derived session summary. A counter that never updated fails here.
      expect(after.messageCount).toBe(before.messageCount + 1);
      expect(after.messageCount).toBe(agent.getMessages().length);
    });
  });

  describe('session info', () => {
    it('reports the fields a caller depends on', () => {
      const info = agent.getSessionInfo();

      expect(info).toHaveProperty('id');
      expect(info).toHaveProperty('createdAt');
      expect(info).toHaveProperty('updatedAt');
      expect(typeof info.messageCount).toBe('number');
      // A non-empty id: `toHaveProperty` alone would pass on an undefined one.
      expect(typeof info.id).toBe('string');
      expect(info.id.length).toBeGreaterThan(0);
    });
  });

  describe('context statistics', () => {
    it('reports a numeric token total before any turn has run', () => {
      const stats = agent.getContextStats();

      expect(stats).toBeDefined();
      // A fresh agent has measured nothing, so the honest value is a real
      // number that is not a NaN placeholder -- `typeof NaN === 'number'`, so
      // the type check alone would pass on it.
      expect(typeof stats.totalTokens).toBe('number');
      expect(Number.isNaN(stats.totalTokens)).toBe(false);
    });

    it('answers the compaction question without a turn having run', () => {
      // A boolean either way is a legitimate answer; what is NOT acceptable is
      // the question silently never being asked, which is what an early
      // return produced here.
      const needsCompaction = agent.shouldCompact();

      expect(typeof needsCompaction).toBe('boolean');
    });
  });

  describe('interrupt', () => {
    it('is safe to call on an idle agent', () => {
      // `interrupt()` is the one control that must never throw: it is called
      // from teardown paths, so a throw here is a crash in the caller's
      // cleanup rather than a visible test failure.
      expect(() => agent.interrupt()).not.toThrow();
      // Repeatable, because the real teardown can call it more than once.
      expect(() => agent.interrupt()).not.toThrow();
    });
  });
});

/**
 * The cases that needed a live provider stream.
 *
 * `duyaAgent.streamChat` was removed when the turn loop moved to
 * `RunEngineImpl` (plan 610 A3), so these cannot run against the agent API any
 * more -- with a key set they threw `TypeError: agent.streamChat is not a
 * function` on every one of them.
 *
 * They are kept as SKIPS, not deleted, because the behaviours they describe
 * are still the contract a turn must satisfy; only the entry point moved. The
 * equivalent guarantees now live in `packages/agent/src/process/__tests__/`
 * (`engine-*`), which drive the real engine against a scripted provider.
 *
 * `describe.skip` rather than a runtime `if (!API_KEY) return`: a skip is
 * REPORTED as a skip, while an early return is reported as a pass. The second
 * is what let this file stay green while asserting nothing.
 */
describe.skip('duyaAgent streaming (needs a live provider — see above)', () => {
  it('should yield events from LLM response', () => {
    expect.hasAssertions();
  });

  it('should yield tool_use events when LLM requests tool', () => {
    expect.hasAssertions();
  });

  it('should handle multiple tool calls', () => {
    expect.hasAssertions();
  });

  it('should handle text before tool_use', () => {
    expect.hasAssertions();
  });

  it('should support interrupt via abort controller', () => {
    expect.hasAssertions();
  });

  it('should handle error events from LLM', () => {
    expect.hasAssertions();
  });

  it('should yield turn_start events', () => {
    expect.hasAssertions();
  });
});