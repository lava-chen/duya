// Plan 571: the structured `task` tool result contract.
//
// The parser must accept the new discriminated payload AND the legacy field
// names, because session history recorded before this change is still on disk
// and must keep rendering.

import { describe, expect, it } from 'vitest';
import { isSubagentResultTerminal, parseSubAgentToolResult } from '../subagent-result';

describe('parseSubAgentToolResult', () => {
  it('returns null for absent or unparseable results', () => {
    expect(parseSubAgentToolResult(null)).toBeNull();
    expect(parseSubAgentToolResult(undefined)).toBeNull();
    expect(parseSubAgentToolResult('')).toBeNull();
    expect(parseSubAgentToolResult('not json')).toBeNull();
    expect(parseSubAgentToolResult('[1,2,3]')).toBeNull();
    expect(parseSubAgentToolResult('"a string"')).toBeNull();
  });

  it('parses a background launch receipt', () => {
    const parsed = parseSubAgentToolResult(JSON.stringify({
      status: 'running',
      agentType: 'general-purpose',
      resolvedAgentType: 'general-purpose',
      description: 'scan the repo',
      content: 'Subagent started in background.',
      sessionId: 'child-1',
      agentId: 'task-1',
      taskId: 'task-1',
      background: true,
      outputFilePath: '/tmp/duya-agents/parent-1/task-1.jsonl',
    }));

    expect(parsed).toMatchObject({
      status: 'running',
      sessionId: 'child-1',
      taskId: 'task-1',
      background: true,
      outputFilePath: '/tmp/duya-agents/parent-1/task-1.jsonl',
    });
    // A launch receipt is not a completion — the panel must keep animating.
    expect(isSubagentResultTerminal(parsed)).toBe(false);
  });

  it('exposes the transcript path and usage that the backend already returned', () => {
    // Regression guard: `outputFilePath` used to be hardcoded to undefined in
    // the UI even though the tool result always carried it.
    const parsed = parseSubAgentToolResult(JSON.stringify({
      status: 'completed',
      sessionId: 'child-1',
      outputFilePath: '/tmp/out.jsonl',
      totalToolUseCount: 12,
      totalDurationMs: 5400,
      totalTokens: 3210,
      usage: {
        input_tokens: 100,
        output_tokens: 50,
        cache_read_input_tokens: 900,
      },
    }));

    expect(parsed?.outputFilePath).toBe('/tmp/out.jsonl');
    expect(parsed?.totalToolUseCount).toBe(12);
    expect(parsed?.totalDurationMs).toBe(5400);
    expect(parsed?.totalTokens).toBe(3210);
    expect(parsed?.usage).toEqual({
      input_tokens: 100,
      output_tokens: 50,
      cache_read_input_tokens: 900,
    });
    expect(isSubagentResultTerminal(parsed)).toBe(true);
  });

  it('treats a kill as a first-class terminal state', () => {
    const parsed = parseSubAgentToolResult(JSON.stringify({ status: 'killed', sessionId: 'child-1' }));
    expect(parsed?.status).toBe('killed');
    expect(isSubagentResultTerminal(parsed)).toBe(true);
  });

  it('accepts the legacy field names from pre-571 history', () => {
    const parsed = parseSubAgentToolResult(JSON.stringify({
      status: 'completed',
      childSessionId: 'legacy-child',
      backgroundTaskId: 'legacy-task',
      isAsync: true,
      outputFile: '/tmp/legacy.jsonl',
    }));

    expect(parsed?.sessionId).toBe('legacy-child');
    expect(parsed?.taskId).toBe('legacy-task');
    expect(parsed?.background).toBe(true);
    expect(parsed?.outputFilePath).toBe('/tmp/legacy.jsonl');
  });

  it('reports worktree isolation and warnings', () => {
    const parsed = parseSubAgentToolResult(JSON.stringify({
      status: 'completed',
      sessionId: 'child-1',
      isolation: 'worktree',
      workingDirectory: '/repo/.duya/worktrees/task-1',
      warnings: ['resumed from an unknown id; started a fresh run', ''],
    }));

    expect(parsed?.isolation).toBe('worktree');
    expect(parsed?.workingDirectory).toBe('/repo/.duya/worktrees/task-1');
    // Empty strings are dropped rather than rendered as blank warning rows.
    expect(parsed?.warnings).toEqual(['resumed from an unknown id; started a fresh run']);
  });

  it('ignores non-numeric counters instead of coercing them', () => {
    const parsed = parseSubAgentToolResult(JSON.stringify({
      status: 'completed',
      totalTokens: 'lots',
      totalToolUseCount: null,
    }));

    expect(parsed?.totalTokens).toBeUndefined();
    expect(parsed?.totalToolUseCount).toBeUndefined();
  });
});
