import { describe, expect, it } from 'vitest';
import type { AgentProgressEventWithMeta } from './useStreamingAgentProgress';
import { getSubAgentStatus } from './useSubAgentProgress';

function event(type: AgentProgressEventWithMeta['type']): AgentProgressEventWithMeta {
  return {
    type,
    agentId: 'agent-1',
    receivedAt: 1,
    seq: 1,
  };
}

describe('getSubAgentStatus', () => {
  it('keeps a launched background agent running until its own terminal event arrives', () => {
    expect(getSubAgentStatus([event('started')])).toBe('running');
    expect(getSubAgentStatus([event('started'), event('thinking')])).toBe('running');
  });

  it('uses explicit terminal progress events for completion and failure', () => {
    expect(getSubAgentStatus([event('started'), event('done')])).toBe('completed');
    expect(getSubAgentStatus([event('started'), event('error')])).toBe('error');
  });
});
