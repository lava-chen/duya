/**
 * Adversarial regression suite for `RunSession`.
 *
 * The companion `run-session.test.ts` proves the happy path. This file attacks
 * the admission boundary from the Host's side: sparse windows, late replay
 * after the run is already terminal, overlapping replays, hostile envelopes,
 * and two runs that legitimately share a session and a set of `seq` values.
 *
 * ## What counts as a defect here
 *
 * Every assertion below states something the protocol or `RunSession`'s own
 * docstrings already promise. Where the current implementation breaks one, the
 * test is left failing on purpose: an adversarial suite that is green because
 * it asserts nothing is worse than no suite, and the production file is not
 * edited to make a test pass.
 */

import { describe, expect, it, vi } from 'vitest';
import type { RunEventEnvelope } from '@duya/agent-protocol';
import { RunSession } from '../src/session/run-session.js';
import { envelope, RUN_ID, SESSION_ID } from '../src/testing/index.js';

/** Retag a protocol fixture for another run, keeping the payload real. */
function forRun(runId: string, source: RunEventEnvelope): RunEventEnvelope {
  return { ...source, runId } as RunEventEnvelope;
}

/**
 * Every object reachable from `value`, as `path` strings for the ones that are
 * not frozen. The published snapshot is handed to renderers, so a single
 * writable node anywhere in the graph is a hole a renderer can use to corrupt
 * every other renderer's view of the same run.
 */
function unfrozenPaths(value: unknown, path: string, out: string[]): void {
  if (value === null || typeof value !== 'object') return;
  if (!Object.isFrozen(value)) out.push(path);
  if (Array.isArray(value)) {
    value.forEach((item, index) => unfrozenPaths(item, `${path}[${index}]`, out));
    return;
  }
  for (const [key, child] of Object.entries(value)) {
    unfrozenPaths(child, `${path}.${key}`, out);
  }
}

function newSession(runId: string = RUN_ID, sessionId: string = SESSION_ID): RunSession {
  return new RunSession({ runId, sessionId });
}

describe('RunSession adversarial: sparse Host windows', () => {
  it('admits a sparse window without inventing the missing events', () => {
    const session = newSession();

    const result = session.acceptWindow([
      envelope('assistant.text_delta', { seq: 1000, payload: { delta: 'a' } }),
      envelope('assistant.text_delta', { seq: 5000, payload: { delta: 'b' } }),
    ]);

    expect(result).toEqual({
      accepted: true,
      applied: 2,
      duplicates: 0,
      lastAcceptedSeq: 5000,
    });
    const snapshot = session.getSnapshot();
    // The gap 1..4999 is not evidence of a lost event. A client that padded it
    // would fabricate durable records the runtime never emitted.
    expect(snapshot.timeline.map((item) => item.seq)).toEqual([1000, 5000]);
    expect(snapshot.messages).toHaveLength(1);
    expect(snapshot.messages[0]?.text).toBe('ab');
    expect(snapshot.revision).toBe(1);
  });

  it('surfaces a turn whose announcement fell in a sparse gap', () => {
    const session = newSession();

    // seq 1..39 never delivered, so `turn.started` for turn-9 is missing.
    const result = session.acceptWindow([
      envelope('turn.completed', { seq: 40, payload: { turnId: 'turn-9', index: 3 } }),
    ]);

    expect(result.accepted).toBe(true);
    const snapshot = session.getSnapshot();
    // Never silently dropped: the row exists, with the fields the gap cost it.
    expect(snapshot.turns).toHaveLength(1);
    expect(snapshot.turns[0]?.turnId).toBe('turn-9');
    expect(snapshot.turns[0]?.phase).toBe('completed');
    expect(snapshot.turns[0]?.index).toBe(3);
    expect(snapshot.turns[0]?.model).toBe('');
  });

  it('keeps a tool row whose dispatch fell in a sparse gap', () => {
    const session = newSession();

    // No `tool.call_started` and no `tool.call_preview` ever arrived, so the
    // streamed arguments and the durable completion are the only evidence.
    const result = session.acceptWindow([
      envelope('tool.arguments_delta', { seq: 7, payload: { delta: '{"' } }),
      envelope('tool.arguments_delta', { seq: 8, payload: { delta: 'path' } }),
      envelope('tool.arguments_delta', { seq: 9, payload: { delta: '":"/tmp"' } }),
      envelope('tool.call_completed', { seq: 10 }),
    ]);

    expect(result.accepted).toBe(true);
    const tool = session.getSnapshot().toolCalls[0];
    expect(tool?.toolCallId).toBe('call-1');
    expect(tool?.argumentText).toBe('{"path":"/tmp"');
    expect(tool?.settled).toBe(true);
    expect(tool?.phase).toBe('completed');
    expect(tool?.result).toBe('ok');
    expect(tool?.outcome).toEqual({ outcome: 'success' });
  });
});

describe('RunSession adversarial: late replay after a terminal run', () => {
  it('keeps a completed run terminal when a late window fills the gap', () => {
    const session = newSession();
    session.acceptWindow([
      envelope('run.started', { seq: 1 }),
      envelope('turn.started', { seq: 2 }),
      // seq 3..9 are ephemeral events the Host omitted from the window.
      envelope('run.completed', { seq: 10 }),
    ]);
    expect(session.getSnapshot().run.status).toBe('completed');

    const before = session.getSnapshot();
    const listener = vi.fn();
    session.subscribe(listener);

    const result = session.acceptWindow([
      envelope('assistant.text_delta', { seq: 5, payload: { delta: 'mid' } }),
    ]);

    expect(result).toEqual({
      accepted: true,
      applied: 1,
      duplicates: 0,
      // A late admission must never walk the cursor backwards.
      lastAcceptedSeq: 10,
    });
    const snapshot = session.getSnapshot();
    // The rebuild re-runs every event in sequence order, so the terminal event
    // still lands last. An implementation that appended the replayed event
    // instead would revive the run and reopen the turn.
    expect(snapshot.run.status).toBe('completed');
    expect(snapshot.turns[0]?.phase).toBe('completed');
    expect(snapshot.currentTurn).toBeNull();
    expect(snapshot.messages[0]?.text).toBe('mid');
    expect(snapshot.timeline.map((item) => item.seq)).toEqual([1, 2, 5, 10]);
    expect(snapshot.revision).toBe(before.revision + 1);
    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenCalledWith(snapshot);
  });

  it('retires a replayed turn under a run failure that arrived first', () => {
    const session = newSession();

    // The failure is all the client has. In wall-clock time it is the newest
    // fact; in sequence order it is the OLDEST, so a late window must still be
    // projected underneath it.
    session.acceptWindow([envelope('run.failed', { seq: 10 })]);
    expect(session.getSnapshot().run.status).toBe('failed');
    expect(session.getSnapshot().turns).toEqual([]);

    const result = session.acceptWindow([
      envelope('run.started', { seq: 1 }),
      envelope('turn.started', { seq: 2 }),
      envelope('assistant.text_delta', { seq: 5, payload: { delta: 'partial' } }),
    ]);

    expect(result.accepted).toBe(true);
    const snapshot = session.getSnapshot();
    expect(snapshot.run.status).toBe('failed');
    expect(snapshot.run.error).toEqual({ code: 'internal', message: 'fixture' });
    expect(snapshot.turns).toHaveLength(1);
    // A turn cannot fail on its own evidence — it inherits the run's terminal
    // failure. Replaying `turn.started` must not leave it claiming to be live.
    expect(snapshot.turns[0]?.phase).toBe('failed');
    expect(snapshot.currentTurn).toBeNull();
    expect(snapshot.messages[0]?.text).toBe('partial');
  });

  it('retires a replayed retry instead of leaving the turn open', () => {
    const session = newSession();
    session.acceptWindow([envelope('run.completed', { seq: 10 })]);

    const result = session.acceptWindow([
      envelope('run.started', { seq: 1 }),
      envelope('turn.started', { seq: 2 }),
      envelope('turn.retry_scheduled', { seq: 5 }),
    ]);

    expect(result.accepted).toBe(true);
    const snapshot = session.getSnapshot();
    expect(snapshot.run.status).toBe('completed');
    expect(snapshot.turns).toHaveLength(1);
    // `retrying` is still open. A replay that ended here would show a live turn
    // on a finished run — exactly the ambiguity `turn.completed` exists to end.
    expect(snapshot.turns[0]?.phase).toBe('completed');
    expect(snapshot.turns[0]?.retry).toEqual({
      attempt: 1,
      maxAttempts: 3,
      delayMs: 500,
      reason: 'fixture',
    });
    expect(snapshot.currentTurn).toBeNull();
  });

  it('does not let a replayed delta overwrite an already-finalized message', () => {
    const session = newSession();
    session.acceptWindow([
      envelope('assistant.text_delta', { seq: 3, payload: { delta: 'he' } }),
      // The fixture finalizes with the text 'hello'.
      envelope('assistant.message_finalized', { seq: 7 }),
    ]);
    expect(session.getSnapshot().messages[0]?.text).toBe('hello');
    expect(session.getSnapshot().messages[0]?.finalized).toBe(true);

    const result = session.acceptWindow([
      envelope('assistant.text_delta', { seq: 5, payload: { delta: 'llo' } }),
    ]);

    expect(result.accepted).toBe(true);
    const message = session.getSnapshot().messages[0];
    // Replay order is 3, 5, 7: the delta appends, then the finalized block
    // replaces. Appending the late delta to the live model instead would print
    // the answer twice, which is the failure `finalized` exists to prevent.
    expect(message?.text).toBe('hello');
    expect(message?.finalized).toBe(true);
    expect(session.getSnapshot().timeline.map((item) => item.seq)).toEqual([3, 5, 7]);
  });
});

describe('RunSession adversarial: delta idempotence', () => {
  it('re-applies no delta from an overlapping replay window', () => {
    const session = newSession();
    const chunks = ['a', 'b', 'c', 'd', 'e'];
    for (const [index, chunk] of chunks.entries()) {
      session.apply(envelope('assistant.text_delta', { seq: index + 1, payload: { delta: chunk } }));
    }
    const before = session.getSnapshot();
    const listener = vi.fn();
    session.subscribe(listener);

    const result = session.acceptWindow([
      ...chunks.map((chunk, index) =>
        envelope('assistant.text_delta', { seq: index + 1, payload: { delta: chunk } }),
      ),
      envelope('assistant.text_delta', { seq: 6, payload: { delta: 'f' } }),
    ]);

    expect(result).toEqual({
      accepted: true,
      applied: 1,
      duplicates: 5,
      lastAcceptedSeq: 6,
    });
    const snapshot = session.getSnapshot();
    expect(snapshot.messages[0]?.text).toBe('abcdef');
    expect(snapshot.timeline.map((item) => item.seq)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(snapshot.revision).toBe(before.revision + 1);
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('orders late deltas into the gap instead of appending them', () => {
    const session = newSession();
    session.acceptWindow([
      envelope('assistant.text_delta', { seq: 1, payload: { delta: 'a' } }),
      envelope('assistant.text_delta', { seq: 7, payload: { delta: 'g' } }),
    ]);

    const result = session.acceptWindow([
      envelope('assistant.text_delta', { seq: 3, payload: { delta: 'c' } }),
      envelope('assistant.text_delta', { seq: 5, payload: { delta: 'e' } }),
    ]);

    expect(result).toEqual({
      accepted: true,
      applied: 2,
      duplicates: 0,
      lastAcceptedSeq: 7,
    });
    expect(session.getSnapshot().messages[0]?.text).toBe('aceg');
  });

  it('never doubles streamed tool arguments across an overlapping window', () => {
    const session = newSession();
    session.acceptWindow([
      envelope('tool.arguments_delta', { seq: 2, payload: { delta: '{"' } }),
      envelope('tool.arguments_delta', { seq: 3, payload: { delta: 'path' } }),
      envelope('tool.arguments_delta', { seq: 4, payload: { delta: '":"/tmp"' } }),
    ]);

    const result = session.acceptWindow([
      envelope('tool.arguments_delta', { seq: 3, payload: { delta: 'path' } }),
      envelope('tool.arguments_delta', { seq: 4, payload: { delta: '":"/tmp"' } }),
      envelope('tool.arguments_delta', { seq: 5, payload: { delta: '}' } }),
    ]);

    expect(result).toEqual({
      accepted: true,
      applied: 1,
      duplicates: 2,
      lastAcceptedSeq: 5,
    });
    // Streaming arguments are an append-only fold. One duplicated delta is one
    // corrupted JSON string in the tool row forever after.
    expect(session.getSnapshot().toolCalls[0]?.argumentText).toBe('{"path":"/tmp"}');
  });
});

describe('RunSession adversarial: immutable snapshot', () => {
  it('leaves an already published snapshot untouched', () => {
    const session = newSession();
    session.apply(envelope('assistant.text_delta', { seq: 1, payload: { delta: 'a' } }));
    const stale = session.getSnapshot();

    session.acceptWindow([
      envelope('assistant.text_delta', { seq: 2, payload: { delta: 'b' } }),
      envelope('assistant.text_delta', { seq: 3, payload: { delta: 'c' } }),
    ]);
    const current = session.getSnapshot();

    expect(current).not.toBe(stale);
    // A renderer that read `stale` must still be looking at revision 1, not a
    // view that grew underneath it between two of its own renders.
    expect(stale.messages[0]?.text).toBe('a');
    expect(stale.timeline).toHaveLength(1);
    expect(stale.revision).toBe(1);
    expect(current.messages[0]?.text).toBe('abc');
  });

  it('freezes every object reachable from a published snapshot', () => {
    const session = newSession();
    session.acceptWindow([
      envelope('run.started', { seq: 1 }),
      envelope('turn.started', { seq: 2 }),
      envelope('assistant.text_delta', { seq: 3, payload: { delta: 'hi' } }),
      envelope('assistant.usage', { seq: 4 }),
      envelope('assistant.mode_changed', { seq: 5 }),
      envelope('assistant.goal_updated', { seq: 6 }),
      envelope('assistant.status', { seq: 7 }),
      envelope('tool.call_started', { seq: 8, payload: { arguments: { path: '/tmp' } } }),
      envelope('permission.requested', { seq: 9, payload: { toolInput: { cmd: 'ls' } } }),
      envelope('permission.resolved', { seq: 10 }),
      envelope('checkpoint.saved', { seq: 11 }),
      envelope('compaction.started', { seq: 12 }),
      envelope('subagent.started', { seq: 13 }),
      envelope('hook.invoked', { seq: 14 }),
      envelope('diagnostic', { seq: 15 }),
      envelope('extension.custom', { seq: 16 }),
    ]);

    const unfrozen: string[] = [];
    unfrozenPaths(session.getSnapshot(), 'snapshot', unfrozen);
    expect(unfrozen).toEqual([]);
  });

  it('refuses in-place writes from a renderer', () => {
    const session = newSession();
    session.apply(envelope('assistant.text_delta', { seq: 1, payload: { delta: 'a' } }));
    const snapshot = session.getSnapshot();

    expect(() => {
      (snapshot as { revision: number }).revision = 999;
    }).toThrow(TypeError);
    expect(() => {
      (snapshot.messages[0] as { text: string }).text = 'tampered';
    }).toThrow(TypeError);
    expect(() => {
      (snapshot.timeline as unknown as unknown[]).push({ seq: 2, payload: {} });
    }).toThrow(TypeError);

    expect(session.getSnapshot().revision).toBe(1);
    expect(session.getSnapshot().messages[0]?.text).toBe('a');
    expect(session.getSnapshot().timeline).toHaveLength(1);
  });

  it('clones at admission so a caller cannot rewrite history afterwards', () => {
    const session = newSession();
    const source = envelope('assistant.text_delta', { seq: 2, payload: { delta: 'b' } });
    session.apply(source);

    // The caller still holds the object it passed in. Reusing a buffer is the
    // normal shape of a hot replay path, and it must not reach the model.
    (source.payload as { delta: string }).delta = 'MUTATED';
    expect(session.getSnapshot().messages[0]?.text).toBe('b');

    // The stored events have to survive a rebuild too, or a late replay would
    // silently replay a caller's later edits.
    session.apply(envelope('assistant.text_delta', { seq: 1, payload: { delta: 'a' } }));
    expect(session.getSnapshot().messages[0]?.text).toBe('ab');
    expect(session.getSnapshot().timeline[0]?.payload).toMatchObject({ delta: 'a' });
  });
});

describe('RunSession adversarial: atomic rejection', () => {
  it('admits nothing when one envelope in the window belongs to another run', () => {
    const session = newSession();
    const before = session.getSnapshot();
    const listener = vi.fn();
    session.subscribe(listener);

    const result = session.acceptWindow([
      envelope('assistant.text_delta', { seq: 10, payload: { delta: 'x' } }),
      forRun('run-foreign', envelope('assistant.text_delta', { seq: 11, payload: { delta: 'y' } })),
    ]);

    expect(result).toEqual({ accepted: false, reason: 'wrong_run' });
    expect(session.getSnapshot()).toBe(before);
    expect(listener).not.toHaveBeenCalled();

    // The valid prefix was not consumed: the cursor still owns seq 10.
    expect(
      session.apply(envelope('assistant.text_delta', { seq: 10, payload: { delta: 'x' } })).status,
    ).toBe('applied');
    expect(session.getSnapshot().messages[0]?.text).toBe('x');
    expect(session.getSnapshot().timeline.map((item) => item.seq)).toEqual([10]);
  });

  it('admits nothing when one envelope in the window breaks ordering', () => {
    const session = newSession();
    session.apply(envelope('assistant.text_delta', { seq: 1, payload: { delta: 'a' } }));
    const before = session.getSnapshot();

    const result = session.acceptWindow([
      envelope('assistant.text_delta', { seq: 4, payload: { delta: 'x' } }),
      envelope('assistant.text_delta', { seq: 3, payload: { delta: 'y' } }),
    ]);

    expect(result).toEqual({ accepted: false, reason: 'unordered' });
    expect(session.getSnapshot()).toBe(before);

    // 'x' never reached the model: a partially applied window would have made
    // this text 'ax' already.
    expect(
      session.apply(envelope('assistant.text_delta', { seq: 4, payload: { delta: 'x' } })).status,
    ).toBe('applied');
    expect(session.getSnapshot().messages[0]?.text).toBe('ax');
  });

  it('admits nothing when one envelope in the window has an unusable seq', () => {
    const unusable: readonly number[] = [0, -1, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER + 1];

    for (const seq of unusable) {
      const session = newSession();
      const before = session.getSnapshot();

      const result = session.acceptWindow([
        envelope('assistant.text_delta', { seq: 5, payload: { delta: 'x' } }),
        { ...envelope('assistant.text_delta', { seq: 5, payload: { delta: 'y' } }), seq },
      ]);

      expect(result).toEqual({ accepted: false, reason: 'invalid_seq' });
      expect(session.getSnapshot()).toBe(before);
      // The whole window is still admissible, prefix included.
      expect(
        session.apply(envelope('assistant.text_delta', { seq: 5, payload: { delta: 'x' } })).status,
      ).toBe('applied');
    }
  });

  it('refuses a window from another session without touching state', () => {
    const session = newSession();
    const before = session.getSnapshot();

    const result = session.acceptWindow([
      envelope('assistant.text_delta', { seq: 1, payload: { delta: 'x' } }),
      { ...envelope('assistant.text_delta', { seq: 2, payload: { delta: 'y' } }), sessionId: 'other' },
    ]);

    expect(result).toEqual({ accepted: false, reason: 'wrong_session' });
    expect(session.getSnapshot()).toBe(before);
  });

  it('keeps a committed window committed when a subscriber throws', () => {
    const session = newSession();
    const failing = vi.fn(() => {
      throw new Error('subscriber failed');
    });
    const following = vi.fn();
    session.subscribe(failing);
    session.subscribe(following);

    expect(() =>
      session.acceptWindow([
        envelope('assistant.text_delta', { seq: 1, payload: { delta: 'a' } }),
        envelope('assistant.text_delta', { seq: 2, payload: { delta: 'b' } }),
      ]),
    ).toThrow('subscriber failed');

    // The window is atomic with respect to ADMISSION, not with respect to
    // observers: a broken renderer must not un-admit durable events.
    expect(following).toHaveBeenCalledTimes(1);
    expect(session.getSnapshot().messages[0]?.text).toBe('ab');
    expect(
      session.acceptWindow([
        envelope('assistant.text_delta', { seq: 1, payload: { delta: 'a' } }),
        envelope('assistant.text_delta', { seq: 2, payload: { delta: 'b' } }),
      ]),
    ).toEqual({ accepted: true, applied: 0, duplicates: 2, lastAcceptedSeq: 2 });
    expect(following).toHaveBeenCalledTimes(1);
  });
});

describe('RunSession adversarial: two-run isolation', () => {
  it('refuses a foreign run envelope in both directions', () => {
    const alpha = newSession('run-alpha');
    const beta = newSession('run-beta');
    const alphaBefore = alpha.getSnapshot();
    const betaBefore = beta.getSnapshot();

    const foreignForAlpha = envelope('assistant.text_delta', { seq: 1, payload: { delta: 'x' } });
    const foreignForBeta = envelope('assistant.text_delta', { seq: 1, payload: { delta: 'y' } });

    expect(alpha.apply(forRun('run-beta', foreignForAlpha)).status).toBe('wrong_run');
    expect(beta.apply(forRun('run-alpha', foreignForBeta)).status).toBe('wrong_run');
    expect(alpha.getSnapshot()).toBe(alphaBefore);
    expect(beta.getSnapshot()).toBe(betaBefore);
  });

  it('keeps identical seq values from two runs in separate surfaces', () => {
    // `RunEventEnvelope.seq` is unique per (runId, seq). A resumed run restarts
    // at 1, so two live runs in one session WILL collide on every seq value and
    // that is not an error to be deduplicated.
    const alpha = newSession('run-alpha');
    const beta = newSession('run-beta');
    const alphaListener = vi.fn();
    const betaListener = vi.fn();
    alpha.subscribe(alphaListener);
    beta.subscribe(betaListener);

    const alphaResult = alpha.acceptWindow([
      forRun('run-alpha', envelope('run.started', { seq: 1 })),
      forRun('run-alpha', envelope('assistant.text_delta', { seq: 5, payload: { delta: 'alpha' } })),
      forRun('run-alpha', envelope('tool.call_started', { seq: 9, payload: { toolCallId: 'call-alpha' } })),
    ]);
    const betaResult = beta.acceptWindow([
      forRun('run-beta', envelope('run.started', { seq: 1 })),
      forRun('run-beta', envelope('assistant.text_delta', { seq: 5, payload: { delta: 'beta' } })),
      forRun('run-beta', envelope('tool.call_started', { seq: 9, payload: { toolCallId: 'call-beta' } })),
    ]);

    expect(alphaResult).toEqual({
      accepted: true,
      applied: 3,
      duplicates: 0,
      lastAcceptedSeq: 9,
    });
    expect(betaResult).toEqual({
      accepted: true,
      applied: 3,
      duplicates: 0,
      lastAcceptedSeq: 9,
    });
    expect(alpha.getSnapshot().messages[0]?.text).toBe('alpha');
    expect(beta.getSnapshot().messages[0]?.text).toBe('beta');
    expect(alpha.getSnapshot().toolCalls[0]?.toolCallId).toBe('call-alpha');
    expect(beta.getSnapshot().toolCalls[0]?.toolCallId).toBe('call-beta');
    expect(alpha.getSnapshot().run.runId).toBe('run-alpha');
    expect(beta.getSnapshot().run.runId).toBe('run-beta');
    expect(alphaListener).toHaveBeenCalledTimes(1);
    expect(betaListener).toHaveBeenCalledTimes(1);
  });

  it('does not let a rebuild in one run disturb the other run', () => {
    const alpha = newSession('run-alpha');
    const beta = newSession('run-beta');
    const alphaListener = vi.fn();
    alpha.subscribe(alphaListener);
    beta.subscribe(vi.fn());

    alpha.acceptWindow([
      forRun('run-alpha', envelope('run.started', { seq: 1 })),
      forRun('run-alpha', envelope('assistant.text_delta', { seq: 5, payload: { delta: 'alpha' } })),
      forRun('run-alpha', envelope('assistant.text_delta', { seq: 9, payload: { delta: '!' } })),
    ]);
    beta.acceptWindow([
      forRun('run-beta', envelope('run.started', { seq: 1 })),
      forRun('run-beta', envelope('assistant.text_delta', { seq: 5, payload: { delta: 'beta' } })),
      forRun('run-beta', envelope('assistant.text_delta', { seq: 9, payload: { delta: '?' } })),
    ]);
    const betaBefore = beta.getSnapshot();

    // Filling a gap in alpha forces a full projection rebuild of alpha only.
    const result = alpha.acceptWindow([
      forRun('run-alpha', envelope('assistant.text_delta', { seq: 3, payload: { delta: 'A-' } })),
    ]);

    expect(result).toEqual({
      accepted: true,
      applied: 1,
      duplicates: 0,
      lastAcceptedSeq: 9,
    });
    expect(alpha.getSnapshot().messages[0]?.text).toBe('A-alpha!');
    expect(alphaListener).toHaveBeenCalledTimes(2);

    expect(beta.getSnapshot()).toBe(betaBefore);
    expect(beta.getSnapshot().messages[0]?.text).toBe('beta?');
    expect(beta.getSnapshot().timeline.map((item) => item.seq)).toEqual([1, 5, 9]);
    expect(beta.getSnapshot().revision).toBe(1);
  });
});

describe('RunSession adversarial: hostile or duplicated Host events', () => {
  it('consumes an ephemeral trace cursor without retaining the trace', () => {
    const session = newSession();

    session.apply(envelope('assistant.text_delta', { seq: 5, payload: { delta: 'a' } }));
    const result = session.acceptWindow([envelope('diagnostic.trace', { seq: 7 })]);

    // The cursor is real — it must not be re-admitted later as if it never
    // arrived — but the span itself must not survive into a rebuild.
    expect(result).toEqual({
      accepted: true,
      applied: 1,
      duplicates: 0,
      lastAcceptedSeq: 7,
    });
    const snapshot = session.getSnapshot();
    expect(snapshot.timeline.map((item) => item.seq)).toEqual([5]);
    expect(JSON.stringify(snapshot)).not.toContain('trace-1');
    expect(session.apply(envelope('diagnostic.trace', { seq: 7 })).status).toBe('duplicate');
  });

  it('does not emit two rows for one turn announced twice', () => {
    const session = newSession();

    // The runtime mints one `turn.started` per turn, so this only happens when
    // a Host re-announces a turn under a fresh seq (a reconnect that re-runs the
    // preamble, a hand-rolled shim). Admission is correct — both envelopes are
    // retained — but the projection must still be one row per turnId, the way
    // `turn.completed` and `turn.retry_scheduled` both already are.
    const result = session.acceptWindow([
      envelope('turn.started', { seq: 1, payload: { turnId: 'turn-dup' } }),
      envelope('turn.started', { seq: 4, payload: { turnId: 'turn-dup' } }),
    ]);

    expect(result).toEqual({
      accepted: true,
      applied: 2,
      duplicates: 0,
      lastAcceptedSeq: 4,
    });
    expect(session.getSnapshot().timeline.map((item) => item.seq)).toEqual([1, 4]);
    expect(session.getSnapshot().turns).toHaveLength(1);
    expect(session.getSnapshot().turns[0]?.turnId).toBe('turn-dup');

    // The duplicate row also survives a rebuild, so this is not a transient
    // artifact of the forward apply path. seq 3 is unseen and below the cursor,
    // so admitting it forces a full projection rebuild.
    session.apply(envelope('assistant.text_delta', { seq: 3, payload: { delta: 'x' } }));
    expect(session.getSnapshot().revision).toBe(2);
    expect(session.getSnapshot().turns).toHaveLength(1);
  });
});
