/**
 * duyaAgent Integration Tests
 *
 * Tests the complete agent workflow using real API.
 * Requires ANTHROPIC_API_KEY environment variable.
 *
 * ## Why `describe.skipIf` and not a guard inside each test
 *
 * This file used to `if (!API_KEY) return;` at the top of every test and
 * `console.warn` in `beforeEach`. Two things were wrong with that:
 *
 *  - A missing key made the assertions VANISH and the test report GREEN. A
 *    suite that silently stops testing is worse than one that is honestly
 *    skipped, because the failure mode is invisible.
 *  - `duyaAgent` was never imported, so on any machine where a key WAS set
 *    (a local `.env`, which `test-setup.ts` loads through `dotenv`) all twelve
 *    tests died on `ReferenceError: duyaAgent is not defined`. CI has no key,
 *    so the guard hid a file that had never once run.
 *
 * `describe.skipIf(!API_KEY)` reports the skip, and the import makes the
 * suite executable when a key is genuinely present. Note that running it then
 * makes real, billable calls to the configured endpoint — it is opt-in by
 * virtue of the key, which is how it was always meant to work.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { ToolRegistry } from '../../src/tool/registry.js';
import { duyaAgent } from '../../src/index.js';
import type { SSEEvent } from '../../src/types.js';

const API_KEY = process.env.ANTHROPIC_API_KEY;
const MODEL = process.env.ANTHROPIC_MODEL || 'MiniMax-M2.7';
const BASE_URL = process.env.ANTHROPIC_BASE_URL;

describe.skipIf(!API_KEY)('duyaAgent Integration', () => {
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
        input_schema: { type: 'object', properties: { a: { type: 'number' }, b: { type: 'number' } } },
      },
      {
        execute: async (input: Record<string, unknown>) => ({
          id: crypto.randomUUID(),
          name: 'add',
          result: String((input.a as number) + (input.b as number)),
        }),
      }
    );
  });

  afterEach(() => {
    agent?.interrupt();
  });

  // ───────────────────────────────────────────────────────────────────
  // NOTE: the whole suite is `describe.skipIf(!API_KEY)`, so every test below
  // runs for real when a key is present and is reported as skipped when not.
  // No per-test guard, and no silent pass.
  // ───────────────────────────────────────────────────────────────────

  describe('streamChat basic flow', () => {
    it('should yield events from LLM response', async () => {
      agent = new duyaAgent({
        apiKey: API_KEY,
        provider: 'anthropic',
        model: MODEL,
        baseURL: BASE_URL,
      });

      const events: SSEEvent[] = [];
      for await (const event of agent.streamChat('Say hello', { toolRegistry })) {
        events.push(event);
      }

      expect(events.length).toBeGreaterThan(0);
      const textEvents = events.filter((e) => e.type === 'text');
      expect(textEvents.length).toBeGreaterThan(0);
    }, 60000);

    it('should yield tool_use events when LLM requests tool', async () => {
      agent = new duyaAgent({
        apiKey: API_KEY,
        provider: 'anthropic',
        model: MODEL,
        baseURL: BASE_URL,
      });

      const events: SSEEvent[] = [];
      for await (const event of agent.streamChat('Use the add tool with a=1 and b=2', { toolRegistry })) {
        events.push(event);
      }

      const toolUseEvents = events.filter((e) => e.type === 'tool_use');
      expect(toolUseEvents.length).toBeGreaterThan(0);
    }, 60000);

    it('should handle multiple tool calls', async () => {
      agent = new duyaAgent({
        apiKey: API_KEY,
        provider: 'anthropic',
        model: MODEL,
        baseURL: BASE_URL,
      });

      const events: SSEEvent[] = [];
      for await (const event of agent.streamChat('Use add tool with a=5 b=3 then echo "done"', { toolRegistry })) {
        events.push(event);
      }

      const toolUseEvents = events.filter((e) => e.type === 'tool_use');
      expect(toolUseEvents.length).toBeGreaterThanOrEqual(1);
    }, 60000);

    it('should handle text before tool_use', async () => {
      agent = new duyaAgent({
        apiKey: API_KEY,
        provider: 'anthropic',
        model: MODEL,
        baseURL: BASE_URL,
      });

      const events: SSEEvent[] = [];
      for await (const event of agent.streamChat('Calculate 10+20', { toolRegistry })) {
        events.push(event);
      }

      const textEvents = events.filter((e) => e.type === 'text');
      const toolUseEvents = events.filter((e) => e.type === 'tool_use');

      expect(textEvents.length).toBeGreaterThan(0);
      // Tool use may or may not happen depending on model behavior
    }, 60000);
  });

  describe('interrupt handling', () => {
    it('should support interrupt via abort controller', async () => {
      agent = new duyaAgent({
        apiKey: API_KEY,
        provider: 'anthropic',
        model: MODEL,
        baseURL: BASE_URL,
      });

      const events: SSEEvent[] = [];
      for await (const event of agent.streamChat('Count to 100', { toolRegistry })) {
        events.push(event);
        if (events.length >= 5) {
          agent.interrupt();
          break;
        }
      }

      expect(() => agent.interrupt()).not.toThrow();
    }, 30000);
  });

  describe('message management', () => {
    it('should clear messages', async () => {
      agent = new duyaAgent({
        apiKey: API_KEY,
        provider: 'anthropic',
        model: MODEL,
        baseURL: BASE_URL,
      });

      agent.clearMessages();
      expect(agent.getMessages().length).toBe(0);
    });

    it('should add single messages', async () => {
      agent = new duyaAgent({
        apiKey: API_KEY,
        provider: 'anthropic',
        model: MODEL,
        baseURL: BASE_URL,
      });

      agent.addMessage({
        role: 'user',
        content: 'Test message',
        timestamp: Date.now(),
      });

      expect(agent.getMessages().length).toBe(1);
      expect(agent.getMessages()[0].content).toBe('Test message');
    });

    it('should report session info', async () => {
      agent = new duyaAgent({
        apiKey: API_KEY,
        provider: 'anthropic',
        model: MODEL,
        baseURL: BASE_URL,
      });

      const info = agent.getSessionInfo();
      expect(info).toHaveProperty('id');
      expect(info).toHaveProperty('createdAt');
      expect(info).toHaveProperty('updatedAt');
      expect(typeof info.messageCount).toBe('number');
    });
  });

  describe('context management', () => {
    it('should report context stats', async () => {
      agent = new duyaAgent({
        apiKey: API_KEY,
        provider: 'anthropic',
        model: MODEL,
        baseURL: BASE_URL,
      });

      const stats = agent.getContextStats();
      expect(stats).toBeDefined();
      expect(typeof stats.totalTokens).toBe('number');
    });

    it('should check compaction need', async () => {
      agent = new duyaAgent({
        apiKey: API_KEY,
        provider: 'anthropic',
        model: MODEL,
        baseURL: BASE_URL,
      });

      const needsCompaction = agent.shouldCompact();
      expect(typeof needsCompaction).toBe('boolean');
    });
  });

  describe('error handling', () => {
    // Only meaningful against an endpoint that actually validates model ids.
    // A gateway or proxy (anything reached via ANTHROPIC_BASE_URL) commonly
    // accepts an unknown model name and answers normally — measured here: an
    // `invalid-model-xyz` turn produced a full `turn_start`/`thinking`/…/
    // `done` sequence, so "bad model => error" is simply not a law there.
    // Asserting it anyway produced a test that could only ever fail.
    const realAnthropicEndpoint = BASE_URL === undefined;

    it.skipIf(!realAnthropicEndpoint)(
      'never reports a bad model as a successful turn',
      async () => {
        agent = new duyaAgent({
          apiKey: API_KEY,
          provider: 'anthropic',
          model: 'invalid-model-xyz',
          baseURL: BASE_URL,
        });

        // The contract is "the turn fails, visibly" — not "it fails in this
        // specific shape". `streamChat` propagates a provider failure as a
        // thrown error and the router turns that into a `chat:error` frame;
        // the SSE `error` event is reserved for mode-layer failures
        // (`DuyaAgent.ts` emits it for an unknown mode and an orchestrator
        // failure, not for a bad model id). This test used to demand the
        // `error` event specifically, which the design has never produced — it
        // passed only because the missing-key guard meant it never executed.
        const events: SSEEvent[] = [];
        let threw: unknown = null;
        try {
          for await (const event of agent.streamChat('Hello', { toolRegistry })) {
            events.push(event);
          }
        } catch (err) {
          threw = err;
        }

        const errorEvents = events.filter((e) => e.type === 'error');
        const completedNormally = events.some((e) => e.type === 'done');
        expect(threw !== null || errorEvents.length > 0).toBe(true);
        // The important half: a provider that rejects the model must never be
        // reported to the host as a completed turn.
        expect(completedNormally).toBe(false);
      },
      30000,
    );

    it('should yield turn_start events', async () => {
      agent = new duyaAgent({
        apiKey: API_KEY,
        provider: 'anthropic',
        model: MODEL,
        baseURL: BASE_URL,
      });

      const events: SSEEvent[] = [];
      for await (const event of agent.streamChat('Hi', { toolRegistry })) {
        events.push(event);
      }

      const turnStartEvents = events.filter((e) => e.type === 'turn_start');
      expect(turnStartEvents.length).toBeGreaterThan(0);
    }, 60000);
  });
});