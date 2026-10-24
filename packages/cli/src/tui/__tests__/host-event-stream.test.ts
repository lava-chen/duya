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

  it('carries the request duration into the usage frame, and omits it when absent', () => {
    // The duration is what makes the output rate derivable, so it has to
    // survive the projection. It is OMITTED rather than zeroed when the
    // provider measured nothing: a zero would divide by zero downstream.
    expect(projectHostEvent({
      type: 'assistant.usage',
      usage: { inputTokens: 10, outputTokens: 1600, totalTokens: 1610, requestDurationMs: 20_000 },
    })).toEqual({
      type: 'token_usage',
      data: {
        input_tokens: 10,
        output_tokens: 1600,
        total_tokens: 1610,
        request_duration_ms: 20_000,
      },
    });
    expect(projectHostEvent({
      type: 'assistant.usage',
      usage: { inputTokens: 10, outputTokens: 1600, totalTokens: 1610 },
    })).toEqual({
      type: 'token_usage',
      data: { input_tokens: 10, output_tokens: 1600, total_tokens: 1610 },
    });
  });
});

describe('HostEventStream', () => {
  it('keeps repeated legacy message IDs separate across model turns', () => {
    const stream = new HostEventStream('session-1', 'run-1');
    const transcript = new TranscriptModel();
    let seq = 0;
    const push = (payload: RunEvent) => {
      const frame = stream.push(envelope(++seq, payload));
      if (frame !== null) transcript.apply(frame);
    };
    for (const index of [1, 2]) {
      push({ type: 'turn.started', turnId: `turn-${index}`, index, model: 'test', providerId: 'test', apiFormat: 'anthropic' });
      push({ type: 'assistant.thinking_delta', messageId: 'm-run', index: 0, delta: `thought-${index}` });
      push({ type: 'assistant.thinking_block', messageId: 'm-run', index: 0, thinking: `thought-${index}` });
      push({ type: 'assistant.text_delta', messageId: 'm-run', index: 0, delta: `text-${index}` });
      push({ type: 'assistant.text_block', messageId: 'm-run', index: 0, text: `text-${index}` });
      push({ type: 'tool.call_started', toolCallId: `tool-${index}`, toolName: 'bash', arguments: {}, attempt: 1 });
    }
    expect(transcript.blocks.map((b) => b.kind === 'tool' ? b.callId : 'text' in b ? b.text : b.kind))
      .toEqual(['thought-1', 'text-1', 'tool-1', 'thought-2', 'text-2', 'tool-2']);
  });

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

// ============================================================================
// D9, second acceptance point: recording a refusal is not the same as showing it
// ============================================================================
//
// The first acceptance point (in `packages/agent-runtime`, `engine-publication`)
// covers "the refusal reaches the durable ledger". It does NOT cover the user.
//
// They are separate, and today they are separate in the bad direction: the ledger
// loses the refusal entirely (D9), and once that is fixed the TUI would still not
// show it — `projectHostEvent` has a case for `permission.requested` and none for
// `permission.resolved`, so `default:` returns `null` and the event dies here,
// one layer downstream of where it is lost today.
//
// This contract deliberately asserts only "the projector produces a frame for
// it". What the TUI then does with that frame is the implementer's choice and
// the shapes genuinely differ: the resolution could close the overlay, add a
// transcript line, or mark the tool row as refused. Pinning one of those would
// prejudge a decision that has not been made — the failure mode an earlier
// version of the D9 contract in the runtime package had, where a predicate that
// only matched `tool.*` would have rejected the correct fix.

describe('a resolved permission reaches the TUI (D9)', () => {
  it('carries the permission REQUEST today, which is what makes the gap a gap', () => {
    // The control. Without it, "permission.resolved projects to null" would be
    // indistinguishable from "this projector emits nothing for permission
    // traffic at all" — a property of the fixture rather than a defect.
    expect(projectHostEvent({
      type: 'permission.requested',
      requestId: 'req-1',
      kind: 'tool_use',
      toolCallId: 'call-1',
      toolName: 'Bash',
      toolInput: { command: 'rm -rf build' },
      mode: 'generic',
      startedAt: 0,
      expiresAt: 300_000,
    })).toEqual({
      type: 'permission',
      data: {
        requestId: 'req-1',
        toolName: 'Bash',
        toolInput: { command: 'rm -rf build' },
        reason: undefined,
        mode: 'generic',
        blockedPath: undefined,
        expiresAt: 300_000,
      },
    });
  });

  it.fails('TARGET CONTRACT: the permission RESOLUTION is not dropped', () => {
    // Shapes taken from the protocol's own fixtures
    // (`agent-protocol/src/testing/fixtures.ts:109-114`) rather than invented,
    // so the fix cannot claim the test fed it an impossible event.
    const frame = projectHostEvent({
      type: 'permission.resolved',
      requestId: 'req-1',
      action: 'deny',
      source: 'host',
      latencyMs: 42,
    });

    expect(frame, 'a recorded denial projects to null, so the user is never told').not.toBeNull();
  });
});
