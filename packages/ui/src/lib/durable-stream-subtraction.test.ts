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

  it('cuts the prefix through the last durable tool_use, keeping the live tail', () => {
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

  it('cuts at the LAST durable tool_use, not the first', () => {
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

  it('cuts on durable tool_use even when durable tool_result is still missing (plan 447 race window)', () => {
    // Plan 441 Journal persists the assistant message (which carries the
    // tool_use block) before the matching tool_result row, and IPC writes
    // are fire-and-forget — there's a 3-5ms window where the DB has the
    // tool_use but not the tool_result. SSE already pushed both events to
    // `streamingEvents`. Cutting on tool_result (the old behaviour) would
    // fail in this window and re-render the entire SSE prefix, breaking
    // the group summary. Cutting on tool_use closes the window because
    // tool_use persistence always lands first.
    const events = [
      evThinking('round 1 thinking'),
      evText('round 1 text'),
      evToolUse('tu_1'),
      evToolResult('tu_1'),
      // live tail — round 2 in progress
      evToolUse('tu_2'),
      evThinking('round 2 thinking'),
    ];
    const out = subtractDurableStreamingEvents(events, {
      // toolUseIds already landed; toolResultIds still empty (race).
      toolUseIds: new Set(['tu_1']),
      toolResultIds: new Set(),
    });
    expect(out).toEqual([evToolUse('tu_2'), evThinking('round 2 thinking')]);
  });

  it('cuts on durable tool_use even when its durable result is missing (plan 447 race window)', () => {
    // Plan 441 Journal persists the assistant message (which carries the
    // tool_use block) before the matching tool_result row, and IPC writes
    // are fire-and-forget — there's a 3-5ms window where the DB has the
    // tool_use but not the tool_result. SSE already pushed both events to
    // `streamingEvents`. Cutting on tool_result (the old behaviour) would
    // fail in this window and re-render the entire SSE prefix, breaking
    // the group summary. Cutting on tool_use closes the window because
    // tool_use persistence always lands first; the `allDurableToolIds`
    // union then drops the still-in-SSE tool_result so it doesn't
    // re-render either.
    const events = [
      evThinking('round 1 thinking'),
      evText('round 1 text'),
      evToolUse('tu_1'),
      evToolResult('tu_1'),
      // live tail — round 2 in progress
      evToolUse('tu_2'),
      evThinking('round 2 thinking'),
    ];
    const out = subtractDurableStreamingEvents(events, {
      // toolUseIds already landed; toolResultIds still empty (race).
      toolUseIds: new Set(['tu_1']),
      toolResultIds: new Set(),
    });
    // The cut lands on tool_use tu_1; tool_result tu_1 is dropped by
    // the union-dedup pass; the round-2 tail is preserved.
    expect(out).toEqual([evToolUse('tu_2'), evThinking('round 2 thinking')]);
  });

  it('drops a stray tool_result whose id is durable via the toolUse union, without extending the cut', () => {
    // Defensive path: a durable tool_result whose matching tool_use is
    // NOT in SSE (legacy fixtures, attach-on-reconnect partial replay)
    // must be removed from the tail so the durable row is the single
    // source of truth. `allDurableToolIds` covers this because
    // toolResultIds alone would miss the case where the durable side
    // has the tool_use but the tool_result row hasn't landed yet
    // (inverse of the race above).
    const events = [
      evText('before'),
      evToolUse('tu_1'),
      evToolResult('tu_1'),
      evText('after'),
    ];
    const out = subtractDurableStreamingEvents(events, {
      toolUseIds: new Set(['tu_1']),
      toolResultIds: new Set(['tu_1']),
    });
    // cut lands on tool_use tu_1; the prefix (text before, tool_use,
    // tool_result) is dropped; the tail (text after) is kept.
    expect(out).toEqual([evText('after')]);
  });

  it('keeps everything when only an earlier non-matching result exists', () => {
    const events = [evToolUse('tu_live'), evToolResult('tu_live'), evText('working…')];
    const out = subtractDurableStreamingEvents(events, {
      toolUseIds: new Set(['tu_done']),
      toolResultIds: new Set(['tu_done']),
    });
    expect(out).toBe(events);
  });

  it('drops trailing text already finalized in the durable last-assistant message', () => {
    // Plan 447 known limitation: a finalized text-only assistant block has
    // no id to anchor a cut, so the trailing text events survived as
    // duplicates of the durable row. Now: when the trailing text exactly
    // matches the durable finalAssistantText, drop it.
    const finalText = '这是一个非常具体的目标。让我帮你拆解这四个方向各自需要验证什么、现状如何、以及接下来怎么做。';
    const events = [
      evToolUse('tu_1'),
      evToolResult('tu_1'),
      evText(finalText),
    ];
    const out = subtractDurableStreamingEvents(events, {
      toolUseIds: new Set(['tu_1']),
      toolResultIds: new Set(['tu_1']),
      finalAssistantText: finalText,
    });
    expect(out).toEqual([]);
  });

  it('keeps trailing text that is shorter than the durable final text', () => {
    // Stream is mid-flight: durable shows the FULL reply, stream only has
    // a prefix so far. Keep the streaming text so the live row keeps
    // typing; a future reload will catch up.
    const durableText = '完成拆分：第一阶段验证消息渲染。';
    const events = [
      evToolUse('tu_1'),
      evToolResult('tu_1'),
      evText('完成拆分：第一阶段'),
    ];
    const out = subtractDurableStreamingEvents(events, {
      toolUseIds: new Set(['tu_1']),
      toolResultIds: new Set(['tu_1']),
      finalAssistantText: durableText,
    });
    expect(out).toEqual([evText('完成拆分：第一阶段')]);
  });

  it('keeps trailing text that is longer than the durable final text (durability lag)', () => {
    // The durability layer hasn't replayed the assistant message yet.
    // Don't second-guess — preserve the streaming text as the live tail.
    const durableText = '旧版回答';
    const events = [
      evToolUse('tu_1'),
      evToolResult('tu_1'),
      evText('新版回答，比旧版多了一些内容'),
    ];
    const out = subtractDurableStreamingEvents(events, {
      toolUseIds: new Set(['tu_1']),
      toolResultIds: new Set(['tu_1']),
      finalAssistantText: durableText,
    });
    expect(out).toEqual([evText('新版回答，比旧版多了一些内容')]);
  });

  it('does not drop trailing text when durable has no assistant text', () => {
    // finalAssistantText === '' means we don't have a reliable snapshot of
    // the last assistant message's body — leave the live tail alone.
    const events = [
      evToolUse('tu_1'),
      evToolResult('tu_1'),
      evText('live typing…'),
    ];
    const out = subtractDurableStreamingEvents(events, {
      toolUseIds: new Set(['tu_1']),
      toolResultIds: new Set(['tu_1']),
      finalAssistantText: '',
    });
    expect(out).toEqual([evText('live typing…')]);
  });

  it('drops trailing text and keeps a live tool_use event after it', () => {
    // Round N finished and got persisted; round N+1 just started with a
    // new tool_use. The trailing text belongs to round N's durable row;
    // the tool_use is the new round's live tail.
    const finalText = '已管理 1 个任务';
    const events = [
      evToolUse('tu_1'),
      evToolResult('tu_1'),
      evText(finalText),
      evToolUse('tu_2'),
    ];
    const out = subtractDurableStreamingEvents(events, {
      toolUseIds: new Set(['tu_1']),
      toolResultIds: new Set(['tu_1']),
      finalAssistantText: finalText,
    });
    expect(out).toEqual([evToolUse('tu_2')]);
  });
});

describe('extractDurableToolIds: finalAssistantText', () => {
  it('returns "" when no assistant message exists', () => {
    const ids = extractDurableToolIds([
      { id: 'u1', role: 'user', content: 'hello', timestamp: 0 },
    ]);
    expect(ids.finalAssistantText).toBe('');
  });

  it('captures the last assistant text blocks joined by \\n\\n', () => {
    const ids = extractDurableToolIds([
      { id: 'u1', role: 'user', content: 'hi', timestamp: 0 },
      {
        id: 'a1',
        role: 'assistant',
        content: [
          { type: 'text', text: '第一段' },
          { type: 'text', text: '第二段' },
        ],
        timestamp: 0,
      },
    ]);
    expect(ids.finalAssistantText).toBe('第一段\n\n第二段');
  });

  it('only keeps the text from the LAST assistant message', () => {
    const ids = extractDurableToolIds([
      {
        id: 'a1',
        role: 'assistant',
        content: [{ type: 'text', text: '旧回答' }],
        timestamp: 0,
      },
      {
        id: 'a2',
        role: 'assistant',
        content: [{ type: 'text', text: '新回答' }],
        timestamp: 1,
      },
    ]);
    expect(ids.finalAssistantText).toBe('新回答');
  });

  it('counts persisted isCompactSummary messages', () => {
    const ids = extractDurableToolIds([
      { id: 'u1', role: 'user', content: 'hi', timestamp: 0 },
      {
        id: 'c1',
        role: 'assistant',
        isCompactSummary: true,
        compactedMessageCount: 3,
        content: 'summarized',
        timestamp: 1,
      },
      {
        id: 'c2',
        role: 'assistant',
        isCompactSummary: true,
        content: 'summarized again',
        timestamp: 2,
      },
    ]);
    expect(ids.compactedCount).toBe(2);
  });
});

describe('compact streaming events', () => {
  function evCompact(
    phase: 'compacting' | 'done' | 'error',
  ): StreamingEvent {
    return { type: 'compact', phase, timestamp: 0 } as StreamingEvent;
  }

  it('drops covered done/error compact events but keeps a live compacting one', () => {
    const events: StreamingEvent[] = [
      evText('text'),
      evCompact('compacting'),
      evCompact('done'),
      evCompact('error'),
      evText('more'),
    ];
    const out = subtractDurableStreamingEvents(events, {
      toolUseIds: new Set(),
      toolResultIds: new Set(),
      compactedCount: 2,
    });
    // No durable tool/text coverage, so only compact cleanup applies.
    const compactPhases = out
      .filter((e) => e.type === 'compact')
      .map((e) => (e as { phase: string }).phase);
    // first 'done' + first 'error' removed (up to compactedCount=2),
    // the trailing 'compacting' is saved.
    expect(compactPhases).toEqual(['compacting']);
    expect(out).toHaveLength(3);
  });

  it('returns events unchanged when compactedCount is omitted', () => {
    const events: StreamingEvent[] = [evCompact('done'), evText('x')];
    const out = subtractDurableStreamingEvents(events, {
      toolUseIds: new Set(),
      toolResultIds: new Set(),
    });
    expect(out).toBe(events);
  });
});
