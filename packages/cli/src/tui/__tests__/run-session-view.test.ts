/**
 * The TUI's view adapter, checked against the legacy projector it replaces
 * (plan 610 T11).
 *
 * ## What this file is for
 *
 * T11's failure evidence: feed one recorded run containing `tool.timed_out` and
 * `permission.resolved`, and the view must say both. Today the legacy projector
 * has no case for either, so `default:` returns `null` and the fact dies one
 * layer before the user.
 *
 * ## The control is the whole point
 *
 * "The view emits a frame for the timeout" is a weak claim on its own — it is
 * also what you would see if the event could never have been lost. So the first
 * case pins the OPPOSITE direction on the same events: the legacy path drops
 * them. Without that, a regression that broke the adapter and a fixture that
 * never carried the event would be indistinguishable.
 *
 * Everything asserted is a concrete value. No case asserts only "did not throw".
 */
import { describe, expect, it } from 'vitest';
import { RunSession } from '@duya/client-core';
import { envelope, RUN_ID, SESSION_ID } from '@duya/client-core/testing';
import { TranscriptModel } from '../blocks.js';
import { HostEventStream, projectHostEvent } from '../host-event-stream.js';
import { createRunSessionView, projectRunSessionFrames, projectRunSessionView } from '../run-session-view.js';

/**
 * One recorded run. Payload shapes come from the protocol's own fixtures where
 * the fixture carries the type, and are written out where the card's point is a
 * field the fixture does not vary.
 */
function recordedRun() {
  return [
    envelope('run.started', { seq: 1 }),
    envelope('turn.started', { seq: 2, payload: { turnId: 'turn-1', index: 0 } }),
    envelope('tool.call_started', {
      seq: 3,
      payload: { toolCallId: 'call-1', toolName: 'Bash', arguments: { command: 'sleep 999' } },
    }),
    envelope('permission.requested', {
      seq: 4,
      payload: {
        requestId: 'req-1',
        kind: 'tool_use',
        toolCallId: 'call-1',
        toolName: 'Bash',
        toolInput: { command: 'rm -rf build' },
        mode: 'generic',
        startedAt: 0,
        expiresAt: 300_000,
      },
    }),
    envelope('tool.timed_out', {
      seq: 5,
      payload: { toolCallId: 'call-1', toolName: 'Bash', elapsedMs: 600_000 },
    }),
    envelope('permission.resolved', {
      seq: 6,
      payload: { requestId: 'req-1', action: 'deny', source: 'host', latencyMs: 42 },
    }),
    envelope('run.completed', { seq: 7, payload: { status: 'completed' } }),
  ];
}

describe('the legacy projector is what loses these two facts', () => {
  it('returns null for both, while still projecting the events around them', () => {
    // The control. Each dropped event is shown next to one the projector DOES
    // handle, so "drops it" cannot be confused with "projects nothing here".
    expect(projectHostEvent({
      type: 'tool.call_started',
      toolCallId: 'call-1',
      toolName: 'Bash',
      arguments: { command: 'sleep 999' },
    })).toEqual({ type: 'tool_use', data: { id: 'call-1', name: 'Bash', input: { command: 'sleep 999' } } });

    expect(projectHostEvent({ type: 'tool.timed_out', toolCallId: 'call-1', toolName: 'Bash', elapsedMs: 600_000 }))
      .toBeNull();
    expect(projectHostEvent({ type: 'permission.resolved', requestId: 'req-1', action: 'deny', source: 'host', latencyMs: 42 }))
      .toBeNull();
  });
});

describe('the view adapter states both from shared state', () => {
  it('emits a frame for each fact the legacy projector dropped', () => {
    const session = new RunSession({ runId: RUN_ID, sessionId: SESSION_ID });
    let view = createRunSessionView();
    const emitted: string[] = [];

    for (const event of recordedRun()) {
      session.apply(event);
      const projection = projectRunSessionView(view, session.getSnapshot());
      view = projection.state;
      for (const frame of projection.frames) emitted.push(frame.type);
    }

    // Exactly one frame each, and both land. The counts are part of the claim:
    // an adapter that re-announced the timeout on every later snapshot would
    // pass a "contains" assertion and fail this one.
    expect(emitted).toEqual(['tool_timed_out', 'permission_resolved']);
  });

  it('reaches the transcript: the tool row is marked and the answer is stated', () => {
    const session = new RunSession({ runId: RUN_ID, sessionId: SESSION_ID });
    const model = new TranscriptModel();
    let view = createRunSessionView();

    for (const event of recordedRun()) {
      session.apply(event);
      const projection = projectRunSessionView(view, session.getSnapshot());
      view = projection.state;
      for (const frame of projection.frames) model.apply(frame);
    }

    const tool = model.toolByCallId('call-1');
    expect(tool?.timedOut).toBe(true);
    // A timeout is not a completion: no result is invented for a call that has
    // not come back.
    expect(tool?.result).toBeUndefined();

    const lines = model.blocks.filter((block) => block.kind === 'notice');
    expect(lines.map((block) => (block as { text: string }).text)).toEqual([
      'Permission denied for Bash',
    ]);
  });

  it('is idempotent: projecting again states nothing twice', () => {
    const session = new RunSession({ runId: RUN_ID, sessionId: SESSION_ID });
    let view = createRunSessionView();
    for (const event of recordedRun()) {
      session.apply(event);
      view = projectRunSessionView(view, session.getSnapshot()).state;
    }

    // Same snapshot, no new events. A projection that re-derived its frames
    // from state alone rather than from the delta would duplicate both facts
    // on every render tick.
    expect(projectRunSessionView(view, session.getSnapshot()).frames).toEqual([]);
  });
});

/** Block identity without the generated ids, which depend on construction order. */
function blockShape(model: TranscriptModel): string[] {
  return model.blocks.map((block) => {
    switch (block.kind) {
      case 'user':
        return `user:${block.text}`;
      case 'assistant':
        return `assistant:${block.text}`;
      case 'thinking':
        return `thinking:${block.text}`;
      case 'tool':
        return `tool:${block.callId}:${block.status}:${block.result ?? ''}`;
      case 'notice':
        return `notice:${block.text}`;
      case 'error':
        return `error:${block.message}`;
      default:
        return block.kind;
    }
  });
}

/** Frame types the legacy projector can also produce. */
const LEGACY_HANDLED = new Set(['text', 'thinking', 'tool_use', 'tool_result', 'permission', 'done', 'error']);

describe('the replay agrees with the legacy reducer', () => {
  it('produces the same block sequence, plus exactly the two facts legacy drops', () => {
    const events = recordedRun();

    // The old path: every event, projected one at a time.
    const legacy = new TranscriptModel();
    const stream = new HostEventStream(SESSION_ID, RUN_ID);
    for (const event of events) {
      const frame = stream.push(event);
      if (frame !== null) legacy.apply(frame);
    }

    // The new path: one replay built from the snapshot.
    const session = new RunSession({ runId: RUN_ID, sessionId: SESSION_ID });
    for (const event of events) session.apply(event);
    const frames = projectRunSessionFrames(session.getSnapshot());

    const replayed = new TranscriptModel();
    for (const frame of frames) replayed.apply(frame);
    const filtered = new TranscriptModel();
    for (const frame of frames) if (LEGACY_HANDLED.has(frame.type)) filtered.apply(frame);

    // Equality on the shared vocabulary is the claim that matters: switching the
    // render source must not move a single block the user can already see.
    expect(blockShape(filtered)).toEqual(blockShape(legacy));
    // And the ONLY difference is the two facts the old path could not say.
    expect(frames.filter((frame) => !LEGACY_HANDLED.has(frame.type)).map((frame) => frame.type))
      .toEqual(['tool_timed_out', 'permission_resolved']);
    // The timed-out row is marked but NOT completed: status stays `running`
    // and no result is invented. Asserting `error` here would pin the opposite
    // of the rule — a timeout is the volatile notice, not a completion.
    expect(blockShape(replayed)).toContain('tool:call-1:running:');
    expect(replayed.toolByCallId('call-1')?.timedOut).toBe(true);
    expect(replayed.toolByCallId('call-1')?.result).toBeUndefined();
  });

  it('places a tool row where the run sequence put it, not after every message', () => {
    // The regression this ordering exists to prevent: entity lists have no
    // order between them, so "all messages then all tools" puts a tool line
    // below text written after it.
    const session = new RunSession({ runId: RUN_ID, sessionId: SESSION_ID });
    for (const event of [
      envelope('run.started', { seq: 1 }),
      envelope('assistant.text_delta', { seq: 2, payload: { messageId: 'm1', delta: 'first' } }),
      envelope('tool.call_started', { seq: 3, payload: { toolCallId: 'call-9', toolName: 'Bash', arguments: { command: 'ls' } } }),
      envelope('tool.call_completed', { seq: 4, payload: { toolCallId: 'call-9', outcome: { outcome: 'success' }, content: 'ok' } }),
      envelope('assistant.text_delta', { seq: 5, payload: { messageId: 'm2', delta: 'second' } }),
    ]) {
      session.apply(event);
    }

    const model = new TranscriptModel();
    for (const frame of projectRunSessionFrames(session.getSnapshot())) model.apply(frame);

    expect(blockShape(model)).toEqual(['assistant:first', 'tool:call-9:ok:ok', 'assistant:second']);
  });
});

describe('the render-source seam splices rather than replaces', () => {
  it('keeps the local user blocks and rebuilds only the run-derived segment', () => {
    // The constraint that decides how the switch may be wired: user blocks are
    // local input and are NOT in the snapshot, so a render source that cleared
    // the transcript would delete the user's own prompts on every snapshot.
    const model = new TranscriptModel();
    model.addUser('first prompt');
    model.apply({ type: 'text', data: { content: 'answer one' } });
    model.addUser('second prompt');
    model.apply({ type: 'text', data: { content: 'answer two' } });

    expect(blockShape(model)).toEqual([
      'user:first prompt',
      'assistant:answer one',
      'user:second prompt',
      'assistant:answer two',
    ]);

    model.replayRunSegment([{ type: 'text', data: { content: 'replayed answer' } }]);

    // Both prompts survive, in order, and only the run's own output is replaced.
    expect(blockShape(model)).toEqual([
      'user:first prompt',
      'assistant:answer one',
      'user:second prompt',
      'assistant:replayed answer',
    ]);
  });

  it('drops a stale tool row rather than leaving it beside the replay', () => {
    const model = new TranscriptModel();
    model.addUser('do a thing');
    model.apply({ type: 'tool_use', data: { id: 'call-old', name: 'Bash', input: { command: 'old' } } });
    model.apply({ type: 'tool_result', data: { id: 'call-old', result: 'old output', error: false } });
    expect(model.toolByCallId('call-old')).not.toBeNull();

    model.replayRunSegment([
      { type: 'tool_use', data: { id: 'call-new', name: 'Bash', input: { command: 'new' } } },
    ]);

    // The correlation map is rebuilt with the segment. Leaving the old row
    // behind is how a replay ends up showing a tool call that never happened.
    expect(model.toolByCallId('call-old')).toBeNull();
    expect(model.toolByCallId('call-new')).not.toBeNull();
    expect(blockShape(model)).toEqual(['user:do a thing', 'tool:call-new:running:']);
  });
});
