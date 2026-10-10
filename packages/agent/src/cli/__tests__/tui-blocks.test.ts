import { describe, it, expect, beforeEach } from 'vitest';
import { TranscriptModel, resetBlockIds, type ToolBlock, type LegacyFrame } from '../ui/blocks.js';

/**
 * These tests pin the two claims the block model exists to make:
 *
 * 1. A `text` frame REPLAYS what `text_delta` frames already delivered, and
 *    appending both prints every answer twice.
 * 2. A running tool line and its finalized line are the same object.
 *
 * Both were measured against the real producer rather than assumed: the engine
 * publishes `assistant.text_delta` inside the model loop
 * (`engine/run-engine.ts:1266`) and republishes the accumulated block as
 * `assistant.text_block` after it (`run-engine.ts:1355`).
 */
describe('TranscriptModel', () => {
  beforeEach(() => resetBlockIds());

  it('does not double-count a block frame that replays its own deltas', () => {
    const m = new TranscriptModel();
    m.apply({ type: 'text_delta', data: { content: 'Hello' } });
    m.apply({ type: 'text_delta', data: { content: ' world' } });
    m.apply({ type: 'text_delta', data: { content: '!' } });
    m.apply({ type: 'text', data: { content: 'Hello world!' } });

    expect(m.blocks).toHaveLength(1);
    expect(m.blocks[0]?.text).toBe('Hello world!');
  });

  it('treats the block frame as authoritative when it disagrees with the deltas', () => {
    const m = new TranscriptModel();
    m.apply({ type: 'text_delta', data: { content: 'par' } });
    m.apply({ type: 'text', data: { content: 'partial answer' } });
    expect(m.blocks[0]?.text).toBe('partial answer');
  });

  it('reads text from a bare string payload as well as {content}', () => {
    const m = new TranscriptModel();
    m.apply({ type: 'text_delta', data: 'bare' });
    expect(m.blocks[0]?.text).toBe('bare');
  });

  it('does not double-count thinking either', () => {
    const m = new TranscriptModel();
    m.apply({ type: 'thinking_delta', data: { content: 'pon' } });
    m.apply({ type: 'thinking_delta', data: { content: 'dering' } });
    m.apply({ type: 'thinking', data: { content: 'pondering' } });

    const thinking = m.blocks.filter((b) => b.kind === 'thinking');
    expect(thinking).toHaveLength(1);
    expect(thinking[0]?.text).toBe('pondering');
    expect((thinking[0] as { finalized: boolean }).finalized).toBe(true);
  });

  it('keeps a running tool line and its finalized line as ONE object', () => {
    const m = new TranscriptModel();
    const started = m.apply({
      type: 'tool_use_started',
      data: { id: 'call-1', name: 'Read', input: { path: 'a.ts' } },
    });
    expect(started.kind).toBe('append');

    const running = m.blocks[0] as ToolBlock;
    expect(running.status).toBe('running');

    const done = m.apply({
      type: 'tool_result',
      data: { id: 'call-1', result: 'file body', error: false },
    });
    expect(done.kind).toBe('mutate');

    // IDENTITY, not equality: a rebuilt block would be a full-line rewrite on
    // every token of the tool's own output.
    const finalized = m.blocks[0] as ToolBlock;
    expect(finalized).toBe(running);
    expect(m.blocks).toHaveLength(1);
    expect(finalized.status).toBe('ok');
    expect(finalized.result).toBe('file body');
  });

  it('folds the authoritative tool_use into the block the announcement made', () => {
    const m = new TranscriptModel();
    // `terminal` is the tool name the REPL's own preview table keys on.
    m.apply({ type: 'tool_use_started', data: { id: 'c', name: 'terminal', input: {} } });
    const first = m.blocks[0];
    m.apply({ type: 'tool_use', data: { id: 'c', name: 'terminal', input: { command: 'ls' } } });

    expect(m.blocks).toHaveLength(1);
    expect(m.blocks[0]).toBe(first);
    expect((m.blocks[0] as ToolBlock).preview).toBe('ls');
  });

  it('marks a failed tool as an error in place', () => {
    const m = new TranscriptModel();
    m.apply({ type: 'tool_use', data: { id: 'c', name: 'Bash', input: { command: 'x' } } });
    m.apply({ type: 'tool_result', data: { id: 'c', result: 'boom', error: true } });
    expect((m.blocks[0] as ToolBlock).status).toBe('error');
  });

  it('does not invent an error for an omitted error flag', () => {
    const m = new TranscriptModel();
    m.apply({ type: 'tool_use', data: { id: 'c', name: 'Bash', input: {} } });
    // The projector OMITS `error` when the outcome is indeterminate. Reading
    // a missing key as "failed" would report a tool nobody said failed.
    m.apply({ type: 'tool_result', data: { id: 'c', result: 'ok-ish' } });
    expect((m.blocks[0] as ToolBlock).status).toBe('ok');
  });

  it('creates a block for a result whose announcement never arrived', () => {
    const m = new TranscriptModel();
    m.apply({ type: 'tool_result', data: { id: 'orphan', name: 'Read', result: 'r' } });
    expect(m.blocks).toHaveLength(1);
    expect((m.blocks[0] as ToolBlock).status).toBe('ok');
  });

  it('routes a permission frame to the overlay, not the transcript', () => {
    const m = new TranscriptModel();
    const r = m.apply({
      type: 'permission',
      data: { requestId: 'p1', toolName: 'Bash', toolInput: { command: 'rm' }, reason: 'destructive' },
    });
    expect(r.kind).toBe('permission');
    // A question must not be a transcript line.
    expect(m.blocks).toHaveLength(0);
  });

  it('reports progress ticks as nothing visible', () => {
    const m = new TranscriptModel();
    for (const type of [
      'tool_progress',
      'tool_group_progress',
      'turn_start',
      'retry',
      'mode_changed',
      'goal_updated',
      'agent_progress',
      'done',
      'compact:step',
    ] as const) {
      const frame: LegacyFrame = { type, data: { anything: 1 } };
      expect(m.apply(frame).kind, `${type} must not cost a render`).toBe('none');
    }
    expect(m.blocks).toHaveLength(0);
  });

  it('reads the message off an error frame rather than the object', () => {
    const m = new TranscriptModel();
    m.apply({ type: 'error', data: { message: 'provider exploded', code: 'E1' } });
    const block = m.blocks[0];
    expect(block.kind).toBe('error');
    expect((block as { message: string }).message).toBe('provider exploded');
    expect(JSON.stringify(m.blocks)).not.toContain('[object Object]');
  });

  it('starts a new assistant block after a new user turn', () => {
    const m = new TranscriptModel();
    m.addUser('first question');
    m.apply({ type: 'text_delta', data: { content: 'first' } });
    const first = m.blocks.filter((b) => b.kind === 'assistant')[0];

    m.addUser('second question');
    m.apply({ type: 'text_delta', data: { content: 'answer' } });

    const assistant = m.blocks.filter((b) => b.kind === 'assistant');
    expect(assistant).toHaveLength(2);
    expect(assistant[0]).toBe(first);
  });

  it('clear() empties the transcript and the tool index', () => {
    const m = new TranscriptModel();
    m.apply({ type: 'tool_use', data: { id: 'c', name: 'Read', input: {} } });
    m.clear();
    expect(m.blocks).toHaveLength(0);
    // A result after a clear must not resurrect the old block.
    m.apply({ type: 'tool_result', data: { id: 'c', result: 'late' } });
    expect(m.blocks).toHaveLength(1);
  });

  it('ignores an unknown frame type instead of throwing', () => {
    const m = new TranscriptModel();
    expect(m.apply({ type: 'some_future_frame', data: {} }).kind).toBe('none');
  });
});
