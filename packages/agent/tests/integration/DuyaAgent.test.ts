/**
 * duyaAgent agent-state tests — plan 610 A4 pre-clean residue.
 *
 * The old file drove `agent.streamChat(...)`, an entry point plan 610 A3
 * (S4c-d3, commit `4444c7cf`) deleted from `duyaAgent`. Every stream case was
 * silently vacuous without ANTHROPIC_API_KEY (an early `return` inside `it`
 * counts as a pass) and threw `TypeError` with one — 7 dead calls behind
 * 13 vacuous guards, 0 executing assertions.
 *
 * Disposition of the old cases (2026-10-10, A4 pre-clean):
 *
 *  - stream basic flow / tool_use / interrupt / error events → DELETED, not
 *    migrated. The product-turn behaviours they probed are already pinned
 *    offline by `tests/unit/agent/turn-loop-product-behavior.test.ts`
 *    (multi-turn feedback, tool error, stop decision, abort mid-turn) and at
 *    engine level by
 *    `packages/agent-runtime/test/engine-scenario-turn-behaviour.test.ts`.
 *    `packages/agent` is a facade scheduled for retirement (A7), so no new
 *    coverage is invested here; a real-provider smoke entry belongs to the
 *    A4 CLI/eval wiring slice, not to a skip badge on a dead API.
 *  - message / session / context state assertions → KEPT below. They never
 *    needed a provider; the API-key guard was pure noise and is gone.
 *
 * `streaming-lifecycle.test.ts` (7 dead calls, all duplicates or vacuous) and
 * `AgentLoop.test.ts` (2 dead calls) were deleted outright.
 */

import { describe, it, expect } from 'vitest';
import { duyaAgent } from '../../src/agent/DuyaAgent.js';

let sessionCounter = 0;
function makeAgent(): duyaAgent {
  sessionCounter += 1;
  return new duyaAgent({
    apiKey: 'test-key',
    model: 'claude-test',
    provider: 'anthropic',
    sessionId: `s-duya-agent-it-${sessionCounter}-${Math.random().toString(36).slice(2)}`,
    workingDirectory: process.cwd(),
    permissionMode: 'bypassPermissions',
  });
}

describe('duyaAgent state surface (no provider involved)', () => {
  it('clears messages', () => {
    const agent = makeAgent();
    agent.clearMessages();
    expect(agent.getMessages().length).toBe(0);
  });

  it('adds single messages', () => {
    const agent = makeAgent();
    agent.addMessage({
      role: 'user',
      content: 'Test message',
      timestamp: Date.now(),
    });
    expect(agent.getMessages().length).toBe(1);
    expect(agent.getMessages()[0].content).toBe('Test message');
  });

  it('reports session info', () => {
    const agent = makeAgent();
    const info = agent.getSessionInfo();
    expect(info).toHaveProperty('id');
    expect(info).toHaveProperty('createdAt');
    expect(info).toHaveProperty('updatedAt');
    expect(typeof info.messageCount).toBe('number');
  });

  it('reports context stats', () => {
    const agent = makeAgent();
    const stats = agent.getContextStats();
    expect(stats).toBeDefined();
    expect(typeof stats.totalTokens).toBe('number');
  });

  it('checks compaction need', () => {
    const agent = makeAgent();
    expect(typeof agent.shouldCompact()).toBe('boolean');
  });
});
