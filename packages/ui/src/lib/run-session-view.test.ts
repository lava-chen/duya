import { describe, expect, it } from 'vitest';
import type { RunSessionSnapshot } from '@duya/client-core';
import { mergeRunSessionRows, runSessionMessages } from './run-session-view';

describe('RunSession transcript view', () => {
  it('orders interleaved assistant and tool rows by real event sequence and removes only the same run', () => {
    const snapshot = {
      runId: 'run-current',
      sessionId: 'session-1',
      timeline: [
        { seq: 2, payload: { type: 'assistant.text_delta', messageId: 'message-1', index: 0, delta: 'thinking' } },
        { seq: 5, payload: { type: 'tool.call_started', toolCallId: 'tool-1', toolName: 'Read', arguments: { path: 'a' }, attempt: 1 } },
        { seq: 8, payload: { type: 'assistant.message_finalized', messageId: 'message-1', content: [], stopReason: 'end_turn' } },
        { seq: 11, payload: { type: 'tool.call_completed', toolCallId: 'tool-1', content: 'file contents', outcome: { outcome: 'success' }, durationMs: 10 } },
        { seq: 12, payload: { type: 'assistant.message_finalized', messageId: 'message-1', content: [], stopReason: 'end_turn' } },
      ],
      messages: [{ messageId: 'message-1', text: 'answer', thinking: '', finalized: true, stopReason: null, usage: null }],
      toolCalls: [{ toolCallId: 'tool-1', name: 'Read', phase: 'completed', phaseRevision: 2, provisionalArguments: null, arguments: { path: 'a' }, argumentText: '', attempt: 1, groupId: null, progress: null, outcome: { outcome: 'success' }, result: 'file contents', durationMs: 10, settled: true }],
    } as unknown as RunSessionSnapshot;

    const durable = [
      { id: 'old-run-row', runId: 'run-old', role: 'assistant' as const, content: 'older answer', timestamp: 1 },
      { id: 'current-user-row', runId: 'run-current', role: 'user' as const, content: 'question', timestamp: 2 },
      { id: 'current-run-row', runId: 'run-current', role: 'assistant' as const, content: 'answer', timestamp: 2 },
    ];
    const rows = mergeRunSessionRows(durable, snapshot);

    expect(rows.map((row) => row.id)).toEqual([
      'old-run-row',
      'current-user-row',
      'run:run-current:message-1',
      'run:run-current:tool-1',
      'run:run-current:tool-1:result',
    ]);
    expect(rows[3]?.tool_call_id).toBe('tool-1');
    expect(rows[4]?.tool_call_id).toBe(rows[3]?.tool_call_id);
    expect(runSessionMessages(snapshot).filter((row) => row.id.endsWith('message-1'))).toHaveLength(1);
    expect(rows.slice(2).every((row) => Number.isNaN(row.timestamp))).toBe(true);
  });
});
