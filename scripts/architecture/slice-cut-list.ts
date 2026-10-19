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
 *  - **No `cycle` count promise.** `architecture:check` reports a `cycle`
 *    fingerprint count, and it moves when the RESOLVER changes as well as when
 *    the code does. The figure this file carried when it was written was 16; run
 *    against this tree on 2026-10-20 the same gate prints `cycle 2`, with no
 *    cycle-cutting work in between and no ladder of intermediate measurements to
 *    explain the gap. That is itself the argument for naming no cycle target
 *    here — the number answers to the scanner before it answers to the code.
 *  - **Every count here is a count of what the resolver can see, and the
 *    resolver cannot see a bare specifier at all.** `resolveTarget`
 *    (`import-graph.mjs:283`) maps `@duya/<rest>` to `packages/<first segment of
 *    rest>` — the subpath after the package name is DROPPED, not appended — and
 *    then tries `<pkg>.ts`, `<pkg>/index.ts` and their `.tsx`/`.js`/`.mjs`
 *    siblings. No package in this repo keeps an entry at its root (every entry is
 *    `src/index.ts`, never `index.ts`), so nothing matches and the specifier
 *    yields no edge. Measured 2026-10-20 against this tree: `@duya/agent-protocol`,
 *    `@duya/ai`, `@duya/client-core`, `@duya/conductor/renderer`,
 *    `@duya/input-completion`, `@duya/memory`, `@duya/ui` and
 *    `@duya/ui/lib/ipc-client` all resolve to `null`. Cross-package dependencies
 *    expressed by bare specifier are therefore INVISIBLE here in EVERY form,
 *    which is why `electron-main -> pkg:agent-protocol` — a pair the host
 *    reaches hundreds of times — does not appear in this file at all.
 *
 *    This is a property of THIS resolver, not of the repository. The boundary
 *    gate resolves bare specifiers correctly: `audit-imports.mjs:74` builds a
 *    registry from each package's `package.json` `name` and `exports`, and
 *    `:165` resolves through `workspaceExportTargets`, which is why
 *    `pkg:ui -> pkg:agent-protocol` does appear in `architecture:check`. Two
 *    resolvers, one of them blind; every number in this file comes from the
 *    blind one.
 *
 *    The pairs listed below are those written as relative paths. A number going
 *    down can mean the coupling was cut, or that the import was rewritten from a
 *    relative path to a bare one; `main-to-agent-value` is the entry where that
 *    distinction is spelled out, because that is exactly what happened to it.
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
    edges: 28,
    because: 'b',
    why: 'The main process importing renderer modules as VALUES. This is the direction the policy calls backwards and the one the value edges make concrete: they are not type-only imports that a DTO could satisfy, they are runtime loads. 00-contracts.md §A says a DTO in `apps/desktop/src/contracts` is the fix, and a DTO is only a fix for the type-shaped share of these.',
    cut: 'M5.2 took the type share. `renderer/types/import.ts` moved to `apps/desktop/src/contracts/import.ts` and both sides now read it from there, which removed this edge: 33 -> 32. Re-measured against the tree this list now describes, the pair stands at 28. All 28 targets still live under `apps/desktop/src/renderer`, which is what makes them this pair rather than a `pkg:ui` one: `lib/providers/*` accounts for 24 (`legacy.ts` 13, `domain/ProviderValidation.ts` 3, `catalog.ts` 2, `secret.ts` 2, `index.ts` 2, `health/ProviderHealthService.ts` 1, `models/ModelSyncService.ts` 1) and the other 4 are `lib/plugin-error-messages.ts` (2), `types/usage.ts` (1) and one test importing `lib/errors/extractErrorMessage.ts` (1). These are the genuinely behavioural share — a runtime provider service, not a shape a DTO can satisfy. They are M5.5\'s consolidation behind ports, not a DTO, and none of them can be moved without moving behaviour.',
  },
  {
    id: 'main-to-agent-value',
    rank: 3,
    pair: 'electron-main -> pkg:agent',
    // 91 -> 60 -> 1, and the LAST step is a measurement change more than a cut.
    //
    // The `@duya/memory`, `@duya/tooling` and `@duya/connectors` extractions did
    // move host-facing code out of `packages/agent` into declared packages. But
    // the main process reaches those packages by BARE specifier (`@duya/memory`),
    // and `resolveTarget` cannot see a bare `@duya/*` specifier in any form: it
    // keeps only the first segment after `@duya/`, builds its candidates under
    // `packages/<x>/` (`<x>.ts`, `<x>/index.ts`, …), and no package in this repo
    // has a root `index.ts` — every entry is `src/index.ts`. A `dist` in the
    // specifier does not help either, because the subpath carrying it is dropped
    // before the candidates are built (see this file's header). So the 60 that M5.2
    // measured were relative-path crossings into `packages/agent/src`, and what
    // replaced them resolves to nothing. The coupling may well still exist; what
    // shrank is the scanner's view of it. `apps/desktop/src/main` alone carries
    // 284 bare `@duya/*` imports, none of which produces an edge.
    //
    // The single surviving edge is relative, and it belongs to a TEST rather than
    // to production code. It stays in this list rather than moving to `CLOSED`
    // because `CLOSED` is for pairs that measure zero: an entry there would have
    // to state `edgesAfter: 0` and the verifier re-derives that number, so filing
    // a live edge as closed would be a false claim the gate would then have to be
    // taught to tolerate.
    edges: 1,
    because: 'c',
    why: 'This pair held the largest host -> workspace value edge set this scanner could see — 91 when M5.1 wrote this, 60 when M5.2 did — and was the reason the plan calls the cut "逐项解除" (edge by edge) rather than one move. It now measures 1, but the honest reading of that number is narrower than "the set was cut": the extractions swapped relative paths for bare `@duya/*` specifiers, which this graph does not resolve, so the old edges did not all go — some of them stopped being observable. Filling that blind spot is its own work item, because it would move every count in this file at once.',
    cut: 'NOT established by this slice, and not closeable with this scanner. The single measured edge runs from a test rather than from production code: `apps/desktop/src/main/channels/__tests__/connector-secret-store.test.ts` -> `packages/agent/src/channels/types.ts`, a wire type still read from the legacy agent root by relative path. It is kept as the honest residue instead of being deleted. Whether the other 59 are really gone cannot be answered until `resolveTarget` learns to resolve a bare `@duya/*` specifier to `packages/<x>/src/index.ts`; until then this entry should not be read as evidence that the host -> agent coupling was removed.',
  },
  {
    id: 'main-to-gateway-value',
    rank: 3,
    pair: 'electron-main -> pkg:gateway',
    edges: 8,
    because: 'c',
    why: 'The host supervising gateway channel adapters. This edge is CORRECT in direction — the host owns the process — so it is not a violation. It is on the list only because the gateway adapters are capability adapters that M5.5 consolidates behind ports, and the edge count (11 when M5.1 wrote this, 8 measured now) is the measure of how much host surface is entangled with them.',
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
  {
    id: 'renderer-to-main-value',
    pair: 'src-renderer -> electron-main',
    edgesBefore: 2,
    edgesAfter: 0,
    slice: '610 M5.2, then the renderer extraction',
    moved: 'Both tolerated edges are gone, and neither went because its import was deleted — both went because the files carrying them left the renderer. `app-connection-ipc.ts` now lives in `packages/ui/src/lib/` and reads its DTO from `packages/ui/src/types/app-connection.ts`, so the reach into `main/services/app-connections/types.ts` became a same-package import. `permission-profile.contract.test.ts` now sits on the main side (`apps/desktop/src/main/__tests__/`), importing its own implementation and the renderer one from `@duya/ui/lib/permission-profile`: the edge reversed in intent rather than weakening, and the check that holds preload, main and renderer to one behaviour still exists, which is what the edge was for.',
    paidFor: 'NOTHING in this direction. One caveat is recorded rather than hidden: the reversal the second file creates is NOT visible in this graph. `packages/ui/src` imports five workspace packages by value (`@duya/agent-protocol`, `@duya/ai`, `@duya/client-core`, `@duya/conductor/renderer`, `@duya/input-completion`) and `main` now imports `@duya/ui/lib/permission-profile`, but the measured pair list contains no `pkg:ui` row in either direction. The cause is the resolver blind spot described in this file\'s header, not a clean zero: bare `@duya/*` specifiers resolve only through a named `dist` path. So reading this closure as "the reversal cost nothing measured" would be reading a gap as a measurement, and closing that gap is its own work item because it would move every count in this file at once.',
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
    subject: 'the single `electron-main -> pkg:agent` edge left after the A5 extractions',
    why: 'It is recorded in `CUT_LIST`, because it still exists, and named here so the drop from 91 to 1 is not mistaken for a measurement error. The survivor is a test reading `packages/agent/src/channels/types.ts`, a wire type that moves when the port that owns it moves. Leaving one test-only edge is deliberate: forcing it now would trade a test import for a new reverse dependency, which is not a cut.',
  },
  {
    subject: 'test-to-test edges inside one package',
    why: 'A test importing a sibling fixture creates no runtime coupling. `audit-modules.mjs` already excludes test files from its cycle graph for exactly this reason, and the value graph here inherits that judgement.',
  },
  {
    subject: 'the `src-renderer -> electron-main` direction, named here since M5.1',
    why: 'It is CLOSED now (2 -> 0), and `CLOSED` carries the reasoning and the evidence. It stays named here as well because this list is where a reader who remembers the two tolerated edges looks first, and a silent disappearance from both lists would be exactly the rot this file exists to prevent.',
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
   *
   * `src-renderer -> electron-main` left the same way and for the same reason:
   * it measures zero now, so it moved to `CLOSED` rather than staying here as a
   * second phantom obligation.
   */
  requiredPairs: [
    'electron-main -> src-renderer',
    'electron-main -> pkg:agent',
  ],
  /** Boundaries a value edge may cross INTO for the list to be complete. */
  hostBoundaries: [...HOST_BOUNDARIES],
} as const;
