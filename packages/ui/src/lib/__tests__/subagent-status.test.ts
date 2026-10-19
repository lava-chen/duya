import { describe, expect, it } from 'vitest';
import {
  deriveSubagentStatus,
  isTerminalSubagentStatus,
  normalizeSubagentStatus,
  type SubagentRunStatus,
} from '../subagent-status';

function ev(type: string, data?: string) {
  return data === undefined ? { type } : { type, data };
}

describe('normalizeSubagentStatus', () => {
  it('maps every legacy vocabulary onto the shared one', () => {
    // Pre-571 SubAgentRowInfo.status
    expect(normalizeSubagentStatus('waiting')).toBe('pending');
    expect(normalizeSubagentStatus('error')).toBe('failed');
    // Pre-571 ParsedSubAgentToolResult.status
    expect(normalizeSubagentStatus('failed')).toBe('failed');
    // agent-side TaskStatus
    expect(normalizeSubagentStatus('killed')).toBe('killed');
    expect(normalizeSubagentStatus('cancelled')).toBe('killed');
    expect(normalizeSubagentStatus('aborted')).toBe('killed');
  });

  it('treats a background launch receipt as running, not completed', () => {
    // ZCode's discriminated union uses `async_launched` for a backgrounded
    // spawn. The child is alive but has produced no result yet.
    expect(normalizeSubagentStatus('async_launched')).toBe('running');
  });

  it('returns undefined for values outside the known vocabularies', () => {
    expect(normalizeSubagentStatus('banana')).toBeUndefined();
    expect(normalizeSubagentStatus(undefined)).toBeUndefined();
    expect(normalizeSubagentStatus(42)).toBeUndefined();
  });
});

describe('deriveSubagentStatus', () => {
  it('reports pending for a sub-agent that has emitted nothing', () => {
    expect(deriveSubagentStatus([])).toBe('pending');
  });

  it('stays running after a background spawn receipt until a terminal event', () => {
    // This is the exact bug the shared vocabulary exists to make testable: the
    // launch receipt is a successful tool result that says nothing about the
    // child, so the row must not read it as completion.
    const events = [ev('started'), ev('tool_use'), ev('tool_result'), ev('text')];
    expect(deriveSubagentStatus(events)).toBe('running');
  });

  it('resolves completion and failure from the terminal event', () => {
    expect(deriveSubagentStatus([ev('started'), ev('done')])).toBe('completed');
    expect(deriveSubagentStatus([ev('started'), ev('error', 'boom')])).toBe('failed');
  });

  it('distinguishes a user kill from a failure', () => {
    // BackgroundAgentLifecycle records kills as an error whose data carries the
    // reason. Presenting that as "failed" is what made a cancelled sub-agent
    // look like a crash.
    expect(deriveSubagentStatus([ev('started'), ev('error', 'killed: user_kill')])).toBe('killed');
    expect(deriveSubagentStatus([ev('started'), ev('done', 'killed: parent_abort')])).toBe('killed');
  });

  it('lets the last terminal event win', () => {
    expect(deriveSubagentStatus([ev('done'), ev('text'), ev('error', 'killed: user_kill')])).toBe('killed');
  });

  it('ignores heartbeat as a liveness signal only, not as a terminal state', () => {
    expect(deriveSubagentStatus([ev('started'), ev('heartbeat')])).toBe('running');
  });

  it('skips unknown event types when looking for a terminal state', () => {
    expect(deriveSubagentStatus([ev('some_future_event'), ev('done')])).toBe('completed');
    expect(deriveSubagentStatus([ev('some_future_event')])).toBe('pending');
  });
});

describe('isTerminalSubagentStatus', () => {
  it('covers exactly the states the UI must stop animating', () => {
    const terminal: SubagentRunStatus[] = ['completed', 'failed', 'killed'];
    for (const status of terminal) {
      expect(isTerminalSubagentStatus(status)).toBe(true);
    }
    expect(isTerminalSubagentStatus('pending')).toBe(false);
    expect(isTerminalSubagentStatus('running')).toBe(false);
  });
});
