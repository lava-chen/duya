import { describe, expect, it } from 'vitest';
import type { RunEvent, RunEventEnvelope } from '@duya/agent-protocol';
import { TranscriptModel, resetBlockIds } from '../blocks.js';
import { HostEventStream, projectHostEvent } from '../host-event-stream.js';

function envelope<T extends RunEvent>(seq: number, payload: T, ids = {
  sessionId: 'session-1',
  runId: 'run-1',
}): RunEventEnvelope<T> {
  return {
    sessionId: ids.sessionId,
    runId: ids.runId,
    seq,
    timestamp: 1_760_000_000_000,
    traceId: 'trace-1',
    payload,
  };
}

describe('projectHostEvent', () => {
  it('projects streaming deltas and authoritative text blocks into their distinct frames', () => {
    const delta = projectHostEvent({ type: 'assistant.text_delta', delta: 'Hello ' });
    const block = projectHostEvent({ type: 'assistant.text_block', text: 'Hello world' });

    expect(delta).toEqual({ type: 'text_delta', data: { content: 'Hello ' } });
    expect(block).toEqual({ type: 'text', data: { content: 'Hello world' } });

    resetBlockIds();
    const transcript = new TranscriptModel();
    transcript.apply(delta!);
    transcript.apply(block!);
    expect(transcript.blocks).toMatchObject([
      { kind: 'assistant', text: 'Hello world', finalized: true },
    ]);
  });

  it('projects protocol terminal events using existing done and error frames', () => {
    expect(projectHostEvent({ type: 'run.completed', status: 'cancelled' })).toEqual({
      type: 'done',
      data: { reason: 'cancelled' },
    });
    expect(projectHostEvent({
      type: 'run.failed',
      error: { code: 'runtime_crash', message: 'worker exited' },
    })).toEqual({
      type: 'error',
      data: { message: 'worker exited', code: 'runtime_crash' },
    });
  });

  it('ignores valid protocol events without a TUI frame', () => {
    expect(projectHostEvent({
      type: 'run.started',
      manifestHash: 'manifest-1',
      protocol: { major: 1, minor: 0 },
      runtime: { name: 'duya-host', version: '1.0.0' },
    })).toBeNull();
  });
});

describe('HostEventStream', () => {
  it('rejects other run or session envelopes and duplicate or older sequence numbers', () => {
    const stream = new HostEventStream('session-1', 'run-1');
    const event = { type: 'assistant.status', message: 'working' } as const;

    expect(stream.push(envelope(1, event, { sessionId: 'session-2', runId: 'run-1' }))).toBeNull();
    expect(stream.push(envelope(1, event, { sessionId: 'session-1', runId: 'run-2' }))).toBeNull();
    expect(stream.push(envelope(1, event))).toEqual({ type: 'status', data: { message: 'working' } });
    expect(stream.push(envelope(1, event))).toBeNull();
    expect(stream.push(envelope(3, event))).toEqual({ type: 'status', data: { message: 'working' } });
    expect(stream.push(envelope(2, event))).toBeNull();
  });

  it('advances the sequence for unhandled events so their replay stays deduplicated', () => {
    const stream = new HostEventStream('session-1', 'run-1');
    const unhandled = {
      type: 'run.started',
      manifestHash: 'manifest-1',
      protocol: { major: 1, minor: 0 },
      runtime: { name: 'duya-host', version: '1.0.0' },
    } as const;

    expect(stream.push(envelope(4, unhandled))).toBeNull();
    expect(stream.push(envelope(4, { type: 'assistant.status', message: 'replay' }))).toBeNull();
    expect(stream.push(envelope(5, { type: 'assistant.status', message: 'next' }))).toEqual({
      type: 'status',
      data: { message: 'next' },
    });
  });

  it('settles a cancelled run through run.completed and keeps finalized transcript content', () => {
    resetBlockIds();
    const stream = new HostEventStream('session-1', 'run-1');
    const transcript = new TranscriptModel();

    const delta = stream.push(envelope(1, { type: 'assistant.text_delta', delta: 'Answer' }));
    const block = stream.push(envelope(2, { type: 'assistant.text_block', text: 'Answer' }));
    expect(delta).not.toBeNull();
    expect(block).not.toBeNull();
    transcript.apply(delta!);
    transcript.apply(block!);

    const terminal = stream.push(envelope(3, {
      type: 'run.completed',
      status: 'cancelled',
      cancelRequested: true,
    }));
    expect(terminal).toEqual({ type: 'done', data: { reason: 'cancelled' } });
    transcript.apply(terminal!);
    expect(transcript.blocks).toMatchObject([
      { kind: 'assistant', text: 'Answer', finalized: true },
    ]);
    expect(stream.push(envelope(2, { type: 'assistant.text_block', text: 'late replay' }))).toBeNull();
  });
});
