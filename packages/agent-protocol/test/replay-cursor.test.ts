/**
 * T3.3 — the cursor is scoped, and the window is stated in sequence numbers.
 *
 * The properties under test are the ones a host depends on to decide whether to
 * re-read or to give up: a cursor round-trips, a bare number does not, a foreign
 * run is refused, and "some events are missing" is never an answer because a
 * window boundary is always computable.
 */

import { describe, expect, it } from 'vitest';
import {
  EMPTY_WINDOW,
  FIRST_EPOCH,
  decodeReplayCursor,
  encodeReplayCursor,
  isWithinWindow,
  refuseForeignCursor,
  replayWindow,
  startOfRun,
  type ReplayCursor,
} from '../src/replay.js';

const RUN = 'run-1';

describe('a cursor carries its run and epoch, both ways', () => {
  it('round-trips through the Last-Event-ID string form', () => {
    const cursor: ReplayCursor = { runId: RUN, epoch: 2, afterSeq: 41 };
    expect(decodeReplayCursor(encodeReplayCursor(cursor))).toEqual(cursor);
  });

  it('is NOT a bare number, and refuses to decode one', () => {
    // This is the wire defect the field exists to end: a bare seq cannot say
    // which run it belongs to, so decoding one would have to invent a runId.
    const encoded = encodeReplayCursor({ runId: RUN, epoch: 1, afterSeq: 7 });
    expect(encoded).not.toBe('7');
    expect(decodeReplayCursor('7')).toBeNull();
    expect(decodeReplayCursor('')).toBeNull();
    expect(decodeReplayCursor(undefined)).toBeNull();
    expect(decodeReplayCursor(null)).toBeNull();
  });

  it('refuses to encode a runId carrying the separator', () => {
    // Otherwise it would decode as a DIFFERENT run than the one it came from,
    // which is exactly the cross-run confusion the field prevents.
    expect(() => encodeReplayCursor({ runId: 'a.1', epoch: 1, afterSeq: 0 })).toThrow(TypeError);
    expect(() => encodeReplayCursor({ runId: 'a#1', epoch: 1, afterSeq: 0 })).toThrow(TypeError);
    expect(decodeReplayCursor('v1.a.1.1.0')).toBeNull();
  });

  it('refuses an epoch below the first, and a negative seq', () => {
    expect(() => encodeReplayCursor({ runId: RUN, epoch: 0, afterSeq: 0 })).toThrow(RangeError);
    expect(() => encodeReplayCursor({ runId: RUN, epoch: 1, afterSeq: -1 })).toThrow(RangeError);
    expect(decodeReplayCursor('v1.run-1.0.0')).toBeNull();
    expect(decodeReplayCursor('v1.run-1.1.-3')).toBeNull();
  });

  it('refuses a version it does not speak', () => {
    expect(decodeReplayCursor('v2.run-1.1.0')).toBeNull();
  });
});

describe('a cursor from another run or another epoch is refused, not repaired', () => {
  it('names the run mismatch first', () => {
    const cursor: ReplayCursor = { runId: 'run-2', epoch: 3, afterSeq: 0 };
    // Epoch is also wrong here, and the RUN is what gets reported: telling a
    // host to advance its epoch cannot help when the whole run is foreign.
    expect(refuseForeignCursor(cursor, { runId: RUN, epoch: 1 })).toBe('cursor_run_mismatch');
  });

  it('reports an epoch mismatch within the right run', () => {
    const cursor: ReplayCursor = { runId: RUN, epoch: 2, afterSeq: 0 };
    expect(refuseForeignCursor(cursor, { runId: RUN, epoch: 1 })).toBe('cursor_epoch_mismatch');
  });

  it('admits a cursor that matches both', () => {
    expect(refuseForeignCursor({ runId: RUN, epoch: 1, afterSeq: 9 }, { runId: RUN, epoch: 1 })).toBeNull();
  });

  it('starts a run at epoch 1 with nothing seen', () => {
    expect(startOfRun(RUN)).toEqual({ runId: RUN, epoch: FIRST_EPOCH, afterSeq: 0 });
  });
});

describe('the window is stated in seqs, and is sparse', () => {
  it('reports the non-durable tail rather than implying the run ended', () => {
    // Durable at 1..10, but the run has minted through 14 — the last four being
    // volatile/ephemeral. `latest` alone would say "you are current at 10",
    // which is a different claim from "the run is at 14".
    const window = replayWindow({ oldest: 1, latest: 10, count: 10, mintedLatest: 14 });
    expect(window.oldest).toBe(1);
    expect(window.latest).toBe(10);
    expect(window.mintedLatest).toBe(14);
    expect(window.count).toBe(10);
    expect(window.sparse).toBe(false);
  });

  it('calls a window with holes sparse, and says so', () => {
    const window = replayWindow({ oldest: 2, latest: 9, count: 5, mintedLatest: 9 });
    expect(window.sparse).toBe(true);
    expect(window.latest - window.oldest + 1).not.toBe(window.count);
  });

  it('does not call an empty or single-event window sparse', () => {
    expect(replayWindow({ oldest: 0, latest: 0, count: 0, mintedLatest: 3 }).sparse).toBe(false);
    expect(replayWindow({ oldest: 4, latest: 4, count: 1, mintedLatest: 4 }).sparse).toBe(false);
  });

  it('never reports a mintedLatest below the durable latest', () => {
    const window = replayWindow({ oldest: 1, latest: 8, count: 3, mintedLatest: 2 });
    expect(window.mintedLatest).toBe(8);
  });

  it('defaults mintedLatest to the durable latest for a store that cannot tell', () => {
    expect(replayWindow({ oldest: 1, latest: 6, count: 2 }).mintedLatest).toBe(6);
  });

  it('serves a fresh cursor against a run that has minted nothing', () => {
    // Nothing is missing, so this is a legitimate empty replay, not a failure.
    expect(isWithinWindow(startOfRun(RUN), EMPTY_WINDOW)).toBe(true);
    expect(EMPTY_WINDOW.sparse).toBe(false);
    expect(EMPTY_WINDOW.count).toBe(0);
  });

  it('refuses EVERY cursor when the store is empty but the run has minted', () => {
    // The dangerous one: no durable row landed for a run at seq 25. Serving the
    // cursor would hand back an empty list and claim the consumer is current —
    // a silent hole across the entire run.
    const lostEverything = replayWindow({ oldest: 0, latest: 0, count: 0, mintedLatest: 25 });
    expect(isWithinWindow({ runId: RUN, epoch: 1, afterSeq: 0 }, lostEverything)).toBe(false);
    expect(isWithinWindow({ runId: RUN, epoch: 1, afterSeq: 10 }, lostEverything)).toBe(false);
  });
});

describe('window membership, including the case that is not a failure', () => {
  const window = replayWindow({ oldest: 10, latest: 20, count: 6, mintedLatest: 25 });

  it('serves a cursor at or after the oldest durable seq', () => {
    expect(isWithinWindow({ runId: RUN, epoch: 1, afterSeq: 10 }, window)).toBe(true);
    expect(isWithinWindow({ runId: RUN, epoch: 1, afterSeq: 15 }, window)).toBe(true);
  });

  it('treats a cursor past the durable latest as UP TO DATE, not as an error', () => {
    // 21..25 were minted but are not durable. A consumer holding 20 is current
    // as far as replay is concerned and must be handed live events, not a
    // failure it would have to fabricate an excuse for.
    expect(isWithinWindow({ runId: RUN, epoch: 1, afterSeq: 20 }, window)).toBe(true);
    expect(isWithinWindow({ runId: RUN, epoch: 1, afterSeq: 25 }, window)).toBe(true);
  });

  it('serves a consumer holding exactly oldest-1, which is missing only oldest', () => {
    // It is the store's lowest durable seq, and it is still there. Refusing
    // here would force a consumer that lost nothing into a resync.
    expect(isWithinWindow({ runId: RUN, epoch: 1, afterSeq: 9 }, window)).toBe(true);
  });

  it('refuses a cursor that has aged out below the window', () => {
    // 9 is below the oldest durable seq (10), so seq 9 is gone for good.
    expect(isWithinWindow({ runId: RUN, epoch: 1, afterSeq: 8 }, window)).toBe(false);
    expect(isWithinWindow({ runId: RUN, epoch: 1, afterSeq: 0 }, window)).toBe(false);
  });

  it('refuses a cursor past what the run has ever minted', () => {
    expect(isWithinWindow({ runId: RUN, epoch: 1, afterSeq: 26 }, window)).toBe(false);
  });
});
