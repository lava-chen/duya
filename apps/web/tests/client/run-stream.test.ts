/**
 * Transport tests for the live run subscription.
 *
 * Every case here drives a real `RunSession` through the real framing code.
 * The subject is the composition — BFF frames, resume cursor, window admission,
 * and the shared surface — because that is where the failure modes live. A
 * mocked surface would only prove the mock agrees with itself.
 */

import { describe, expect, it } from 'vitest';
import { RunEventStream, type RejectedFrameDetail, type RunStreamState } from '../../src/client/run-stream.js';
import {
  createStreamFetch,
  frame,
  frameFor,
  messageFinalized,
  messageFinalized as finalize,
  resetClock,
  runCompleted,
  runStarted,
  RUN_ID,
  SESSION_ID,
  settle,
  textDelta,
  toolCompleted,
  toolStarted,
  turnCompleted,
  turnStarted,
  waitFor,
} from './fixtures.js';
import type { RunId, SessionId } from '@duya/agent-protocol';

interface Harness {
  readonly stream: RunEventStream;
  readonly requests: { url: string; signal: AbortSignal | undefined }[];
  readonly pushes: ReadonlyArray<{ push(text: string): void; close(): void }>;
  readonly rejected: RejectedFrameDetail[];
  readonly states: RunStreamState[];
}

function harness(signal: AbortSignal, options: { stallTimeoutMs?: number } = {}): Harness {
  resetClock();
  const { fetchImpl, requests, streams } = createStreamFetch();
  const rejected: RejectedFrameDetail[] = [];
  const states: RunStreamState[] = [];
  const stream = new RunEventStream({
    runId: RUN_ID,
    sessionId: SESSION_ID,
    streamUrl: (runId, afterSeq) => `/api/runs/${runId}/events?afterSeq=${afterSeq}`,
    fetchImpl,
    signal,
    reconnectDelayMs: 5,
    stallTimeoutMs: options.stallTimeoutMs ?? 0,
    onRejected: (detail) => rejected.push(detail),
    onState: (state) => states.push(state),
  });
  return { stream, requests, pushes: streams, rejected, states };
}

describe('RunEventStream', () => {
  it('reconnects after its internal stall watchdog aborts the attempt', async () => {
    const scope = new AbortController();
    const { stream, requests, states } = harness(scope.signal, { stallTimeoutMs: 10 });
    stream.start();
    await waitFor(() => requests.length === 2);

    expect(states.some((state) => state.phase === 'reconnecting' && state.transportError === 'event_stream_stalled')).toBe(true);
    expect(requests[1]?.url).toBe(`/api/runs/${RUN_ID}/events?afterSeq=0`);

    stream.stop();
    await stream.settled();
  });

  it('replays a run from zero into a fresh surface', async () => {
    const scope = new AbortController();
    const { stream, requests, pushes } = harness(scope.signal);
    stream.start();
    await waitFor(() => requests.length === 1);

    expect(requests[0]?.url).toBe(`/api/runs/${RUN_ID}/events?afterSeq=0`);
    pushes[0]?.push([
      frameFor(runStarted(1)),
      frameFor(turnStarted(2)),
      frameFor(textDelta(3, 'msg-1', '你好')),
      frameFor(textDelta(4, 'msg-1', '，世界')),
      frameFor(finalize(5, 'msg-1', '你好，世界')),
      frameFor(toolStarted(6)),
      frameFor(toolCompleted(7)),
      frameFor(turnCompleted(8)),
      frameFor(runCompleted(9)),
    ].join(''));
    await waitFor(() => stream.getSnapshot().lastAcceptedSeq === 9);

    const snapshot = stream.getSnapshot();
    expect(snapshot.run.status).toBe('completed');
    expect(snapshot.run.runId).toBe(RUN_ID);
    expect(snapshot.turns).toHaveLength(1);
    expect(snapshot.turns[0]?.phase).toBe('completed');
    // The finalized message REPLACES the streamed text; appending both would
    // print the answer twice.
    expect(snapshot.messages).toHaveLength(1);
    expect(snapshot.messages[0]?.text).toBe('你好，世界');
    expect(snapshot.messages[0]?.finalized).toBe(true);
    expect(snapshot.toolCalls).toHaveLength(1);
    expect(snapshot.toolCalls[0]?.phase).toBe('completed');
    expect(snapshot.toolCalls[0]?.settled).toBe(true);

    stream.stop();
    await stream.settled();
  });

  it('resumes from the last accepted sequence after a dropped connection', async () => {
    const scope = new AbortController();
    const { stream, requests, pushes } = harness(scope.signal);
    stream.start();
    await waitFor(() => requests.length === 1);

    pushes[0]?.push([frameFor(runStarted(1)), frameFor(textDelta(2, 'msg-1', '一'))].join(''));
    await waitFor(() => stream.getSnapshot().lastAcceptedSeq === 2);
    pushes[0]?.close();

    await waitFor(() => requests.length === 2);
    // The cursor is the highest seq the SURFACE admitted, not the last frame the
    // socket happened to deliver.
    expect(requests[1]?.url).toBe(`/api/runs/${RUN_ID}/events?afterSeq=2`);

    pushes[1]?.push(frameFor(textDelta(3, 'msg-1', '二')));
    await waitFor(() => stream.getSnapshot().lastAcceptedSeq === 3);
    expect(stream.getSnapshot().messages[0]?.text).toBe('一二');

    stream.stop();
    await stream.settled();
  });

  it('admits a sparse sequence and re-delivered events without duplicating state', async () => {
    const scope = new AbortController();
    const { stream, requests, pushes } = harness(scope.signal);
    stream.start();
    await waitFor(() => requests.length === 1);

    // Ephemeral events are dropped by the Host, so 2 never existed and 4 arrives
    // before 3 on the reconnect.
    pushes[0]?.push([frameFor(runStarted(1)), frameFor(textDelta(4, 'msg-1', '四'))].join(''));
    await waitFor(() => stream.getSnapshot().lastAcceptedSeq === 4);
    pushes[0]?.close();
    await waitFor(() => requests.length === 2);

    // The Host re-sends 4 and then delivers the late 3.
    pushes[1]?.push([frameFor(textDelta(4, 'msg-1', '四')), frameFor(textDelta(3, 'msg-1', '三'))].join(''));
    await waitFor(() => stream.getSnapshot().lastAcceptedSeq === 4);
    await settle();

    expect(stream.getSnapshot().messages[0]?.text).toBe('三四');
    expect(stream.getSnapshot().timeline.filter((item) => item.seq === 4)).toHaveLength(1);

    stream.stop();
    await stream.settled();
  });

  it('refuses envelopes that belong to another run or session', async () => {
    const scope = new AbortController();
    const { stream, requests, pushes, rejected } = harness(scope.signal);
    stream.start();
    await waitFor(() => requests.length === 1);

    pushes[0]?.push([
      frameFor(runStarted(1)),
      frame(2, {
        runId: 'run-somebody-else',
        sessionId: SESSION_ID,
        seq: 2,
        timestamp: 1_700_000_000_000,
        traceId: 't',
        payload: { type: 'assistant.text_delta', messageId: 'msg-x', index: 0, delta: '外来' },
      }),
      frame(3, {
        runId: RUN_ID,
        sessionId: 'session-somebody-else',
        seq: 3,
        timestamp: 1_700_000_000_000,
        traceId: 't',
        payload: { type: 'assistant.text_delta', messageId: 'msg-y', index: 0, delta: '外来' },
      }),
      frameFor(textDelta(4, 'msg-1', '本轮')),
    ].join(''));
    await waitFor(() => stream.getSnapshot().lastAcceptedSeq === 4);
    await settle();

    const snapshot = stream.getSnapshot();
    // Neither foreign envelope advanced the cursor or left text behind.
    expect(snapshot.lastAcceptedSeq).toBe(4);
    expect(snapshot.messages.map((message) => message.messageId)).toEqual(['msg-1']);
    expect(snapshot.messages[0]?.text).toBe('本轮');
    expect(rejected.map((detail) => detail.reason)).toContain('wrong_run');
    expect(rejected.map((detail) => detail.reason)).toContain('wrong_session');

    stream.stop();
    await stream.settled();
  });

  it('ignores unreadable frames and keeps the cursor honest', async () => {
    const scope = new AbortController();
    const { stream, requests, pushes, rejected } = harness(scope.signal);
    stream.start();
    await waitFor(() => requests.length === 1);

    pushes[0]?.push([
      'event: legacy\ndata: {"seq":2}\n\n',
      'id: 2\nevent: run\ndata: {broken\n\n',
      'id: 2\nevent: run\ndata: {"runId":"run-x","sessionId":"s","seq":0,"timestamp":1,"traceId":"t","payload":{"type":"assistant.status"}}\n\n',
      frameFor(runStarted(1)),
      frameFor(textDelta(2, 'msg-1', '正常')),
    ].join(''));
    await waitFor(() => stream.getSnapshot().lastAcceptedSeq === 2);
    await settle();

    expect(stream.getSnapshot().messages[0]?.text).toBe('正常');
    // A sequence below 1 is caught by the transport before the surface is asked,
    // so it is reported as a malformed envelope rather than as a bad sequence.
    expect(rejected.map((detail) => detail.reason).sort()).toEqual([
      'malformed_envelope',
      'malformed_json',
      'unknown_event',
    ]);

    stream.stop();
    await stream.settled();
  });

  it('reports the BFF stream failure frame instead of treating it as an event', async () => {
    const scope = new AbortController();
    const { stream, requests, pushes } = harness(scope.signal);
    stream.start();
    await waitFor(() => requests.length === 1);

    pushes[0]?.push([
      frameFor(runStarted(1)),
      'event: error\ndata: {"status":502,"code":"upstream_unavailable"}\n\n',
    ].join(''));
    await waitFor(() => stream.state.hostError !== null);
    await settle();

    // The failure is surfaced as a fact about the stream, and the run that
    // already started is untouched by it.
    expect(stream.state.hostError).toBe('upstream_unavailable');
    expect(stream.getSnapshot().run.status).toBe('running');

    stream.stop();
    await stream.settled();
  });

  it('stops the subscription and aborts the request when the selection is replaced', async () => {
    const scope = new AbortController();
    const { stream, requests } = harness(scope.signal);
    stream.start();
    await waitFor(() => requests.length === 1);

    scope.abort();
    await stream.settled();

    expect(stream.state.phase).toBe('stopped');
    expect(requests[0]?.signal?.aborted).toBe(true);
  });

  it('does not reconnect after an explicit stop', async () => {
    const scope = new AbortController();
    const { stream, requests, pushes } = harness(scope.signal);
    stream.start();
    await waitFor(() => requests.length === 1);

    stream.stop();
    pushes[0]?.close();
    await settle(5);

    expect(requests).toHaveLength(1);
    expect(stream.state.phase).toBe('stopped');
  });

  it('adapts the cursor to a foreign-identity run without adopting its events', async () => {
    // Guards the pairing of the two identity fields: a session that is right and
    // a run that is wrong is still a refusal.
    const scope = new AbortController();
    resetClock();
    const { fetchImpl, requests, streams } = createStreamFetch();
    const stream = new RunEventStream({
      runId: RUN_ID,
      sessionId: SESSION_ID,
      streamUrl: (runId, afterSeq) => `/api/runs/${runId}/events?afterSeq=${afterSeq}`,
      fetchImpl,
      signal: scope.signal,
      reconnectDelayMs: 5,
      stallTimeoutMs: 0,
    });
    stream.start();
    await waitFor(() => requests.length === 1);

    const foreign = runStarted(1, 'run-other' as RunId, SESSION_ID as SessionId);
    streams[0]?.push(frameFor(foreign));
    await settle(4);

    expect(stream.getSnapshot().run.status).toBe('pending');
    expect(stream.getSnapshot().run.runId).toBeNull();
    expect(stream.getSnapshot().lastAcceptedSeq).toBe(0);

    stream.stop();
    await stream.settled();
  });
});

describe('RunEventStream batching', () => {
  it('admits one chunk of frames as one window rather than one apply per frame', async () => {
    const scope = new AbortController();
    const { stream, requests, pushes } = harness(scope.signal);
    let revisions = 0;
    const unsubscribe = stream.subscribe(() => {
      revisions += 1;
    });
    stream.start();
    await waitFor(() => requests.length === 1);

    const batch = [runStarted(1), turnStarted(2)];
    for (let seq = 3; seq <= 12; seq += 1) batch.push(textDelta(seq, 'msg-1', `${seq}`));
    pushes[0]?.push(batch.map(frameFor).join(''));
    await waitFor(() => stream.getSnapshot().lastAcceptedSeq === 12);
    await settle();

    // Eleven deltas in one read must not mean eleven renders.
    expect(revisions).toBeLessThan(5);
    expect(stream.getSnapshot().messages[0]?.text).toBe('3456789101112');

    unsubscribe();
    stream.stop();
    await stream.settled();
  });

  it('keeps publishing when a resumed window repeats a sequence inside one chunk', async () => {
    const scope = new AbortController();
    const { stream, requests, pushes } = harness(scope.signal);
    stream.start();
    await waitFor(() => requests.length === 1);

    // A Host that re-delivers a sequence inside one chunk makes the window
    // unordered; the frames around it must still land.
    pushes[0]?.push([
      frameFor(runStarted(1)),
      frameFor(textDelta(2, 'msg-1', '甲')),
      frameFor(textDelta(2, 'msg-1', '甲')),
      frameFor(textDelta(3, 'msg-1', '乙')),
    ].join(''));
    await waitFor(() => stream.getSnapshot().lastAcceptedSeq === 3);
    await settle();

    expect(stream.getSnapshot().messages[0]?.text).toBe('甲乙');

    stream.stop();
    await stream.settled();
  });
});

describe('frame helper', () => {
  it('writes the shape the BFF writes', () => {
    expect(frame(3, { seq: 3 })).toBe('id: 3\nevent: run\ndata: {"seq":3}\n\n');
    expect(messageFinalized(1, 'm', 'x').seq).toBe(1);
  });
});
