/**
 * D7.1 — a user branching off an old message.
 *
 * ## What the branch must NOT do
 *
 * It must not mutate the original. That is the whole claim, and it is easy to
 * state and easy to get wrong: a fork that renumbers the parent's `seq`, or
 * appends the child's first events under the parent's `runId`, or reuses the
 * parent's id, destroys history rather than branching from it.
 *
 * So this file asserts the parent is byte-identical before and after. It does
 * that by holding a deep copy taken BEFORE the branch and comparing the
 * parent's own envelope list against it afterwards — not by asserting the
 * parent "looks right", which a mutation could still satisfy.
 *
 * ## Why the child's events are RENUMBERED
 *
 * The log is keyed on `(runId, seq)`, and a run's `seq` is minted gapless from
 * 1. A child that inherited the parent's absolute numbers would start its own
 * first event at whatever number the parent had reached, and the gap would read
 * as lost events. `inheritedFromSeq` is what keeps the provenance legible after
 * the renumbering.
 */

import { describe, expect, it } from 'vitest';
import type { RunEventEnvelope } from '@duya/agent-protocol';
import { planBranch } from '../src/checkpoint/branch-plan.js';

function envelope(seq: number, runId: string, type: string): RunEventEnvelope {
  return {
    runId,
    sessionId: 'sess-1',
    seq,
    timestamp: 1000 + seq,
    traceId: `trace-${runId}`,
    payload: { type } as never,
  };
}

const PARENT = 'run-parent';
const CHILD = 'run-child';

function parentEvents(): RunEventEnvelope[] {
  return [
    envelope(1, PARENT, 'run.started'),
    envelope(2, PARENT, 'assistant.status'),
    envelope(3, PARENT, 'tool.call_started'),
    envelope(4, PARENT, 'tool.call_completed'),
    envelope(5, PARENT, 'run.completed'),
  ];
}

describe('a branch is a NEW RUN carrying a parentRunId', () => {
  it('mints a new runId and records the parent, never reusing the parent id', () => {
    const result = planBranch({
      parentRunId: PARENT,
      sessionId: 'sess-1',
      newRunId: CHILD,
      parentEvents: parentEvents(),
      atSeq: 3,
      parentTerminated: true,
    });
    if (result.kind !== 'branched') throw new Error(`refused: ${result.code}`);
    expect(result.plan.runId).toBe(CHILD);
    expect(result.plan.runId).not.toBe(PARENT);
    expect(result.plan.parentRunId).toBe(PARENT);
    // The fork point is recorded, so the branch is legible from its own row.
    expect(result.plan.forkedFromSeq).toBe(3);
  });

  it('does not mutate the parent — the original is byte-identical afterwards', () => {
    const events = parentEvents();
    // A deep copy taken BEFORE the branch. Comparing the parent against this
    // afterwards is what makes "not mutated" a measurement rather than a hope.
    const before = JSON.parse(JSON.stringify(events)) as RunEventEnvelope[];

    const result = planBranch({
      parentRunId: PARENT,
      sessionId: 'sess-1',
      newRunId: CHILD,
      parentEvents: events,
      atSeq: 3,
      parentTerminated: true,
    });
    if (result.kind !== 'branched') throw new Error(`refused: ${result.code}`);

    expect(events).toEqual(before);
    // Nothing was appended to the parent either: still exactly five events,
    // still the parent's own runId on every one of them.
    expect(events).toHaveLength(5);
    expect(events.every((e) => e.runId === PARENT)).toBe(true);
  });

  it('inherits only the prefix up to the fork point', () => {
    const result = planBranch({
      parentRunId: PARENT,
      sessionId: 'sess-1',
      newRunId: CHILD,
      parentEvents: parentEvents(),
      atSeq: 3,
      parentTerminated: true,
    });
    if (result.kind !== 'branched') throw new Error(`refused: ${result.code}`);
    // Three inherited, and the events AFTER the fork point are not carried —
    // this is what "branch from here" means.
    expect(result.plan.events).toHaveLength(3);
    expect(result.plan.events.map((e) => e.inheritedFromSeq)).toEqual([1, 2, 3]);
  });

  it('renumbers into the child own seq space and keeps the provenance', () => {
    const result = planBranch({
      parentRunId: PARENT,
      sessionId: 'sess-1',
      newRunId: CHILD,
      parentEvents: parentEvents(),
      atSeq: 3,
      parentTerminated: true,
    });
    if (result.kind !== 'branched') throw new Error(`refused: ${result.code}`);
    // Gapless from 1, as a run's own ledger mints it — NOT the parent's 1..3
    // by coincidence but by an explicit renumbering that also records where
    // each event came from.
    expect(result.plan.events.map((e) => e.seq)).toEqual([1, 2, 3]);
    expect(result.plan.events.every((e) => e.envelope.runId === CHILD)).toBe(true);
    // The payload travels unchanged: a branch rewrites identity, not history.
    expect(result.plan.events[2]?.envelope.payload).toEqual(
      parentEvents()[2]?.payload,
    );
  });

  it('refuses a fork point past the end, so a branch cannot silently take the whole conversation', () => {
    const result = planBranch({
      parentRunId: PARENT,
      sessionId: 'sess-1',
      newRunId: CHILD,
      parentEvents: parentEvents(),
      atSeq: 99,
      parentTerminated: true,
    });
    expect(result.kind).toBe('refused');
    if (result.kind !== 'refused') throw new Error('expected a refusal');
    expect(result.code).toBe('fork_after_terminal');
  });

  it('refuses a branch that reuses the parent runId, which would merge two histories', () => {
    const result = planBranch({
      parentRunId: PARENT,
      sessionId: 'sess-1',
      newRunId: PARENT,
      parentEvents: parentEvents(),
      atSeq: 3,
      parentTerminated: false,
    });
    expect(result.kind).toBe('refused');
    if (result.kind !== 'refused') throw new Error('expected a refusal');
    expect(result.detail).toMatch(/NEW run/);
  });

  it('refuses a parent with no events, rather than branching from nothing', () => {
    const result = planBranch({
      parentRunId: PARENT,
      sessionId: 'sess-1',
      newRunId: CHILD,
      parentEvents: [],
      atSeq: 0,
      parentTerminated: false,
    });
    expect(result.kind).toBe('refused');
    if (result.kind !== 'refused') throw new Error('expected a refusal');
    expect(result.code).toBe('empty_parent');
  });

  it('branches off a terminated run — editing an old message is the normal case', () => {
    // A terminal parent is not a reason to refuse. Only a fork point PAST the
    // terminal is, because there is nothing there to inherit.
    const result = planBranch({
      parentRunId: PARENT,
      sessionId: 'sess-1',
      newRunId: CHILD,
      parentEvents: parentEvents(),
      atSeq: 4,
      parentTerminated: true,
    });
    expect(result.kind).toBe('branched');
    if (result.kind !== 'branched') throw new Error('expected a branch');
    expect(result.plan.events).toHaveLength(4);
  });
});
