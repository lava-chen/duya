/**
 * The blessed tape, end to end: protocol envelopes -> surface model -> blessed
 * tag markup. No screen is constructed, so this runs in CI without a TTY.
 *
 * ## What this is the proof of
 *
 * A SECOND renderer pointed at the same `SurfaceModel`. The conformance suite in
 * `packages/agent-runtime` holds the model to the protocol; this file holds the
 * blessed side to the model. Together they are the answer to "how do we know the
 * next renderer will not drift" — it is not a convention, it is these two files
 * disagreeing in public.
 *
 * ## The two capabilities
 *
 * Turn lifecycle and tool call phases, because those are exactly the two the
 * legacy frame vocabulary cannot carry: `turn.completed` and `tool.timed_out`
 * both project to `null`.
 */

import { describe, expect, it } from 'vitest';
import type { EventType, RunEventEnvelope } from '@duya/agent-protocol';
import { EVENT_FIXTURES } from '@duya/agent-protocol/testing';
import { SurfaceTape } from '../ui/surface-view.js';

const RUN_ID = 'run-blessed';
const BASE_TS = 1_700_000_000_000;

/** A legal envelope around the protocol's own minimal fixture payload. */
function envelope<T extends EventType>(
  type: T,
  seq: number,
  overrides: { readonly payload?: object; readonly timestamp?: number } = {},
): RunEventEnvelope {
  return {
    runId: RUN_ID,
    sessionId: 'session-blessed',
    seq,
    timestamp: overrides.timestamp ?? BASE_TS + seq,
    traceId: 'trace-blessed',
    payload: { type, ...((EVENT_FIXTURES[type] ?? {}) as object), ...(overrides.payload ?? {}) },
  } as RunEventEnvelope;
}

/** Strip blessed tags so assertions read as text, not as markup. */
function plain(tagged: string): string {
  return tagged.replace(/\{\/?[a-zA-Z-]+\}/g, '');
}

describe('blessed surface tape: turn lifecycle', () => {
  it('renders a turn row that walks started -> retrying -> completed', () => {
    const tape = new SurfaceTape();

    tape.push(envelope('turn.started', 1, { payload: { turnId: 'turn-1', index: 2 } }));
    expect(plain(tape.renderTurns()[0] ?? '')).toBe('⏺ turn 2 · test-model');

    tape.push(envelope('turn.retry_scheduled', 2, { payload: { attempt: 2, maxAttempts: 5, delayMs: 1500 } }));
    // The retry row must carry the retry's own facts: "retrying" alone cannot
    // tell a reader whether to wait 1.5s or 90s.
    expect(plain(tape.renderTurns()[0] ?? '')).toBe('↻ turn 2 · test-model · retry 2/5 in 1500ms');

    tape.push(envelope('turn.completed', 3));
    expect(plain(tape.renderTurns()[0] ?? '')).toBe(
      '✔ turn 0 · test-model · end_turn (2 tokens, 10ms)',
    );
  });

  it('renders a turn that the run failed underneath as failed', () => {
    const tape = new SurfaceTape();
    tape.push(envelope('run.started', 1));
    tape.push(envelope('turn.started', 2));
    expect(plain(tape.renderTurns()[0] ?? '')).toBe('⏺ turn 0 · test-model');

    tape.push(envelope('run.failed', 3));
    // The legacy surface cannot draw this row at all: there is no terminal
    // turn frame, so a turn that never finished was indistinguishable from one
    // that never began.
    expect(plain(tape.renderTurns()[0] ?? '')).toBe('✖ turn 0 · test-model · failed');
  });

  it('escapes braces in turn text so blessed cannot swallow them', () => {
    const tape = new SurfaceTape();
    tape.push(
      envelope('turn.started', 1, {
        payload: { turnId: 'turn-1', index: 0, model: 'weird{model}' },
      }),
    );
    // `escapeTags` is what stops a literal `{` in model output opening a tag.
    expect(tape.renderTurns()[0]).toContain('weird\\{model}');
    expect(plain(tape.renderTurns()[0] ?? '')).not.toContain('{model}');
  });
});

describe('blessed surface tape: tool call phases', () => {
  it('renders one row per phase transition', () => {
    const tape = new SurfaceTape();
    const row = (): string => plain(tape.renderTools()[0] ?? '');

    tape.push(envelope('tool.call_preview', 1));
    expect(row()).toBe('· Read · proposing');

    tape.push(envelope('tool.arguments_delta', 2));
    expect(row()).toBe('· Read · generating arguments');

    tape.push(envelope('tool.call_started', 3));
    expect(row()).toBe('⏺ Read');

    tape.push(envelope('tool.progress', 4, { payload: { elapsedMs: 2500 } }));
    expect(row()).toBe('⏺ Read · 2.5s');

    tape.push(envelope('tool.call_completed', 5));
    expect(row()).toBe('✔ Read');
  });

  it('prefers a percentage over elapsed time when the tool reports one', () => {
    const tape = new SurfaceTape();
    tape.push(envelope('tool.call_started', 1));
    tape.push(envelope('tool.progress', 2, { payload: { elapsedMs: 900, percent: 40 } }));
    expect(plain(tape.renderTools()[0] ?? '')).toBe('⏺ Read · 40%');
  });

  it('renders a timeout differently from a failure', () => {
    const tape = new SurfaceTape();
    tape.push(envelope('tool.call_started', 1));
    tape.push(envelope('tool.timed_out', 2));
    // The distinction the legacy frame cannot make: `tool.timed_out` reaches
    // `null`, and folding it into "failed" would misreport what happened.
    expect(plain(tape.renderTools()[0] ?? '')).toBe('⏱ Read · timed out');
  });

  it('renders a non-success outcome by name rather than as a bare cross', () => {
    const tape = new SurfaceTape();
    tape.push(envelope('tool.call_started', 1));
    tape.push(
      envelope('tool.call_completed', 2, {
        payload: { outcome: { outcome: 'indeterminate', note: 'producer sent no status' } },
      }),
    );
    // `indeterminate` means "the producer did not say". Reporting it as a
    // success would be a fabricated fact.
    expect(plain(tape.renderTools()[0] ?? '')).toBe('✔ Read · indeterminate');
  });

  it('keeps one row per tool call across its whole lifecycle', () => {
    const tape = new SurfaceTape();
    tape.push(envelope('tool.call_preview', 1));
    tape.push(envelope('tool.call_started', 2));
    tape.push(envelope('tool.call_completed', 3));
    tape.push(
      envelope('tool.call_preview', 4, { payload: { toolCallId: 'call-2', toolName: 'Grep' } }),
    );

    expect(tape.renderTools()).toHaveLength(2);
    expect(plain(tape.renderTools()[1] ?? '')).toBe('· Grep · proposing');
  });
});

describe('blessed surface tape: repaint accounting', () => {
  it('asks for no repaint on an event it cannot draw', () => {
    const tape = new SurfaceTape();
    // A trace span is ephemeral and the model retains nothing for it. A redraw
    // per span would be a repaint per span across a whole run.
    expect(tape.push(envelope('diagnostic.trace', 1)).redraw).toBe(false);
    // Neither is `run.started` on its own: this tape draws turn and tool rows,
    // and opening a run has not drawn either.
    expect(tape.push(envelope('run.started', 2)).redraw).toBe(false);
  });

  it('asks for a repaint on every event that mutates a row it draws', () => {
    const tape = new SurfaceTape();
    expect(tape.push(envelope('turn.started', 1)).redraw).toBe(true);
    expect(tape.push(envelope('turn.retry_scheduled', 2)).redraw).toBe(true);
    expect(tape.push(envelope('tool.call_preview', 3)).redraw).toBe(true);
    expect(tape.push(envelope('tool.call_completed', 4)).redraw).toBe(true);
    // A failed run mutates a turn row without being a turn of its own.
    expect(tape.push(envelope('run.failed', 5)).redraw).toBe(true);
  });
});

describe('blessed surface tape: a whole run', () => {
  it('renders turn rows then tool rows for one complete turn', () => {
    const tape = new SurfaceTape();
    tape.pushAll([
      envelope('run.started', 1),
      envelope('turn.started', 2),
      envelope('tool.call_started', 3, { payload: { toolCallId: 'call-1', toolName: 'Read' } }),
      envelope('tool.call_completed', 4, { payload: { toolCallId: 'call-1', toolName: 'Read' } }),
      envelope('turn.completed', 5),
    ]);

    expect(tape.renderTurns().map(plain)).toEqual([
      '✔ turn 0 · test-model · end_turn (2 tokens, 10ms)',
    ]);
    expect(tape.renderTools().map(plain)).toEqual(['✔ Read']);
    expect(tape.render().split('\n').map(plain)).toEqual([
      '✔ turn 0 · test-model · end_turn (2 tokens, 10ms)',
      '✔ Read',
    ]);
  });

  it('renders nothing for an empty tape rather than throwing', () => {
    const tape = new SurfaceTape();
    expect(tape.render()).toBe('');
  });

  it('clears every row on clear', () => {
    const tape = new SurfaceTape();
    tape.push(envelope('turn.started', 1));
    tape.push(envelope('tool.call_preview', 2));
    expect(tape.render()).not.toBe('');

    tape.clear();
    expect(tape.render()).toBe('');
    expect(tape.surface.toolCallCount).toBe(0);
  });
});
