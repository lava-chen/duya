/**
 * workflow-store.test.ts — plan 560 D5: the run-anchored journal merge.
 *
 * `mergeRunEvents` is the whole "no lost / no duplicated frame" story: the live
 * SSE stream and the durable backfill legitimately overlap, and both can arrive
 * out of order. Pure function, so no DOM or store scaffolding is needed.
 */

import { describe, expect, it } from 'vitest';
import { mergeRunEvents, type WorkflowRunStreamEntry } from './workflow-store';

function rec(seq: number, nodeId = `n${seq}`): Record<string, unknown> {
  return { seq, kind: 'node_result', nodeId, attempt: 1, status: 'succeeded', atMs: seq };
}

describe('mergeRunEvents (plan 560 D5)', () => {
  it('collapses a backfill that overlaps what the live stream already sent', () => {
    const live = [rec(0), rec(1), rec(2)] as never[];
    // The client asked for `afterSeq=1`, so the server replays 2 — already held.
    const backfill = [rec(2), rec(3)] as never[];

    const { events, added } = mergeRunEvents(live, backfill);
    expect(added).toBe(1);
    expect(events.map((e) => e.seq)).toEqual([0, 1, 2, 3]);
  });

  it('sorts ascending even when a source arrives out of order', () => {
    const { events } = mergeRunEvents([], [rec(5), rec(1), rec(3)] as never[]);
    expect(events.map((e) => e.seq)).toEqual([1, 3, 5]);
  });

  it('drops records without a numeric seq — they cannot be ordered', () => {
    const { events, added } = mergeRunEvents([], [
      { kind: 'node_result', nodeId: 'no-seq' },
      null,
      'not-a-record',
      rec(0),
    ] as never[]);
    expect(added).toBe(1);
    expect(events.map((e) => e.seq)).toEqual([0]);
  });

  it('keeps the first copy of a seq rather than double-applying a step', () => {
    const first = { ...rec(4), status: 'running' } as never;
    const second = { ...rec(4), status: 'succeeded' } as never;
    const { events } = mergeRunEvents([first], [second] as never[]);
    expect(events).toHaveLength(1);
    expect((events[0] as unknown as { status: string }).status).toBe('running');
  });

  it('does not mutate the array it was handed', () => {
    const prev = [rec(0)] as never[];
    mergeRunEvents(prev, [rec(1)] as never[]);
    expect((prev as unknown[]).length).toBe(1);
  });

  it('handles empty inputs on both sides', () => {
    expect(mergeRunEvents([], []).events).toEqual([]);
    expect(mergeRunEvents([rec(1)] as never[], []).added).toBe(0);
  });
});

describe('WorkflowRunStreamEntry shape', () => {
  it('starts unloaded with a -1 cursor', () => {
    // The type is the contract the panel renders from; this pins the defaults
    // the seed path is expected to produce for a run with no events at all.
    const entry: WorkflowRunStreamEntry = {
      runId: 'r1',
      record: null,
      events: [],
      artifacts: [],
      summary: null,
      pendingPermission: null,
      loaded: true,
      live: false,
      error: null,
      lastSeq: -1,
    };
    expect(entry.loaded).toBe(true);
    expect(entry.lastSeq).toBe(-1);
  });
});
