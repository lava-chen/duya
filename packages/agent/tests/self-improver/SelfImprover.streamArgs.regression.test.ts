/**
 * packages/agent/tests/self-improver/SelfImprover.streamArgs.regression.test.ts
 *
 * Regression test pinned to a specific historical bug: SelfImprover
 * passed the role/system prompt as the FIRST positional argument to
 * `duyaAgent.streamChat`, which is the user-message slot. Sub-agents
 * (Creator / Evaluator / Creator-Revising) would receive the role
 * instructions as the user's question and never invoke skill_manage.
 *
 * The fix: pass a real user-role query as the first arg, and put
 * SKILL_*_PROMPT into options.systemPrompt.
 *
 * We mock duyaAgent with vi.mock and capture every streamChat call
 * across the three sub-agent entry points. The test asserts:
 *   - First arg is a string that does NOT begin with the role
 *     prefix "You are a skill " (which would be the system prompt
 *     being misused as a user prompt).
 *   - options.systemPrompt is a string and DOES begin with the role
 *     prefix.
 *
 * This test covers the Creator Phase via the public
 * `initiateSkillCreation` path. The Evaluator and Creator-Revising
 * sub-agents share the same calling convention (verified by reading
 * the source), and the unit state-machine tests cover their
 * surrounding logic separately.
 */

// The constructor module is mocked directly so this regression test does not
// initialize the full worker/runtime graph.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// We mock the os.homedir() so the draft manager reads from a temp
// directory and doesn't accidentally touch the developer's real home.
const tmpHome = mkdtempSync(join(tmpdir(), 'duya-selfimprover-regression-'));
vi.mock('node:os', async () => {
  const actual = await vi.importActual<typeof import('node:os')>('node:os');
  return {
    ...actual,
    homedir: () => tmpHome,
  };
});

// Capture all streamChat calls across the test
type CapturedCall = { prompt: unknown; options: Record<string, unknown> };
const capturedCalls: CapturedCall[] = [];

// Mock duyaAgent with a minimal fake. SelfImprover dynamically imports the
// implementation module, constructs the class, then iterates over
// creatorAgent.streamChat(prompt, options).
//
// The fake streamChat captures the call args and yields a benign
// "nothing to save" text response so the public initiateSkillCreation
// path exits cleanly without entering the evaluator loop.
vi.mock('../../src/agent/DuyaAgent.js', () => {
  class FakeDuyaAgent {
    private messages: unknown[] = [];
    constructor(_opts: unknown) {
      // no-op
    }
    setMessages(messages: unknown[]) {
      this.messages = [...messages];
    }
    getMessages() {
      return this.messages;
    }
    interrupt() {
      // no-op
    }
    async *streamChat(prompt: unknown, options?: Record<string, unknown>) {
      capturedCalls.push({ prompt, options: options ?? {} });
      // Yield a text response that the SelfImprover interprets as
      // "Creator decided nothing to save", so the test exits without
      // entering the evaluator loop.
      yield {
        type: 'text',
        data: 'After reviewing the conversation, I have determined there is nothing significant to save at this time.',
      };
      yield { type: 'done' };
    }
  }
  return {
    duyaAgent: FakeDuyaAgent,
  };
});

describe('SelfImprover streamChat argument shape (regression)', () => {
  beforeEach(() => {
    capturedCalls.length = 0;
  });

  it('passes user-role prompt as first arg and SKILL_CREATOR_PROMPT as systemPrompt', { timeout: 30000 }, async () => {
    const { SelfImprover } = await import('../../src/self-improver/SelfImprover.js');
    const si = new SelfImprover(10);

    await si.initiateSkillCreation(
      [
        { role: 'user', content: 'Help me refactor this TypeScript file', timestamp: Date.now() - 1000 },
        { role: 'assistant', content: 'I will help you refactor the file.', timestamp: Date.now() - 500 },
      ],
      {
        apiKey: 'test-key',
        model: 'claude-test-model',
      },
      process.cwd(),
    );

    // Creator Phase is the only sub-agent invoked (Evaluator is
    // skipped because Creator returned created: false).
    expect(capturedCalls.length).toBe(1);
    const [first] = capturedCalls;
    const { prompt, options } = first;

    // First arg must be a non-empty user-role string.
    expect(typeof prompt).toBe('string');
    expect((prompt as string).length).toBeGreaterThan(0);

    // Crucially, it must NOT be the system prompt (which starts with
    // "You are a skill creator."). This is the actual bug being
    // guarded against: if the role prompt leaks into the user slot,
    // the LLM treats it as the user's question and never calls
    // skill_manage.
    expect(prompt).not.toMatch(/^You are a skill creator\./);
    // The user prompt for the Creator phase is built from
    // SKILL_REVIEW_PROMPT which asks the agent to "Review the
    // conversation above and consider saving or updating a skill".
    expect(prompt).toMatch(/Review the conversation above/);

    // options.systemPrompt must be set and start with the role line.
    expect(options).toBeDefined();
    expect(typeof options.systemPrompt).toBe('string');
    expect((options.systemPrompt as string).length).toBeGreaterThan(0);
    expect(options.systemPrompt).toMatch(/^You are a skill creator\./);
  });
});
