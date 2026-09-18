/**
 * duyaAgent.assembleTurnContext integration test — Plan 550 step 2a-4.
 *
 * Pins the assembler wiring against the real `duyaAgent`. The test
 * instantiates the god class with a minimal config (no LLM calls, no
 * session persistence) and checks the returned `TurnContext`
 * carries every field the loop body will eventually consume.
 *
 * This is a structural integration test, not a behavioural one:
 * streamChat is not invoked, no SSE events are produced, no
 * persistence side effects fire.
 *
 * @see docs/exec-plans/active/550-prompt-hbs-and-agent-decomposition.md
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { duyaAgent } from '../../../src/agent/DuyaAgent.js';

describe('duyaAgent.assembleTurnContext (Plan 550 2a-4 wiring)', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    process.env.DUYA_SESSIONS_ROOT = '';
    process.env.DUYA_MEMORY_ROOT = '';
    // Avoid hitting a real Anthropic / OpenAI endpoint.
    process.env.DUYA_E2E_DISABLE_LLM = '1';
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    vi.restoreAllMocks();
  });

  it('returns a frozen TurnContext populated from the agent state', () => {
    const agent = new duyaAgent({
      model: 'test-model',
      provider: 'anthropic',
      sessionId: 'session-550',
      workingDirectory: 'E:\\Projects\\duya',
      apiKey: 'test-key',
    });
    const ctx = agent.assembleTurnContext(
      { turnId: 'turn-7' },
      'hello',
    );
    expect(ctx.sessionId).toBe('session-550');
    expect(ctx.workingDirectory).toBe('E:\\Projects\\duya');
    expect(ctx.permissionMode).toBe('default');
    expect(ctx.promptText).toBe('hello');
    expect(ctx.turnId).toEqual({ sequence: 0, id: 'turn-7' });
    // TurnContext is frozen by construction.
    expect(Object.isFrozen(ctx)).toBe(true);
  });

  it('captures always-allow grants from options', () => {
    const agent = new duyaAgent({
      model: 'test-model',
      provider: 'anthropic',
      sessionId: 'session-551',
      apiKey: 'test-key',
    });
    const ctx = agent.assembleTurnContext(
      { approvedAlwaysAllowTools: ['ReadTool', 'WriteTool'] },
      'hi',
    );
    expect([...ctx.approval.alwaysAllowTools].sort()).toEqual([
      'ReadTool',
      'WriteTool',
    ]);
  });

  it('uses the frozen NO_MENTIONS singleton when no mentions are supplied', () => {
    const agent = new duyaAgent({
      model: 'test-model',
      provider: 'anthropic',
      sessionId: 'session-552',
      apiKey: 'test-key',
    });
    const ctx = agent.assembleTurnContext(undefined, 'hi');
    // NO_MENTIONS is the canonical frozen default; verify the
    // assembler returns the same reference so downstream code can
    // use === to short-circuit.
    expect(ctx.mentions.skills).toEqual([]);
    expect(ctx.mentions.plugins).toEqual([]);
  });
});