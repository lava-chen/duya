import { describe, expect, it, vi } from 'vitest';
import { RunSession } from '../src/session/run-session.js';
import { envelope, RUN_ID, SESSION_ID } from '../src/testing/index.js';

function text(seq: number, delta: string) {
  return envelope('assistant.text_delta', {
    seq,
    payload: { messageId: 'message-1', delta },
  });
}

describe('RunSession', () => {
  it('admits sparse Host-ordered windows without inferring a missing sequence', () => {
    const session = new RunSession({ runId: RUN_ID, sessionId: SESSION_ID });
    const result = session.acceptWindow([text(2, 'a'), text(5, 'b')]);

    expect(result).toEqual({
      accepted: true,
      applied: 2,
      duplicates: 0,
      lastAcceptedSeq: 5,
    });
    expect(session.getSnapshot().lastAcceptedSeq).toBe(5);
    expect(session.getSnapshot().messages[0]?.text).toBe('ab');
  });

  it('keeps duplicate admission idempotent and preserves the stable snapshot', () => {
    const session = new RunSession({ runId: RUN_ID, sessionId: SESSION_ID });
    const first = text(3, 'hello');
    expect(session.apply(first).status).toBe('applied');
    const snapshot = session.getSnapshot();

    expect(session.apply(first)).toEqual({ status: 'duplicate', seq: 3 });
    expect(session.getSnapshot()).toBe(snapshot);
    expect(session.getSnapshot().revision).toBe(1);
    expect(session.getSnapshot().messages[0]?.text).toBe('hello');
  });

  it('notifies remaining subscribers when one subscriber throws', () => {
    const session = new RunSession({ runId: RUN_ID, sessionId: SESSION_ID });
    const failing = vi.fn(() => {
      throw new Error('subscriber failed');
    });
    const following = vi.fn();
    session.subscribe(failing);
    session.subscribe(following);

    expect(() => session.apply(text(1, 'accepted'))).toThrow('subscriber failed');
    expect(following).toHaveBeenCalledWith(session.getSnapshot());
    expect(session.getSnapshot().messages[0]?.text).toBe('accepted');
  });

  it('rejects envelopes from another run or session without changing state', () => {
    const session = new RunSession({ runId: RUN_ID, sessionId: SESSION_ID });
    const snapshot = session.getSnapshot();

    expect(session.apply({ ...text(1, 'wrong run'), runId: 'other-run' }).status).toBe('wrong_run');
    expect(session.apply({ ...text(1, 'wrong session'), sessionId: 'other-session' }).status).toBe(
      'wrong_session',
    );
    expect(session.getSnapshot()).toBe(snapshot);
  });

  it('rebuilds in sequence order when replay supplies unseen older events', () => {
    const session = new RunSession({ runId: RUN_ID, sessionId: SESSION_ID });
    expect(session.apply(text(3, ' world')).status).toBe('applied');
    const listener = vi.fn();
    session.subscribe(listener);

    const result = session.acceptWindow([text(1, 'hello'), text(2, '!')]);

    expect(result).toEqual({ accepted: true, applied: 2, duplicates: 0, lastAcceptedSeq: 3 });
    const snapshot = session.getSnapshot();
    expect(snapshot.messages[0]?.text).toBe('hello! world');
    expect(snapshot.timeline.map((item) => item.seq)).toEqual([1, 2, 3]);
    expect(snapshot.timeline.map((item) => item.payload.type)).toEqual([
      'assistant.text_delta',
      'assistant.text_delta',
      'assistant.text_delta',
    ]);
    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenCalledWith(snapshot);
  });

  it('accepts an overlapping replay window without applying delta payloads twice', () => {
    const session = new RunSession({ runId: RUN_ID, sessionId: SESSION_ID });
    session.apply(text(1, 'a'));
    session.apply(text(3, 'c'));

    const result = session.acceptWindow([text(1, 'a'), text(2, 'b'), text(3, 'c')]);

    expect(result).toEqual({ accepted: true, applied: 1, duplicates: 2, lastAcceptedSeq: 3 });
    expect(session.getSnapshot().messages[0]?.text).toBe('abc');
    expect(session.getSnapshot().timeline.map((item) => item.seq)).toEqual([1, 2, 3]);
  });

  it('admits ephemeral trace cursors without retaining traces across replay rebuilds', () => {
    const session = new RunSession({ runId: RUN_ID, sessionId: SESSION_ID });
    session.apply(text(3, 'c'));
    const trace = envelope('diagnostic.trace', {
      seq: 1,
      payload: { traceId: 'trace-private', name: 'transient' },
    });

    const result = session.acceptWindow([trace, text(2, 'b')]);

    expect(result).toEqual({ accepted: true, applied: 2, duplicates: 0, lastAcceptedSeq: 3 });
    const snapshot = session.getSnapshot();
    expect(snapshot.messages[0]?.text).toBe('bc');
    expect(snapshot.timeline.map((item) => item.seq)).toEqual([2, 3]);
    expect(JSON.stringify(snapshot)).not.toContain('trace-private');
    expect(snapshot.diagnostics).toEqual([]);

    const traceOnly = new RunSession({ runId: RUN_ID, sessionId: SESSION_ID });
    traceOnly.apply(envelope('diagnostic.trace', {
      seq: 4,
      payload: { traceId: 'trace-private', name: 'transient' },
    }));
    expect(traceOnly.getSnapshot().lastAcceptedSeq).toBe(4);
    expect(traceOnly.getSnapshot().timeline).toEqual([]);
    expect(JSON.stringify(traceOnly.getSnapshot())).not.toContain('trace-private');
  });

  it('reconnects with the confirmed cursor and lands on the projection live delivery would have', () => {
    // The plan's fourth evidence, in the only form that has teeth. A test that
    // only inspects the BACKFILLED result passes just as happily when the live
    // path is the broken one, so the live path is the control group: one
    // transcript, two delivery routes, one projection.
    //
    // The window is deliberately SPARSE (seq 1 then 5). This protocol drops
    // ephemeral events, so sparse windows are the normal case, and sparsity is
    // also what separates the two plausible readings of the cursor: "highest
    // confirmed seq" and "how many events I have seen" agree on a dense window
    // and disagree here. Without it this case could not tell them apart.
    const transcript = [
      envelope('run.started', { seq: 1 }),
      envelope('turn.started', { seq: 5, payload: { turnId: 'turn-1', index: 0 } }),
      text(6, 'he'),
      text(9, 'llo'),
      envelope('turn.completed', { seq: 12, payload: { turnId: 'turn-1', index: 0 } }),
    ];
    // A Host that only ever answers "everything after this seq". The cursor is
    // the client's choice, so a wrong cursor turns into a duplicate or a gap
    // rather than into a quietly wrong projection.
    const host = (afterSeq: number) => transcript.filter((event) => event.seq > afterSeq);

    const live = new RunSession({ runId: RUN_ID, sessionId: SESSION_ID });
    for (const event of transcript) live.apply(event);

    const reconnecting = new RunSession({ runId: RUN_ID, sessionId: SESSION_ID });
    expect(reconnecting.acceptWindow(host(0).slice(0, 2))).toEqual({
      accepted: true,
      applied: 2,
      duplicates: 0,
      lastAcceptedSeq: 5,
    });
    const cursor = reconnecting.getSnapshot().lastAcceptedSeq;
    expect(cursor).toBe(5);

    const result = reconnecting.acceptWindow(host(cursor));
    expect(result).toEqual({ accepted: true, applied: 3, duplicates: 0, lastAcceptedSeq: 12 });

    const viaLive = live.getSnapshot();
    const viaReconnect = reconnecting.getSnapshot();
    for (const field of ['run', 'turns', 'currentTurn', 'toolCalls', 'messages', 'timeline'] as const) {
      expect(viaReconnect[field]).toEqual(viaLive[field]);
    }
    expect(viaReconnect.lastAcceptedSeq).toBe(viaLive.lastAcceptedSeq);
    expect(viaReconnect.messages[0]?.text).toBe('hello');

    // A backfill is ONE publish, not one per recovered event: a reconnect must
    // not cost every subscriber a render per event it did not lose.
    expect(viaReconnect.revision).toBe(2);
  });

  it('rejects unordered windows atomically and exposes deeply frozen snapshots', () => {
    const session = new RunSession({ runId: RUN_ID, sessionId: SESSION_ID });
    const result = session.acceptWindow([text(4, 'later'), text(2, 'earlier')]);

    expect(result).toEqual({ accepted: false, reason: 'unordered' });
    expect(session.getSnapshot().revision).toBe(0);
    expect(session.getSnapshot().timeline).toHaveLength(0);

    session.apply(text(1, 'frozen'));
    const snapshot = session.getSnapshot();
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.messages)).toBe(true);
    expect(Object.isFrozen(snapshot.messages[0])).toBe(true);
    expect(Object.isFrozen(snapshot.timeline[0]?.payload)).toBe(true);
  });
});
