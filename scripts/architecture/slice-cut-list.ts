/**
 * slice-cut-list.ts — the M5.1 cut list, and why each edge is on it.
 *
 * ## What this is
 *
 * M5.1 asks for "导出 type/value/runtimecallgraph、跨包边和 SCC 成员，选择本
 * 切口真实需要去除的 value edge" — export the graphs, then CHOOSE the value
 * edges this slice genuinely needs to remove.
 *
 * The graphs live in `import-graph.mjs`. This file is the choice, and the
 * reason the choice is defensible. Every entry names the evidence that makes
 * the edge LOAD-BEARING for the migration rather than incidental.
 *
 * ## What is deliberately NOT promised
 *
 * The plan warns twice, and both warnings are load-bearing:
 *
 *  - **No SCC-shrink promise.** The 42-member and 14-member strongly-connected
 *    components are INTERNAL to `packages/agent` and `packages/ai`. They are
 *    not cross-package value edges, no cut in M5.2 touches their members, and
 *    their size is an artefact of what the scanner currently counts. An SCC
 *    figure is a measurement of a scan, not a target. Naming one as a goal
 *    would be promising a number this slice has no mechanism to move.
 *  - **No `cycle` count promise.** `architecture:check` reports `cycle 16`; that
 *    is a baseline fingerprint count, and it moves when the RESOLVER changes as
 *    well as when the code does.
 *
 * ## The load-bearing test
 *
 * An edge is on this list when removing it is a PRECONDITION for the target
 * architecture, and at least one of these holds:
 *
 *   (a) it points from a workspace package INTO a host boundary, so the
 *       package cannot be built or reasoned about without the host;
 *   (b) it is a host -> workspace edge that exists only to reach a TYPE across
 *       the boundary, so a `contracts` DTO removes it without moving logic;
 *   (c) it forces a package to be present at RUNTIME (a value edge) where only
 *       a type relationship is intended.
 *
 * An edge that is merely numerous is NOT load-bearing. Size is not a reason.
 */

import { HOST_BOUNDARIES } from './import-graph.mjs';

export type CutRank = 1 | 2 | 3;

export interface CutEdge {
  /** Stable id, so the verifier can require the list not to grow silently. */
  readonly id: string;
  readonly rank: CutRank;
  /** The owner pair, e.g. `pkg:agent -> electron-main`. */
  readonly pair: string;
  /**
   * Measured edge count for this entry.
   *
   * When `subsetOf` is set this is a PART of the pair's edges; otherwise it is
   * the whole pair. The distinction is explicit because a subset entry that
   * claimed the pair total would double-count, and two entries both claiming
   * the same number is exactly the bug the verifier caught during authoring.
   */
  readonly edges: number;
  /** Set when this entry is a named part of a larger entry on the same pair. */
  readonly subsetOf?: string;
  /** Which of the three load-bearing tests applies. */
  readonly because: 'a' | 'b' | 'c';
  readonly why: string;
  /** What M5.2 does about it. */
  readonly cut: string;
}

/**
 * The cut list.
 *
 * Rank 1 is what unblocks M5.2. Rank 2 is what the first real cut needs.
 * Rank 3 is real but belongs to a later slice.
 */
export const CUT_LIST: readonly CutEdge[] = [
  {
    id: 'evals-to-main',
    rank: 3,
    pair: 'evals -> electron-main',
    edges: 2,
    because: 'a',
    why: 'The eval harness reaches into `apps/desktop/src/main/__tests__/eval-redaction.ts` and `eval-legacy-loop.ts`. This is the ONE workspace -> host direction the plan does NOT ask to cut, because it is the measuring instrument: E4.1 and E4.3 built these paths deliberately so the evals exercise the real main-process loop. It is listed rather than omitted so a reader can see it was found and deliberately kept.',
    cut: 'NOT cut. Recorded as an accepted edge; the regression anchor for M5 depends on it.',
  },
  {
    id: 'main-to-renderer-value',
    rank: 1,
    pair: 'electron-main -> src-renderer',
    edges: 33,
    because: 'b',
    why: 'The main process importing renderer modules as VALUES. This is the direction the policy calls backwards and the one the 33 value edges make concrete: they are not type-only imports that a DTO could satisfy, they are runtime loads. 00-contracts.md §A says a DTO in `apps/desktop/src/contracts` is the fix, and a DTO is only a fix for the type-shaped share of these.',
    cut: 'M5.2 splits the type share into `apps/desktop/src/contracts` and leaves the genuinely behavioural share for M5.5. The split is measured per file by this repository, not estimated.',
  },
  {
    id: 'main-to-agent-value',
    rank: 2,
    pair: 'electron-main -> pkg:agent',
    edges: 91,
    because: 'c',
    why: 'The largest host -> workspace value edge set in the tree, and the reason the plan calls the cut "逐项解除" (edge by edge) rather than one move. NOT all 91 are in scope: the rank is a statement that the SET must shrink, not that every edge must go. Several are legitimate composition in the host. The value/type split is what makes the per-edge triage possible, and it is why this is rank 2 rather than rank 1.',
    cut: 'M5.2, edge by edge, with the measurement above as the checklist. An edge stays when the host genuinely composes the runtime.',
  },
  {
    id: 'renderer-to-main-value',
    rank: 2,
    pair: 'src-renderer -> electron-main',
    edges: 4,
    because: 'b',
    why: 'The renderer importing main-process modules. The policy already forbids this direction (`from: src/** to: apps/desktop/src/main/**`) and these 4 are tolerated baseline debt. Small, and entirely type-shaped in intent, so a contracts module plausibly removes all of them.',
    cut: 'M5.2, with the public bridge contracts. Verify against the preload/renderer/main triple rather than the renderer alone.',
  },
  {
    id: 'main-to-gateway-value',
    rank: 3,
    pair: 'electron-main -> pkg:gateway',
    edges: 11,
    because: 'c',
    why: 'The host supervising gateway channel adapters. This edge is CORRECT in direction — the host owns the process — so it is not a violation. It is on the list only because the gateway adapters are capability adapters that M5.5 consolidates behind ports, and the edge count is the measure of how much host surface is entangled with them.',
    cut: 'M5.5, and it may legitimately survive as a composition edge. Recorded so the number is not rediscovered as a surprise.',
  },
];

/**
 * Edges explicitly NOT on the cut list, with the reason.
 *
 * A cut list that only lists what to cut invites the reader to assume the rest
 * was considered and accepted. These are the ones that were considered.
 */
export interface NonCut {
  readonly subject: string;
  readonly why: string;
}

/**
 * A cut-list entry that has been CLOSED, with the measurement that closed it.
 *
 * ## Why closing does not mean deleting
 *
 * The verifier re-derives every count from the live graph on every run, so a
 * closed pair that measured zero can no longer carry an entry: `CUT_LIST` is
 * for edges that still EXIST. Deleting the entry silently would therefore be
 * indistinguishable from never having found it, which is exactly the rot this
 * file exists to prevent.
 *
 * So a closure is recorded here instead, with `edgesAfter` pinned to the same
 * measurement the open entries use. If the pair ever regains an edge, the
 * `closed edges stay closed` test fails and names it.
 */
export interface ClosedEdge {
  readonly id: string;
  /** The owner pair, e.g. `pkg:agent -> electron-main`. */
  readonly pair: string;
  readonly edgesBefore: number;
  /** Measured count after the cut. The verifier re-derives this. */
  readonly edgesAfter: number;
  /** The slice that closed it. */
  readonly slice: string;
  /** What moved, and where it moved to. */
  readonly moved: string;
  /** Edges the cut deliberately ADDED, with the reason they are not a regression. */
  readonly paidFor?: string;
}

export const CLOSED: readonly ClosedEdge[] = [
  {
    id: 'agent-to-host-reverse-edges',
    pair: 'pkg:agent -> electron-main',
    edgesBefore: 15,
    edgesAfter: 0,
    slice: '587 M5.2',
    moved: 'All 15 edges were relative paths out of `packages/agent` into host code, and every one started in a test file, so no production code moved. 14 reached `apps/desktop/src/main/memory-state/migrations/*.sql.ts` from two files: `packages/agent/src/memory-state/__tests__/fixture.ts` and `packages/agent/src/memory-rollout/__tests__/extractor.retry.test.ts`. The agent package now states the schema it REQUIRES in its own `packages/agent/src/memory-state/__tests__/schema-ddl.ts`, materialised by the fixture, and the host pins that copy to its own migrations in `apps/desktop/src/main/memory-state/__tests__/agent-fixture-drift.test.ts`. The 15th edge, `packages/agent/tests/unit/automationScheduler.test.ts` -> `apps/desktop/src/main/automation/schedule.ts`, was a test for host code living in the agent package: the test moved to the host, where the implementation already lives. Four of its five cases were ALREADY pinned by `apps/desktop/src/main/automation/schedule.test.ts`; the one unique case (the schedule timezone changing the result) was relocated with the file, so no case was dropped.',
    paidFor: 'NOTHING. The first version of the drift test imported the agent DDL, which `architecture:check` correctly reported as a new `package-boundary-escape` (162 -> 163) and refused. Importing it would only have traded this cut for the same coupling pointing the other way, so the test READS the agent file as text by path instead: no import, no edge, and the `paidFor` slot exists precisely so that a cut which does cost an edge has to say so out loud. Net cross-package value edges 177 -> 163 after this cut, and `electron-main -> pkg:agent` stayed at 91.',
  },
];

export const NOT_CUT: readonly NonCut[] = [
  {
    subject: 'the 42-member and 14-member SCCs',
    why: 'Both are INTERNAL to `packages/agent` (tools/hooks/process) and are not cross-package value edges. No M5.2 cut moves their members, and an SCC size is a property of a scan over the current file set rather than a design goal. Promising a number here would be a promise with no mechanism behind it.',
  },
  {
    subject: 'the `cycle 16` architecture-check count',
    why: 'That is a baseline fingerprint count over SCCs, and it moves when the resolver changes as much as when the code does. It is not a migration target and is not promised to move.',
  },
  {
    subject: 'the 92 `electron-main -> pkg:agent` edges taken as a block',
    why: 'Size is not a reason. The set must shrink, but several edges are legitimate host composition of the runtime. Promising all 92 would be promising an outcome this slice cannot justify edge by edge.',
  },
  {
    subject: 'test-to-test edges inside one package',
    why: 'A test importing a sibling fixture creates no runtime coupling. `audit-modules.mjs` already excludes test files from its cycle graph for exactly this reason, and the value graph here inherits that judgement.',
  },
];

/**
 * The invariants the cut list must keep.
 *
 * Stated as data so the verifier can check the list against the live graph
 * rather than against a copy of it.
 */
export const CUT_LIST_INVARIANTS = {
  /** Every workspace -> host VALUE edge is a cut candidate, by construction. */
  workspaceToHostIsAlwaysCut: true,
  /**
   * Directions the plan targets that are still OPEN, and so still need an
   * entry in `CUT_LIST`.
   *
   * `pkg:agent -> electron-main` was here when M5.1 wrote this and was removed
   * by M5.2 because it measured zero; it now lives in `CLOSED`. Leaving it here
   * would be a phantom obligation, which the verifier rejects on purpose: a cut
   * that cannot be closed is worse than one that was never promised. It cannot
   * be forgotten either — if an edge reappears in that direction, the
   * `accounts for every workspace -> host value edge in the list` test fails
   * because the pair would be measured again and named by nothing.
   */
  requiredPairs: [
    'electron-main -> src-renderer',
    'electron-main -> pkg:agent',
    'src-renderer -> electron-main',
  ],
  /** Boundaries a value edge may cross INTO for the list to be complete. */
  hostBoundaries: [...HOST_BOUNDARIES],
} as const;
