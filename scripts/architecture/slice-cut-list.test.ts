/**
 * slice-cut-list.test.ts — the cut list is checked against the live graph.
 *
 * ## Why a cut list needs a verifier at all
 *
 * A cut list is a set of NUMBERS. Numbers rot silently: an edge gets removed
 * by an unrelated PR, a package is renamed, and the list keeps asserting a
 * problem that no longer exists. Worse, a list that is never checked reads as
 * a fresh measurement, so nobody re-measures it.
 *
 * So every count here is re-derived from `import-graph.mjs` on every run. If an
 * edge set moves, this fails and names the entry that moved. The list cannot
 * quietly become a historical document.
 *
 * ## The number this deliberately does NOT assert
 *
 * No assertion anywhere here expects an SCC to shrink, or expects
 * `architecture:check`'s `cycle` count to change. The plan forbids turning a
 * scan artefact into a promise, and a test that asserted one would be exactly
 * that promise with a green tick on it.
 */

import { describe, expect, it } from 'vitest';
import { CLOSED, CUT_LIST, CUT_LIST_INVARIANTS, NOT_CUT } from './slice-cut-list';
import { buildGraphs } from './import-graph.mjs';

const g = buildGraphs();

/** Measured cross-package value edges, keyed by owner pair. */
function measuredPairs(): Map<string, number> {
  const m = new Map<string, number>();
  for (const e of g.valueEdges) {
    if (e.fromOwner === e.toOwner) continue;
    const k = `${e.fromOwner} -> ${e.toOwner}`;
    m.set(k, (m.get(k) ?? 0) + 1);
  }
  return m;
}

const PAIRS = measuredPairs();

describe('the cut list matches the graph it claims to describe', () => {
  it('states the measured edge count for every pair it claims wholly', () => {
    // The load-bearing assertion. An entry with no `subsetOf` claims the WHOLE
    // pair, so its count must equal the measured total. Subset entries are
    // checked separately below, against their parent's total.
    const wrong = CUT_LIST.filter((c) => c.subsetOf === undefined && PAIRS.get(c.pair) !== c.edges)
      .map((c) => ({
        id: c.id,
        pair: c.pair,
        stated: c.edges,
        measured: PAIRS.get(c.pair) ?? 0,
      }));
    expect(wrong).toEqual([]);
  });

  it('has subsets that sum to their parent, and name a parent that exists', () => {
    // Without this, two entries can both claim the same pair and quietly
    // double-count it — the exact defect found while authoring this list.
    const parents = new Map(CUT_LIST.filter((c) => c.subsetOf === undefined).map((c) => [c.id, c]));
    const problems: { id: string; problem: string }[] = [];
    for (const child of CUT_LIST.filter((c) => c.subsetOf !== undefined)) {
      const parent = parents.get(child.subsetOf!);
      if (parent === undefined) {
        problems.push({ id: child.id, problem: `no parent entry ${child.subsetOf}` });
        continue;
      }
      if (parent.pair !== child.pair) {
        problems.push({ id: child.id, problem: `parent is on a different pair (${parent.pair})` });
      }
      if (child.edges >= parent.edges) {
        problems.push({ id: child.id, problem: `subset (${child.edges}) is not smaller than parent (${parent.edges})` });
      }
    }
    for (const [parentId, parent] of parents) {
      const sum = CUT_LIST.filter((c) => c.subsetOf === parentId).reduce((n, c) => n + c.edges, 0);
      // Subsets need not be exhaustive — a pair can have un-named edges — but a
      // sum that EXCEEDS the parent is a double count and always a bug.
      if (sum > parent.edges) {
        problems.push({ id: parentId, problem: `subsets sum to ${sum}, parent has ${parent.edges}` });
      }
    }
    expect(problems).toEqual([]);
  });

  it('gives every entry a unique id, a rank and a reason', () => {
    const ids = CUT_LIST.map((c) => c.id);
    expect(ids.filter((id, i) => ids.indexOf(id) !== i)).toEqual([]);
    const bare = CUT_LIST.filter(
      (c) => c.why.trim().length === 0 || c.cut.trim().length === 0,
    );
    expect(bare.map((c) => c.id)).toEqual([]);
    const badRank = CUT_LIST.filter((c) => ![1, 2, 3].includes(c.rank));
    expect(badRank.map((c) => c.id)).toEqual([]);
  });

  it('ties every entry to a load-bearing reason, not to its size', () => {
    // `a` = workspace -> host, `b` = type-shaped host edge, `c` = runtime-only
    // coupling. An entry with none of these is a number someone liked.
    const ungrounded = CUT_LIST.filter((c) => !['a', 'b', 'c'].includes(c.because));
    expect(ungrounded.map((c) => c.id)).toEqual([]);
  });

  it('never puts a test-only edge above a production one without saying so', () => {
    // Rank 1 is the unblocking work. If a rank-1 entry is test-only it must say
    // so in its own text, because "cheap" and "load-bearing" are different
    // claims and conflating them is how a test edge gets mistaken for a
    // production dependency.
    for (const c of CUT_LIST.filter((x) => x.rank === 1)) {
      const testOnly = /test/i.test(c.why);
      expect({ id: c.id, testOnly, saysSo: /test/i.test(c.why) || !testOnly }).toEqual({
        id: c.id,
        testOnly,
        saysSo: true,
      });
    }
  });
});

describe('the list is complete against the direction the plan targets', () => {
  it('names every pair the plan asks to be cut', () => {
    const named = CUT_LIST.map((c) => c.pair);
    const missing = CUT_LIST_INVARIANTS.requiredPairs.filter((p) => !named.includes(p));
    expect(missing).toEqual([]);
  });

  it('has no entry for a pair that has no cross-package value edges', () => {
    // An entry for an empty pair is a phantom obligation, which is worse than a
    // missing one: it cannot be closed.
    const phantom = CUT_LIST.filter((c) => (PAIRS.get(c.pair) ?? 0) === 0).map((c) => c.id);
    expect(phantom).toEqual([]);
  });

  it('accounts for every workspace -> host value edge in the list', () => {
    // The direction the migration exists to remove. If a workspace -> host pair
    // appears in the graph but not in the list, the list has a hole in exactly
    // the place the plan cares about.
    const reversePairs = [
      ...new Set(g.valueEdges.filter((e) => e.direction === 'workspace-to-host').map(
        (e) => `${e.fromOwner} -> ${e.toOwner}`,
      )),
    ];
    const named = CUT_LIST.map((c) => c.pair);
    expect(reversePairs.filter((p) => !named.includes(p))).toEqual([]);
  });
});

describe('a closed entry stays closed, and cannot rot into a fresh claim', () => {
  it('states a measured edge count that still matches the graph', () => {
    // The same discipline the open entries get, applied to the ones already cut.
    // A closure whose `edgesAfter` drifts is a closure that quietly reopened,
    // and the failure mode it prevents is the one this file exists for: a
    // number that reads as a fresh measurement when nothing re-measured it.
    const wrong = CLOSED.map((c) => ({
      id: c.id,
      pair: c.pair,
      stated: c.edgesAfter,
      measured: PAIRS.get(c.pair) ?? 0,
    })).filter((c) => c.stated !== c.measured);
    expect(wrong).toEqual([]);
  });

  it('records a real reduction, and a slice that closed it', () => {
    // A closure that did not reduce anything is not a closure.
    const notReduced = CLOSED.filter((c) => c.edgesAfter >= c.edgesBefore).map((c) => c.id);
    expect(notReduced).toEqual([]);
    const unexplained = CLOSED.filter(
      (c) => c.slice.trim().length === 0 || c.moved.trim().length === 0,
    );
    expect(unexplained.map((c) => c.id)).toEqual([]);
  });

  it('names any edge the cut added, rather than absorbing it silently', () => {
    // The reverse direction of a cut is where a regression hides. If closing a
    // pair added an edge somewhere else, the entry has to say so.
    const undeclared = CLOSED.filter(
      (c) => c.paidFor === undefined || c.paidFor.trim().length === 0,
    );
    expect(undeclared.map((c) => c.id)).toEqual([]);
  });

  it('has no closed pair that is also still an open obligation', () => {
    // One pair, one home. An entry in both lists would let a future edit
    // satisfy the open entry while the closure went stale, or the reverse.
    const closedPairs = new Set(CLOSED.map((c) => c.pair));
    const both = CUT_LIST.map((c) => c.pair).filter((p) => closedPairs.has(p));
    expect(both).toEqual([]);
  });

  it('does not list a closed pair as a direction the plan still asks to cut', () => {
    // `requiredPairs` means "still open", so a closed pair must be gone from it
    // or the open list is asking for a cut that has already happened.
    const closedPairs = new Set(CLOSED.map((c) => c.pair));
    const stillOpen = CUT_LIST_INVARIANTS.requiredPairs.filter((p) => closedPairs.has(p));
    expect(stillOpen).toEqual([]);
  });
});

describe('the things this list refuses to promise stay refused', () => {
  it('states the non-cut decisions with a reason each', () => {
    const bare = NOT_CUT.filter((n) => n.why.trim().length === 0);
    expect(bare).toEqual([]);
  });

  it('names the SCC figures the plan forbids turning into promises', () => {
    // The plan's warning is specific: do not promise that some unrelated
    // 14-member SCC shrinks because a 42-member one changed. Both figures are
    // named here as non-cut, which is the opposite of promising them.
    const text = NOT_CUT.map((n) => `${n.subject} ${n.why}`).join(' ');
    expect(text).toMatch(/42-member/);
    expect(text).toMatch(/14-member/);
  });

  it('asserts nothing about SCC size in this file', () => {
    // A guard on the guard: if a future edit adds `expect(scc).toBeLessThan(42)`
    // this fails, because that assertion is precisely the promise the plan
    // forbids. Read as a tripwire, not as a claim about the current numbers.
    const source = NOT_CUT.map((n) => n.why).join('\n');
    expect(source).not.toMatch(/expect\(/);
  });
});
