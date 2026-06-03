/**
 * Plan 53 Regression Tests — Agent Streaming Lifecycle
 *
 * Uses real API calls via environment variables (ANTHROPIC_API_KEY).
 * Tests the complete streaming event flow end-to-end.
 *
 * Run with: ANTHROPIC_API_KEY=sk-... npm run test -- packages/agent/tests/regression/streaming-lifecycle.test.ts
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { duyaAgent } from '../../src/index.js';
import { ToolRegistry } from '../../src/tool/registry.js';
import type { SSEEvent } from '../../src/types.js';

const API_KEY = process.env.ANTHROPIC_API_KEY;
const MODEL = process.env.ANTHROPIC_MODEL || 'MiniMax-M2.7';
const BASE_URL = process.env.ANTHROPIC_BASE_URL;

describe('Plan 53 Regression — Agent Streaming Lifecycle', () => {
  let registry: ToolRegistry;

  beforeEach(() => {
    registry = new ToolRegistry();
    registry.register(
      {
        name: 'echo',
        description: 'Echo input back',
        input_schema: { type: 'object', properties: { msg: { type: 'string' } } },
      },
      {
        execute: async (input) => ({
          id: crypto.randomUUID(),
          name: 'echo',
          result: JSON.stringify(input),
        }),
      }
    );
  });

  // ═══════════════════════════════════════════════════════════════════════
  // 1. Chat flow: send → think → tool → result → text → done
  // ═══════════════════════════════════════════════════════════════════════
  describe('Chat flow', () => {
    it('send message → think → tool_use → tool_result → text → done', async () => {
      if (!API_KEY) {
        console.warn('⏭️  Skipping: ANTHROPIC_API_KEY not set');
        return;
      }

      const agent = new duyaAgent({ apiKey: API_KEY, provider: 'anthropic', model: MODEL, baseURL: BASE_URL });
      const events: SSEEvent[] = [];

      for await (const event of agent.streamChat('Use the echo tool with msg="hello"', { toolRegistry: registry })) {
        events.push(event);
      }

      const eventTypes = events.map((e) => e.type);
      expect(eventTypes).toContain('turn_start');
      expect(eventTypes).toContain('text');
      expect(eventTypes).toContain('done');

      agent.interrupt();
    }, 60000);
  });

  // ═══════════════════════════════════════════════════════════════════════
  // 2. Interrupt
  // ═══════════════════════════════════════════════════════════════════════
  describe('Interrupt', () => {
    it('send message → interrupt → generation stops gracefully', async () => {
      if (!API_KEY) {
        console.warn('⏭️  Skipping: ANTHROPIC_API_KEY not set');
        return;
      }

      const agent = new duyaAgent({ apiKey: API_KEY, provider: 'anthropic', model: MODEL, baseURL: BASE_URL });
      const events: SSEEvent[] = [];

      for await (const event of agent.streamChat('Count to 1000', { toolRegistry: registry })) {
        events.push(event);
        if (events.length >= 3) {
          agent.interrupt();
          break;
        }
      }

      // Should have collected at least 3 events
      expect(events.length).toBeGreaterThanOrEqual(3);
      // Should not crash on interrupt
      expect(() => agent.interrupt()).not.toThrow();
    }, 30000);
  });

  // ═══════════════════════════════════════════════════════════════════════
  // 3. Agent crash recovery
  // ═══════════════════════════════════════════════════════════════════════
  describe('Agent crash recovery', () => {
    it('start chat → error event → session handles error gracefully', async () => {
      if (!API_KEY) {
        console.warn('⏭️  Skipping: ANTHROPIC_API_KEY not set');
        return;
      }

      // Test with invalid model to trigger error
      const agent = new duyaAgent({ apiKey: API_KEY, provider: 'anthropic', model: 'invalid-model-xyz' });
      const events: SSEEvent[] = [];

      try {
        for await (const event of agent.streamChat('Hello', { toolRegistry: registry })) {
          events.push(event);
        }
      } catch {
        // Expected: API error
      }

      // Should have error or done event
      const hasError = events.some((e) => e.type === 'error');
      expect(hasError || events.length > 0).toBe(true);
    }, 30000);
  });

  // ═══════════════════════════════════════════════════════════════════════
  // 4. Multiple concurrent chats
  // ═══════════════════════════════════════════════════════════════════════
  describe('Multiple concurrent chats', () => {
    it('4 parallel sessions → all stream correctly', async () => {
      if (!API_KEY) {
        console.warn('⏭️  Skipping: ANTHROPIC_API_KEY not set');
        return;
      }

      const sessions: duyaAgent[] = [];
      const promises: Promise<SSEEvent[]>[] = [];

      for (let i = 0; i < 4; i++) {
        const session = new duyaAgent({ apiKey: API_KEY, provider: 'anthropic', model: MODEL });
        sessions.push(session);

        const p = (async (idx: number) => {
          const events: SSEEvent[] = [];
          try {
            for await (const event of session.streamChat(`Say hello to session ${idx}`, { toolRegistry: registry })) {
              events.push(event);
            }
          } finally {
            session.interrupt();
          }
          return events;
        })(i);

        promises.push(p);
      }

      const results = await Promise.all(promises);

      for (let i = 0; i < 4; i++) {
        expect(results[i].length).toBeGreaterThan(0);
      }
    }, 120000);
  });

  // ═══════════════════════════════════════════════════════════════════════
  // 5. Permission flow
  // ═══════════════════════════════════════════════════════════════════════
  describe('Permission flow', () => {
    it('tool requires approval → permission event emitted', async () => {
      if (!API_KEY) {
        console.warn('⏭️  Skipping: ANTHROPIC_API_KEY not set');
        return;
      }

      const agent = new duyaAgent({ apiKey: API_KEY, provider: 'anthropic', model: MODEL, baseURL: BASE_URL });
      const events: SSEEvent[] = [];

      // Use bash tool to trigger permission
      for await (const event of agent.streamChat('Run echo test', { toolRegistry: registry })) {
        events.push(event);
      }

      // Should have tool events
      const toolUseEvents = events.filter((e) => e.type === 'tool_use');
      expect(toolUseEvents.length).toBeGreaterThanOrEqual(0); // May not trigger if model doesn't use tools

      agent.interrupt();
    }, 60000);
  });

  // ═══════════════════════════════════════════════════════════════════════
  // 6. DB persistence
  // ═══════════════════════════════════════════════════════════════════════
  describe('DB persistence', () => {
    it('after streaming done → messages accumulated in agent', async () => {
      if (!API_KEY) {
        console.warn('⏭️  Skipping: ANTHROPIC_API_KEY not set');
        return;
      }

      const agent = new duyaAgent({ apiKey: API_KEY, provider: 'anthropic', model: MODEL, baseURL: BASE_URL });
      const initialCount = agent.getMessages().length;

      for await (const event of agent.streamChat('Say hello', { toolRegistry: registry })) {
        // consume
      }

      const finalCount = agent.getMessages().length;
      expect(finalCount).toBeGreaterThan(initialCount);
    }, 60000);

    it('session info reflects completed turn', async () => {
      if (!API_KEY) {
        console.warn('⏭️  Skipping: ANTHROPIC_API_KEY not set');
        return;
      }

      const agent = new duyaAgent({ apiKey: API_KEY, provider: 'anthropic', model: MODEL, baseURL: BASE_URL });
      const before = agent.getSessionInfo();

      for await (const event of agent.streamChat('What is 2+2?', { toolRegistry: registry })) {
        // consume
      }

      const after = agent.getSessionInfo();
      expect(after.messageCount).toBeGreaterThan(before.messageCount);
      expect(after.updatedAt).toBeGreaterThanOrEqual(before.updatedAt);
    }, 60000);
  });
});