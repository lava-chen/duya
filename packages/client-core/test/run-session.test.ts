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
