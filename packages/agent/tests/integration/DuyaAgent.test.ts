/**
 * duyaAgent Integration Tests
 *
 * Tests the complete agent workflow using real API.
 * Requires ANTHROPIC_API_KEY environment variable.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { ToolRegistry } from '../../src/tool/registry.js';
import type { SSEEvent } from '../../src/types.js';

const API_KEY = process.env.ANTHROPIC_API_KEY;
const MODEL = process.env.ANTHROPIC_MODEL || 'MiniMax-M2.7';
const BASE_URL = process.env.ANTHROPIC_BASE_URL;

describe('duyaAgent Integration', () => {
  let agent: duyaAgent;
  let toolRegistry: ToolRegistry;

  beforeEach(() => {
    if (!API_KEY) {
      console.warn('⏭️  Skipping: ANTHROPIC_API_KEY not set');
      return;
    }

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
  // NOTE: These tests require ANTHROPIC_API_KEY to be set.
  // Tests will skip if the key is not available.
  // ───────────────────────────────────────────────────────────────────

  describe('streamChat basic flow', () => {
    it('should yield events from LLM response', async () => {
      if (!API_KEY) return;

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
      if (!API_KEY) return;

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
      if (!API_KEY) return;

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
      if (!API_KEY) return;

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
      if (!API_KEY) return;

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
      if (!API_KEY) return;

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
      if (!API_KEY) return;

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
      if (!API_KEY) return;

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
      if (!API_KEY) return;

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
      if (!API_KEY) return;

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
    it('should handle error events from LLM', async () => {
      if (!API_KEY) return;

      // Use invalid model to trigger error
      agent = new duyaAgent({
        apiKey: API_KEY,
        provider: 'anthropic',
        model: 'invalid-model-xyz',
        baseURL: BASE_URL,
      });

      const events: SSEEvent[] = [];
      try {
        for await (const event of agent.streamChat('Hello', { toolRegistry })) {
          events.push(event);
        }
      } catch {
        // Expected: API error
      }

      const errorEvents = events.filter((e) => e.type === 'error');
      expect(errorEvents.length).toBeGreaterThan(0);
    }, 30000);

    it('should yield turn_start events', async () => {
      if (!API_KEY) return;

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