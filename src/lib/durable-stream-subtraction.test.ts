import { describe, expect, it } from 'vitest';
import {
  extractDurableToolIds,
  subtractDurableStreamingEvents,
} from './durable-stream-subtraction';
import type { StreamingEvent } from './stream-session-manager';
import type { Message } from '@/types';

function evText(content: string): StreamingEvent {
  return { type: 'text', content, timestamp: 0 };
}

function evThinking(content: string): StreamingEvent {
  return { type: 'thinking', content, timestamp: 0 };
}

function evToolUse(id: string): StreamingEvent {
  return { type: 'tool_use', toolUse: { id, name: 'Read', input: {} }, timestamp: 0 };
}

function evToolResult(toolUseId: string): StreamingEvent {
  return {
    type: 'tool_result',
    toolResult: { tool_use_id: toolUseId, content: 'ok', is_error: false },
    timestamp: 0,
  };
}

describe('extractDurableToolIds', () => {
  it('collects tool_use ids from assistant content blocks', () => {
    const messages: Message[] = [
      { id: 'u1', role: 'user', content: 'hi', timestamp: 0 },
      {
        id: 'a1',
        role: 'assistant',
        content: [
          { type: 'text', text: 'let me look' },
          { type: 'tool_use', id: 'tu_1', name: 'Read', input: {} },
        ],
        timestamp: 0,
      },
    ];
    const ids = extractDurableToolIds(messages);
    expect(ids.toolUseIds).toEqual(new Set(['tu_1']));
    expect(ids.toolResultIds.size).toBe(0);
  });

  it('collects tool_call ids from tool rows via parentToolCallId or tool_call_id', () => {
    const messages: Message[] = [
      { id: 't1', role: 'tool', content: 'ok', parentToolCallId: 'tu_1', timestamp: 0 } as Message,
      { id: 't2', role: 'tool', content: 'ok', tool_call_id: 'tu_2', timestamp: 0 } as Message,
      { id: 't3', role: 'tool', content: 'orphan', timestamp: 0 } as Message,
    ];
    const ids = extractDurableToolIds(messages);
    expect(ids.toolResultIds).toEqual(new Set(['tu_1', 'tu_2']));
  });

  it('ignores non-array and user/system content', () => {
    const messages: Message[] = [
      { id: 'u1', role: 'user', content: 'plain', timestamp: 0 },
      { id: 'a1', role: 'assistant', content: 'plain text', timestamp: 0 },
      {
        id: 'a2',
        role: 'assistant',
        content: [{ type: 'text', text: 'no tools here' }],
        timestamp: 0,
      },
    ];
    const ids = extractDurableToolIds(messages);
    expect(ids.toolUseIds.size).toBe(0);
    expect(ids.toolResultIds.size).toBe(0);
  });
});

describe('subtractDurableStreamingEvents', () => {
  it('returns the same events when durable sets are empty', () => {
    const events = [evThinking('hmm'), evText('hello')];
    const out = subtractDurableStreamingEvents(events, {
      toolUseIds: new Set(),
      toolResultIds: new Set(),
    });
    expect(out).toBe(events);
  });

  it('returns the same events when nothing is covered (live tail only)', () => {
    const events = [evThinking('hmm'), evText('hello'), evToolUse('tu_new')];
    const out = subtractDurableStreamingEvents(events, {
      toolUseIds: new Set(['tu_old']),
      toolResultIds: new Set(['tu_old']),
    });
    expect(out).toBe(events);
  });

  it('cuts the prefix through the last durable tool_result, keeping the live tail', () => {
    const events = [
      evThinking('round 1 thinking'),
      evText('round 1 text'),
      evToolUse('tu_1'),
      evToolResult('tu_1'),
      // live tail — round 2 in progress
      evThinking('round 2 thinking'),
      evText('partial answer'),
    ];
    const out = subtractDurableStreamingEvents(events, {
      toolUseIds: new Set(['tu_1']),
      toolResultIds: new Set(['tu_1']),
    });
    expect(out).toEqual([evThinking('round 2 thinking'), evText('partial answer')]);
  });

  it('cuts at the LAST durable tool_result, not the first', () => {
    const events = [
      evToolUse('tu_1'),
      evToolResult('tu_1'),
      evToolUse('tu_2'),
      evToolResult('tu_2'),
      evText('final streaming text'),
    ];
    const out = subtractDurableStreamingEvents(events, {
      toolUseIds: new Set(['tu_1', 'tu_2']),
      toolResultIds: new Set(['tu_1', 'tu_2']),
    });
    expect(out).toEqual([evText('final streaming text')]);
  });

  it('drops stray durable tool_use events without cutting the text tail', () => {
    // Defensive path: a durable tool_use with no durable result must not
    // anchor a cut, but still gets removed from the timeline.
    const events = [
      evText('before'),
      evToolUse('tu_1'),
      evText('after'),
    ];
    const out = subtractDurableStreamingEvents(events, {
      toolUseIds: new Set(['tu_1']),
      toolResultIds: new Set(),
    });
    expect(out).toEqual([evText('before'), evText('after')]);
  });

  it('keeps everything when only an earlier non-matching result exists', () => {
    const events = [evToolUse('tu_live'), evToolResult('tu_live'), evText('working…')];
    const out = subtractDurableStreamingEvents(events, {
      toolUseIds: new Set(['tu_done']),
      toolResultIds: new Set(['tu_done']),
    });
    expect(out).toBe(events);
  });
});
