/**
 * T3.3 — text and thinking survive a dropped delta, and the cost is stated.
 *
 * The claim under test is narrow and load-bearing: a consumer that lost deltas
 * rebuilds the assistant's prose from the DURABLE BLOCKS, and what it cannot
 * have is named rather than implied. The negative cases matter as much as the
 * positive one — "all the text was replayed" is the sentence these tests exist to
 * make unsaid.
 */

import { describe, expect, it } from 'vitest';
import { buildTranscriptSnapshot, openBlock } from '../src/replay/transcript-snapshot.js';
import type { RunEventEnvelope } from '@duya/agent-protocol';

const RUN = 'run-1';

function at(seq: number, payload: RunEventEnvelope['payload']): RunEventEnvelope {
  return { runId: RUN, sessionId: 'sess-1', seq, timestamp: 1_000, traceId: `trace-${RUN}`, payload };
}

const textBlock = (seq: number, text: string, messageId = 'm1', index = 0) =>
  at(seq, { type: 'assistant.text_block', messageId, index, text });
const thinkingBlock = (seq: number, thinking: string, messageId = 'm1', index = 0) =>
  at(seq, { type: 'assistant.thinking_block', messageId, index, thinking });
const textDelta = (seq: number, delta: string, messageId = 'm1', index = 0) =>
  at(seq, { type: 'assistant.text_delta', messageId, index, delta });

describe('a consumer that lost its deltas rebuilds the text from the blocks', () => {
  it('recovers text and thinking from the durable block events alone', () => {
    // The durable subsequence only. Nothing here is a delta, and nothing here
    // needs to be.
    const snapshot = buildTranscriptSnapshot({
      runId: RUN,
      events: [thinkingBlock(2, 'let me think'), textBlock(4, 'the answer')],
    });

    expect(snapshot.messages).toHaveLength(1);
    expect(snapshot.messages[0]?.content).toEqual([
      { type: 'thinking', thinking: 'let me think' },
      { type: 'text', text: 'the answer' },
    ]);
    expect(snapshot.report.recoveredBlocks).toBe(2);
    expect(snapshot.report.openBlocks).toEqual([]);
  });

  it('reports the dropped deltas as NOT replayed, because they are not', () => {
    // A delta that was dropped is gone. The registry calls it ephemeral, and
    // nothing in this path invents it back.
    const snapshot = buildTranscriptSnapshot({
      runId: RUN,
      events: [textDelta(1, 'Hel'), textDelta(2, 'lo'), textBlock(3, 'Hello')],
    });

    expect(snapshot.report.deltasNotReplayed).toBe(2);
    expect(snapshot.messages[0]?.content).toEqual([{ type: 'text', text: 'Hello' }]);
  });

  it('says where the snapshot came from', () => {
    const fromStore = buildTranscriptSnapshot({ runId: RUN, events: [textBlock(1, 'x')] });
    expect(fromStore.source).toBe('durable_transcript');
  });
});

describe('a block that has not closed is reported open, not rendered empty', () => {
  it('an open block has NO text, because its text only ever existed as deltas', () => {
    // Mid-answer reconnect: block 0 landed, block 1 is still streaming. There is
    // nothing durable to render for it, so `text` is `null` rather than `''` —
    // `''` would tell the consumer the model finished there.
    const open = openBlock('m1', 1, 'text');
    expect(open.text).toBeNull();
    expect(open.open).toBe(true);
    // It names the message, the index and the kind, so a consumer can render
    // "still streaming" rather than nothing at all.
    expect(open).toEqual({ messageId: 'm1', index: 1, kind: 'text', text: null, open: true });
  });

  it('a snapshot of deltas alone recovers nothing and says so', () => {
    // A run whose only non-durable incrementals were seen reconstructs to
    // nothing. That is the honest answer, and it is why the recovery path is
    // documented as blocks-plus-cursor rather than "the deltas, replayed".
    const snapshot = buildTranscriptSnapshot({
      runId: RUN,
      events: [textDelta(1, 'Hel'), textDelta(2, 'lo')],
    });

    expect(snapshot.messages).toEqual([]);
    expect(snapshot.blocks).toEqual([]);
    expect(snapshot.report.recoveredBlocks).toBe(0);
    expect(snapshot.report.deltasNotReplayed).toBe(2);
  });

  it('counts a closed block as recovered and an open one as missing', () => {
    const snapshot = buildTranscriptSnapshot({
      runId: RUN,
      events: [textBlock(2, 'the finished part')],
    });

    expect(snapshot.report.recoveredBlocks).toBe(1);
    expect(snapshot.report.messages).toBe(1);
    expect(snapshot.report.openBlocks).toEqual([]);
  });
});

describe('the terminal alone is NOT the text, and is never claimed to be', () => {
  it('rebuilds nothing from a run whose only durable record is its terminal', () => {
    // This is the sentence T3.3 has to refuse to let anyone write: storing the
    // durable terminal is not replaying the run's text. A run that persisted only
    // `run.completed` rebuilds to an empty transcript.
    const snapshot = buildTranscriptSnapshot({
      runId: RUN,
      events: [
        at(1, {
          type: 'run.completed',
          status: 'completed',
        }),
      ],
    });

    expect(snapshot.messages).toEqual([]);
    expect(snapshot.blocks).toEqual([]);
    expect(snapshot.report.recoveredBlocks).toBe(0);
  });

  it('keeps the finalized message verbatim, in the vocabulary it arrived in', () => {
    // Not projected into a transcript `Message`: the payload's `ToolResult`
    // carries an explicit `outcome` the transcript's does not, and collapsing
    // them loses it. So both vocabularies are present and neither is a copy.
    const snapshot = buildTranscriptSnapshot({
      runId: RUN,
      events: [
        at(3, {
          type: 'assistant.message_finalized',
          messageId: 'm1',
          content: [
            { type: 'text', text: 'done', phase: 'final_answer' },
            { type: 'tool_result', toolCallId: 't1', content: 'ok', outcome: 'success' },
          ],
          stopReason: 'end_turn',
        }),
      ],
    });

    expect(snapshot.finalized).toHaveLength(1);
    expect(snapshot.finalized[0]?.messageId).toBe('m1');
    expect(snapshot.finalized[0]?.throughSeq).toBe(3);
    expect(snapshot.finalized[0]?.content[1]).toEqual({
      type: 'tool_result',
      toolCallId: 't1',
      content: 'ok',
      outcome: 'success',
    });
    // The block-derived transcript is separate, so a consumer can tell which
    // view it is looking at.
    expect(snapshot.messages).toEqual([]);
  });
});

describe('the rebuild orders by seq, not by arrival', () => {
  it('sorts a durable log delivered out of order', () => {
    const snapshot = buildTranscriptSnapshot({
      runId: RUN,
      events: [textBlock(9, 'second', 'm1', 1), textBlock(4, 'first', 'm1', 0)],
    });

    expect(snapshot.throughSeq).toBe(9);
    expect(snapshot.messages[0]?.content).toEqual([
      { type: 'text', text: 'first' },
      { type: 'text', text: 'second' },
    ]);
  });

  it('is empty for a run with no durable events at all', () => {
    const snapshot = buildTranscriptSnapshot({ runId: RUN, events: [] });
    expect(snapshot.throughSeq).toBe(0);
    expect(snapshot.messages).toEqual([]);
    expect(snapshot.report.deltasNotReplayed).toBe(0);
  });
});
