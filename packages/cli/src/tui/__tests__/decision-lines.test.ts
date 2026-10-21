/**
 * The three decision lines: retry, mode switch, goal update.
 *
 * ## Why these three and not the other forty
 *
 * The reducer adjudicates 41 frame types. Owner decision (plan 610): exactly
 * three of them earn a durable transcript row — the answers to "why did it do
 * that". Everything else the reducer declines stays chrome. This file is the
 * evidence that the three now arrive, and that the rest of the declination
 * policy is untouched.
 *
 * ## The claim spans two layers, so the tests do too
 *
 * A line exists only if BOTH the view adapter emits a frame AND the reducer
 * renders it. Asserting the frame alone would pass with a reducer still
 * returning `none`; asserting the row alone would not say where it came from.
 * Each case below names which layer it is pinning.
 *
 * ## Controls
 *
 * - Layer 0, the loss direction: `projectHostEvent` drops all three events, so
 *   on the live path the fact never became a frame at all. Shown next to an
 *   event it does handle, so "drops it" is not "projects nothing at all".
 * - The dedup guards are each paired with an OPPOSING case. "Projects the mode
 *   once" is also what an implementation that projects it once EVER would
 *   produce, so the mode test asserts the second, different mode DOES come
 *   through; same for the goal fingerprint and for a second retrying turn.
 */
import { describe, expect, it } from 'vitest';
import { RunSession } from '@duya/client-core';
import { envelope, RUN_ID, SESSION_ID } from '@duya/client-core/testing';
import type { RunSessionSnapshot } from '@duya/client-core';
import { TranscriptModel } from '../blocks.js';
import { projectHostEvent } from '../host-event-stream.js';
import { createRunSessionView, projectRunSessionFrames, projectRunSessionView } from '../run-session-view.js';

/** One run that reaches all three decisions. `turn.started` gates the retry. */
function decisionRun() {
  return [
    envelope('run.started', { seq: 1 }),
    envelope('turn.started', { seq: 2, payload: { turnId: 'turn-1', index: 0 } }),
    envelope('turn.retry_scheduled', { seq: 3, payload: { attempt: 2, maxAttempts: 3, delayMs: 800, reason: 'overloaded' } }),
    envelope('assistant.mode_changed', { seq: 4, payload: { mode: 'plan', source: 'user' } }),
    envelope('assistant.goal_updated', { seq: 5, payload: { state: 'active', phase: 'explore', objective: 'read the protocol' } }),
  ];
}

/** Frame types, in the order the adapter produced them. */
function frameTypes(frames: readonly { type: string }[]): string[] {
  return frames.map((frame) => frame.type);
}

/** Notice rows, which is what a decision line is on screen. */
function noticeTexts(model: TranscriptModel): string[] {
  return model.blocks.filter((block) => block.kind === 'notice').map((block) => (block as { text: string }).text);
}

describe('layer 0: the live path never made a frame for any of the three', () => {
  it('drops each event, while still projecting its neighbour', () => {
    // The positive control first, so the three nulls below cannot be explained
    // by "this projector produces nothing".
    expect(projectHostEvent({ type: 'assistant.status', message: 'working' }))
      .toEqual({ type: 'status', data: { message: 'working' } });

    expect(projectHostEvent({ type: 'turn.retry_scheduled', attempt: 2, maxAttempts: 3, delayMs: 800, reason: 'overloaded' }))
      .toBeNull();
    expect(projectHostEvent({ type: 'assistant.mode_changed', mode: 'plan', source: 'user' }))
      .toBeNull();
    expect(projectHostEvent({ type: 'assistant.goal_updated', state: 'active', phase: 'explore', objective: 'x', tokensUsed: 0, tokenBudget: 1, consecutiveNotAchieved: 0 }))
      .toBeNull();
  });
});

describe('layer 1: the adapter states all three, off shared state', () => {
  it('emits one frame per decision as the run reaches it', () => {
    const session = new RunSession({ runId: RUN_ID, sessionId: SESSION_ID });
    let view = createRunSessionView();
    const emitted: string[] = [];

    for (const event of decisionRun()) {
      session.apply(event);
      const projection = projectRunSessionView(view, session.getSnapshot());
      view = projection.state;
      emitted.push(...frameTypes(projection.frames));
    }

    // Exactly three, in run order. Counts are part of the claim: an adapter
    // that re-announced on every later snapshot would pass a `contains` check.
    expect(emitted).toEqual(['retry', 'mode_changed', 'goal_updated']);
  });

  it('states a mode that is still there when the volatile frame is not', () => {
    // The teeth of "read off the state". `assistant.mode_changed` is VOLATILE
    // in the protocol registry, so a reconnect window does not re-deliver it —
    // the fact has to come from `snapshot.mode` or the line is lost on reconnect.
    const session = new RunSession({ runId: RUN_ID, sessionId: SESSION_ID });
    for (const event of decisionRun()) session.apply(event);
    const live = session.getSnapshot();

    // The volatile frames removed, as a reconnect that only re-delivers durable
    // events would present them. If the adapter read the timeline this is empty.
    const afterReconnect: RunSessionSnapshot = {
      ...live,
      timeline: live.timeline.filter((item) => item.payload.type !== 'assistant.mode_changed'),
    };
    expect(afterReconnect.timeline.some((item) => item.payload.type === 'assistant.mode_changed')).toBe(false);

    const projection = projectRunSessionView(createRunSessionView(), afterReconnect);
    expect(frameTypes(projection.frames)).toEqual(['retry', 'mode_changed', 'goal_updated']);

    // The opposing direction, same input shape: a run that really has no mode
    // states none. Without this, "always emits a mode line" passes.
    const noMode: RunSessionSnapshot = { ...afterReconnect, mode: null, modeSource: null };
    expect(frameTypes(projectRunSessionView(createRunSessionView(), noMode).frames)).toEqual(['retry', 'goal_updated']);
  });

  it('states a NEW mode and goal rather than the first one for the rest of the run', () => {
    // The control for the dedup guards. A guard that latched after the first
    // projection would pass "emits once" and fail here, so this is what gives
    // the idempotence case below its teeth.
    const session = new RunSession({ runId: RUN_ID, sessionId: SESSION_ID });
    let view = createRunSessionView();
    const emitted: string[] = [];

    for (const event of [
      ...decisionRun(),
      envelope('assistant.mode_changed', { seq: 6, payload: { mode: 'verify', source: 'agent' } }),
      envelope('assistant.goal_updated', { seq: 7, payload: { state: 'achieved', phase: 'done', objective: 'read the protocol' } }),
    ]) {
      session.apply(event);
      const projection = projectRunSessionView(view, session.getSnapshot());
      view = projection.state;
      emitted.push(...frameTypes(projection.frames));
    }

    expect(emitted).toEqual(['retry', 'mode_changed', 'goal_updated', 'mode_changed', 'goal_updated']);
    expect(view.statedMode).toBe('verify|agent');
  });
});

describe('both projectors agree on the same snapshot', () => {
  it('a full replay carries the same three lines the live delta did', () => {
    // The replay projector is what `replayRunSegment` feeds when the render
    // source flips. If it swallowed the three decisions, flipping the switch
    // would silently delete rows the live path already showed — the exact class
    // of regression the T11 cross-check exists to catch, so it is pinned here.
    const session = new RunSession({ runId: RUN_ID, sessionId: SESSION_ID });
    for (const event of decisionRun()) session.apply(event);

    const delta = new TranscriptModel();
    let view = createRunSessionView();
    const projection = projectRunSessionView(view, session.getSnapshot());
    view = projection.state;
    for (const frame of projection.frames) delta.apply(frame);

    const replay = new TranscriptModel();
    for (const frame of projectRunSessionFrames(session.getSnapshot())) replay.apply(frame);

    expect(frameTypes(projectRunSessionFrames(session.getSnapshot())))
      .toEqual(frameTypes(projection.frames));
    expect(noticeTexts(replay)).toEqual(noticeTexts(delta));
  });

  it('replays only the mode the run ENDED in, while the delta stated both', () => {
    // The cross-check above uses one change per fact, which is exactly where a
    // "state the mode once per event" bug and a "state it once" bug produce the
    // same frames. So the divergence is pinned here instead of left implicit.
    const session = new RunSession({ runId: RUN_ID, sessionId: SESSION_ID });
    let view = createRunSessionView();
    const delta: string[] = [];
    for (const event of [
      ...decisionRun(),
      envelope('assistant.mode_changed', { seq: 6, payload: { mode: 'verify', source: 'agent' } }),
    ]) {
      session.apply(event);
      const projection = projectRunSessionView(view, session.getSnapshot());
      view = projection.state;
      delta.push(...frameTypes(projection.frames));
    }

    const replay = frameTypes(projectRunSessionFrames(session.getSnapshot()));

    // The delta saw both switches live; the snapshot kept only the final value,
    // so the replay can state one. It must not state the same final mode TWICE
    // — that is the fabricated "switched to verify, twice" a naive replay does.
    expect(delta.filter((type) => type === 'mode_changed')).toHaveLength(2);
    expect(replay.filter((type) => type === 'mode_changed')).toEqual(['mode_changed']);
  });
});

describe('layer 2: the reducer renders each decision as a durable row', () => {
  it('reaches the transcript, with the numbers it was given', () => {
    const session = new RunSession({ runId: RUN_ID, sessionId: SESSION_ID });
    const model = new TranscriptModel();
    let view = createRunSessionView();

    for (const event of decisionRun()) {
      session.apply(event);
      const projection = projectRunSessionView(view, session.getSnapshot());
      view = projection.state;
      for (const frame of projection.frames) model.apply(frame);
    }

    expect(noticeTexts(model)).toEqual([
      'Retrying (attempt 2/3) — overloaded',
      'Mode: plan (user)',
      'Goal active · explore — read the protocol',
    ]);
  });

  it('does not restate anything on a later snapshot, or on a reconnect window', () => {
    const session = new RunSession({ runId: RUN_ID, sessionId: SESSION_ID });
    const model = new TranscriptModel();
    let view = createRunSessionView();

    for (const event of decisionRun()) {
      session.apply(event);
      const projection = projectRunSessionView(view, session.getSnapshot());
      view = projection.state;
      for (const frame of projection.frames) model.apply(frame);
    }

    // Same snapshot, no new events: a projection that re-derived its frames
    // from state alone would duplicate all three on every render tick.
    expect(projectRunSessionView(view, session.getSnapshot()).frames).toEqual([]);

    // A reconnect window: durable events only, so neither volatile decision is
    // re-delivered. The rows must still be exactly the three above.
    session.acceptWindow([envelope('run.completed', { seq: 8, payload: { status: 'completed' } })]);
    const projection = projectRunSessionView(view, session.getSnapshot());
    view = projection.state;
    for (const frame of projection.frames) model.apply(frame);

    expect(noticeTexts(model)).toHaveLength(3);
    expect(noticeTexts(model)[0]).toBe('Retrying (attempt 2/3) — overloaded');
  });

  it('says nothing when a frame carries no decision', () => {
    // The declination policy is the other half of the owner decision, so it
    // gets pinned too: a frame with no identifying field is not a line.
    const model = new TranscriptModel();
    model.apply({ type: 'retry', data: {} });
    model.apply({ type: 'mode_changed', data: { mode: '' } });
    model.apply({ type: 'goal_updated', data: { state: '', phase: '', objective: '' } });
    expect(model.blocks).toEqual([]);
  });

  it('clips a long objective instead of pushing the row past the window', () => {
    const objective = 'x'.repeat(200);
    const model = new TranscriptModel();
    model.apply({ type: 'goal_updated', data: { state: 'active', phase: 'explore', objective } });

    const text = noticeTexts(model)[0] ?? '';
    expect(text).toBe(`Goal active · explore — ${'x'.repeat(79)}…`);
    expect(text.length).toBeLessThanOrEqual(110);
  });
});
