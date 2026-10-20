/**
 * subagent-live-transcript.test.ts
 *
 * The projection is the load-bearing part of plan 571 Phase 2: the panel
 * renders whatever this pure function returns, from a wire format that carries
 * deltas, keepalives and unlinkable tool events. Every branch below is a
 * behaviour the panel depends on, so the cases are written to fail loudly if
 * the accumulation, pairing or merge rules regress.
 */

import { describe, expect, it } from 'vitest';
import {
  classifySubagentTool,
  computeSubagentToolUseCounts,
  mergeSubagentTranscriptHistory,
  projectSubagentLiveTranscript,
  type SubagentProgressEventLike,
} from '../subagent-live-transcript';
import type { Message } from '@/types';

let clock = 1_000;
function ev(
  type: string,
  extra: Partial<SubagentProgressEventLike> = {},
): SubagentProgressEventLike {
  clock += 1;
  return { type, receivedAt: clock, ...extra };
}

function textOf(messages: Message[], msgType: Message['msgType']): string[] {
  return messages.filter((m) => m.msgType === msgType).map((m) => String(m.content));
}

describe('projectSubagentLiveTranscript — text deltas', () => {
  it('concatenates consecutive text deltas into ONE accumulating block', () => {
    const result = projectSubagentLiveTranscript([
      ev('started'),
      ev('text', { data: 'Hel' }),
      ev('text', { data: 'lo, ' }),
      ev('text', { data: 'world' }),
    ]);

    expect(result.messages).toHaveLength(1);
    expect(result.messages[0].content).toBe('Hello, world');
    expect(result.messages[0].role).toBe('assistant');
    expect(result.messages[0].msgType).toBe('text');
  });

  it('starts a new text block after a tool_use interrupts, with the newline the agent adds', () => {
    const result = projectSubagentLiveTranscript([
      ev('text', { data: 'first' }),
      ev('tool_use', { toolName: 'read', toolInput: { file_path: 'a.ts' } }),
      ev('tool_result', { toolName: 'read', toolResult: 'ok' }),
      ev('text', { data: 'second' }),
    ]);

    const texts = textOf(result.messages, 'text');
    // Two blocks, and the second carries the leading '\n' DuyaAgent adds after
    // a tool boundary so `### heading` style markdown is not swallowed.
    expect(texts).toEqual(['first', '\nsecond']);
  });

  it('does NOT prefix the first block, and ignores empty deltas', () => {
    const result = projectSubagentLiveTranscript([
      ev('text', { data: '' }),
      ev('text', { data: 'only' }),
    ]);
    expect(result.messages).toHaveLength(1);
    expect(result.messages[0].content).toBe('only');
  });

  it('accumulates thinking deltas separately and closes the block on text', () => {
    const result = projectSubagentLiveTranscript([
      ev('thinking', { data: 'let me ' }),
      ev('thinking', { data: 'think' }),
      ev('text', { data: 'answer' }),
    ]);

    const thinking = result.messages.filter((m) => m.msgType === 'thinking');
    expect(thinking).toHaveLength(1);
    expect(thinking[0].thinking).toBe('let me think');
    // Thinking is not part of DuyaAgent's `assistantContent` (it accumulates in
    // its own buffer), so a text block that follows only thinking is still the
    // FIRST content block and gets no '\n' prefix — the mirror has to count
    // text/tool_use blocks only, not rendered nodes.
    expect(textOf(result.messages, 'text')).toEqual(['answer']);
  });
});

describe('projectSubagentLiveTranscript — keepalives and lifecycle', () => {
  it('excludes heartbeats from the body but counts them as activity', () => {
    const events = [
      ev('started'),
      ev('text', { data: 'hi' }),
      ev('heartbeat'),
      ev('heartbeat'),
    ];
    const result = projectSubagentLiveTranscript(events);

    expect(result.messages).toHaveLength(1);
    expect(String(result.messages[0].content)).not.toContain('heartbeat');
    expect(result.lastActivityAt).toBe(events[events.length - 1].receivedAt);
  });

  it('excludes started / hook_invoked / done from the body', () => {
    const result = projectSubagentLiveTranscript([
      ev('started'),
      ev('text', { data: 'body' }),
      ev('hook_invoked'),
      ev('done'),
    ]);
    expect(result.messages).toHaveLength(1);
    expect(result.messages[0].msgType).toBe('text');
  });

  it('reads a done event as completed and stamps terminalAt', () => {
    const events = [ev('started'), ev('text', { data: 'x' }), ev('done', { data: 'ok' })];
    const result = projectSubagentLiveTranscript(events);

    expect(result.status).toBe('completed');
    expect(result.terminalAt).toBe(events[2].receivedAt);
    expect(result.startedAt).toBe(events[0].receivedAt);
  });

  it('reads a killed done event as killed, not completed', () => {
    const result = projectSubagentLiveTranscript([
      ev('started'),
      ev('done', { data: 'killed: user_kill' }),
    ]);
    expect(result.status).toBe('killed');
    expect(result.terminalText).toBe('killed: user_kill');
  });

  it('reads a killed error event as killed, not failed', () => {
    const result = projectSubagentLiveTranscript([
      ev('started'),
      ev('error', { data: 'killed: user' }),
    ]);
    expect(result.status).toBe('killed');
  });

  it('reads a plain error event as failed and keeps its text', () => {
    const result = projectSubagentLiveTranscript([
      ev('started'),
      ev('error', { data: 'provider exploded' }),
    ]);
    expect(result.status).toBe('failed');
    expect(result.terminalText).toBe('provider exploded');
    // The failure is reported by the header, not injected into the transcript.
    expect(result.messages).toHaveLength(0);
  });

  it('reports pending for an empty log and running mid-flight', () => {
    expect(projectSubagentLiveTranscript([]).status).toBe('pending');
    expect(projectSubagentLiveTranscript([ev('started'), ev('text', { data: 'a' })]).status)
      .toBe('running');
  });
});

describe('projectSubagentLiveTranscript — tool pairing', () => {
  it('pairs tool_use with tool_result FIFO among the same tool name', () => {
    const result = projectSubagentLiveTranscript([
      ev('tool_use', { toolName: 'read', toolInput: { file_path: 'a' } }),
      ev('tool_use', { toolName: 'read', toolInput: { file_path: 'b' } }),
      ev('tool_result', { toolName: 'read', toolResult: 'A' }),
      ev('tool_result', { toolName: 'read', toolResult: 'B' }),
    ]);

    const uses = result.messages.filter((m) => m.msgType === 'tool_use');
    const results = result.messages.filter((m) => m.msgType === 'tool_result');
    expect(uses).toHaveLength(2);
    expect(results).toHaveLength(2);
    // FIFO: the first result belongs to the first call.
    expect(uses[0].tool_call_id).toBe(results[0].tool_call_id);
    expect(uses[1].tool_call_id).toBe(results[1].tool_call_id);
    expect(results[0].content).toBe('A');
    expect(results[1].content).toBe('B');
  });

  it('serializes toolInput as JSON, the shape the renderer tool rows parse', () => {
    const result = projectSubagentLiveTranscript([
      ev('tool_use', { toolName: 'bash', toolInput: { command: 'npm test' } }),
    ]);
    const use = result.messages[0];
    expect(typeof use.toolInput).toBe('string');
    expect(JSON.parse(use.toolInput as string)).toEqual({ command: 'npm test' });
  });

  it('falls back to the oldest pending call when the result name disagrees', () => {
    const result = projectSubagentLiveTranscript([
      ev('tool_use', { toolName: 'read', toolInput: { file_path: 'a' } }),
      ev('tool_use', { toolName: 'grep', toolInput: { query: 'b' } }),
      ev('tool_result', { toolName: 'search_files', toolResult: 'B' }),
    ]);

    const uses = result.messages.filter((m) => m.msgType === 'tool_use');
    const results = result.messages.filter((m) => m.msgType === 'tool_result');
    // The mismatched result binds to the OLDEST pending call, not to itself.
    expect(results[0].tool_call_id).toBe(uses[0].tool_call_id);
    expect(String(uses[0].toolName)).toBe('read');
  });

  it('renders an unmatched tool_result standalone instead of dropping it', () => {
    const result = projectSubagentLiveTranscript([
      ev('tool_result', { toolName: 'read', toolResult: 'orphaned output' }),
    ]);

    expect(result.messages).toHaveLength(1);
    expect(result.messages[0].role).toBe('tool');
    expect(result.messages[0].content).toBe('orphaned output');
    expect(result.messages[0].tool_call_id).toBeTruthy();
    // And it is still counted, so the totals do not silently under-report.
    expect(result.toolCounts.read).toBe(1);
    expect(result.toolCounts.total).toBe(1);
  });

  it('marks a still-running call as running and a <tool_error> result as error', () => {
    const running = projectSubagentLiveTranscript([ev('tool_use', { toolName: 'bash' })]);
    expect(running.messages[0].status).toBe('running');

    const failed = projectSubagentLiveTranscript([
      ev('tool_use', { toolName: 'bash' }),
      ev('tool_result', { toolName: 'bash', toolResult: '<tool_error>boom</tool_error>' }),
    ]);
    expect(failed.messages.find((m) => m.msgType === 'tool_use')?.status).toBe('error');
    expect(failed.messages.find((m) => m.msgType === 'tool_result')?.status).toBe('error');
  });

  it('uses event.data as the result text when toolResult is absent', () => {
    const result = projectSubagentLiveTranscript([
      ev('tool_use', { toolName: 'read' }),
      ev('tool_result', { toolName: 'read', data: 'from data' }),
    ]);
    const toolRow = result.messages.find((m) => m.msgType === 'tool_result');
    expect(toolRow?.content).toBe('from data');
  });
});

describe('computeSubagentToolUseCounts', () => {
  it('classifies every tool family', () => {
    expect(classifySubagentTool('read_file')).toBe('read');
    expect(classifySubagentTool('Edit')).toBe('edit');
    expect(classifySubagentTool('glob')).toBe('search');
    expect(classifySubagentTool('Bash')).toBe('shell');
    expect(classifySubagentTool('browser_navigate')).toBe('browser');
    expect(classifySubagentTool('something_else')).toBe('other');
    expect(classifySubagentTool(undefined)).toBe('other');
  });

  it('counts invocations, not completions, so an in-flight call is visible', () => {
    const counts = computeSubagentToolUseCounts([
      ev('tool_use', { toolName: 'read' }),
      ev('tool_use', { toolName: 'read' }),
      ev('tool_result', { toolName: 'read', toolResult: 'a' }),
    ]);
    expect(counts.read).toBe(2);
    expect(counts.total).toBe(2);
  });

  it('counts a paired result only through its invocation', () => {
    const counts = computeSubagentToolUseCounts([
      ev('tool_use', { toolName: 'bash' }),
      ev('tool_result', { toolName: 'bash', toolResult: 'ok' }),
    ]);
    expect(counts.shell).toBe(1);
    expect(counts.total).toBe(1);
  });

  it('returns zeroes for an empty log', () => {
    expect(computeSubagentToolUseCounts([])).toEqual({
      read: 0, edit: 0, search: 0, shell: 0, browser: 0, other: 0, total: 0,
    });
  });
});

describe('mergeSubagentTranscriptHistory', () => {
  const user = (id: string, at: number): Message => ({
    id, role: 'user', content: 'do the thing', msgType: 'text', timestamp: at,
  });
  const assistant = (id: string, at: number): Message => ({
    id, role: 'assistant', content: 'partial', msgType: 'text', timestamp: at,
  });

  it('returns the DB history untouched when there is no live tail', () => {
    const history = [user('u1', 10), assistant('a1', 20)];
    expect(mergeSubagentTranscriptHistory({ history, live: [], liveStartedAt: 5 }))
      .toHaveLength(2);
  });

  it('keeps the prompt but drops the DB rows the live tail already contains', () => {
    const history = [user('u1', 1_000), assistant('persisted-run', 1_500)];
    const live = [assistant('live-1', 1_100), assistant('live-2', 1_200)];

    const merged = mergeSubagentTranscriptHistory({ history, live, liveStartedAt: 1_100 });

    // The prompt survives (the event channel never carries it) and the
    // already-persisted assistant row does not duplicate the live tail.
    expect(merged.map((m) => m.id)).toEqual(['u1', 'live-1', 'live-2']);
  });

  it('keeps genuine earlier history ahead of the tail', () => {
    const history = [assistant('older-run', 500), user('prompt', 900)];
    const live = [assistant('live-1', 1_100)];

    const merged = mergeSubagentTranscriptHistory({ history, live, liveStartedAt: 1_000 });
    expect(merged.map((m) => m.id)).toEqual(['older-run', 'prompt', 'live-1']);
  });

  it('treats the boundary as inclusive so a row stamped exactly at the first event is dropped', () => {
    const history = [assistant('boundary', 1_000)];
    const merged = mergeSubagentTranscriptHistory({
      history,
      live: [assistant('live-1', 1_000)],
      liveStartedAt: 1_000,
    });
    expect(merged.map((m) => m.id)).toEqual(['live-1']);
  });

  it('keeps everything when the live start is unknown rather than dropping blindly', () => {
    const history = [assistant('a1', 10)];
    const merged = mergeSubagentTranscriptHistory({
      history,
      live: [assistant('live-1', 20)],
      liveStartedAt: null,
    });
    expect(merged.map((m) => m.id)).toEqual(['a1', 'live-1']);
  });

  it('never mutates its inputs', () => {
    const history = [user('u1', 1)];
    const live = [assistant('live-1', 2)];
    mergeSubagentTranscriptHistory({ history, live, liveStartedAt: 1 });
    expect(history).toHaveLength(1);
    expect(live).toHaveLength(1);
  });
});
