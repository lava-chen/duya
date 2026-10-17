/**
 * client-closure-gate.ts — typed surface for gate G11-1 (plan 610 §5).
 *
 * ## The implementation lives in `client-closure-gate.mjs`
 *
 * Same split as `browser-closure-gate.ts` and `boundary-gates.ts`: `tsx` is not
 * a dependency of this repository, so the detector cannot be a TypeScript entry
 * point. The logic is written once in plain ESM and this file adds the
 * annotations the unit tests rely on. Everything below re-exports from the
 * `.mjs` — there is no second implementation to drift.
 *
 * ## What G11-1 is
 *
 * The value-import closure of a client entry must contain neither
 * `@duya/agent-runtime` nor `@duya/agent-core`. It exists because the runtime is
 * what OWNS a run while a client is what TALKS to one; a static value import
 * from client to runtime makes the process boundary advisory, and "share one
 * core" degrades into "link everything". Layer rules cannot see it: the
 * pollution arrives through `@duya/host`, a legal layer edge, three hops deep.
 *
 * ## Why there is no tree-level GREEN assertion here
 *
 * G10's test asserts the live tree green. G11-1's does NOT, and the difference
 * is deliberate: the tree is RED today, for a real reason, documented in
 * `client-closure-gate.test.ts` — `packages/cli/src/chat.ts:33` value-imports
 * `startLocalHost`, which is used at exactly one call site (`runTuiCommand`).
 * Severing that edge is a `packages/cli` change and belongs to a separate card;
 * this gate's job is to make the coupling visible and to stay honest about it.
 *
 * What the test proves instead is that each DIRECTION has teeth: a fixture
 * attached to a client-shaped entry goes RED when it value-imports the runtime,
 * GREEN on the same fixture with the import demoted to `import type`, and RED
 * again when the entry itself disappears — because a blind root is not clean.
 */

export {
  CLIENT_ENTRIES,
  FORBIDDEN_PACKAGES,
  clientClosure,
  collectClientClosureReport,
  forbiddenOwnerOf,
  isClientClosureClean,
  isEveryClientEntryClean,
  isMeasured,
  pathTo,
} from './client-closure-gate.mjs';

import { collectClientClosureReport } from './client-closure-gate.mjs';

/** A module package a client closure must not reach through a value import. */
export type ForbiddenPackage = '@duya/agent-runtime' | '@duya/agent-core';

/** One client entry point the gate walks. */
export interface ClientEntry {
  /** Repo-relative path, e.g. `packages/cli/src/chat.ts`. */
  rel: string;
  /** Always `file`: a directory root hides the reachability path. */
  kind: 'file';
}

/**
 * One forbidden package reached from one entry.
 *
 * `file`/`via` name the FIRST edge that crossed into the package, which is the
 * edge to sever. `reached` counts every file in that package inside the
 * closure — the consequence, not the cause. `chain` is the whole route from the
 * entry to `file`, for a reader who wants to see it without a debugger.
 *
 * `package` is `string`, not `ForbiddenPackage`: the collector builds each
 * finding by iterating `FORBIDDEN_PACKAGES` in the `.mjs`, where the annotation
 * does not reach, so TypeScript widens it on the way out. Narrowing it here
 * would mean either duplicating the list in this file (two sources of truth for
 * the thing the gate is about) or asserting the narrowing in the test, and an
 * assertion in place of a type is not a check. The union still exists and is
 * what `FORBIDDEN_PACKAGES` is annotated against.
 */
export interface ClientClosureFinding {
  package: string;
  file: string;
  via: string | null;
  reached: number;
  chain: string[];
}

/** A type-only reference to a forbidden package: counted, never a finding. */
export interface ClientClosureTypeOnlyRef {
  file: string;
  spec: string;
}

/** The measurement and verdict for ONE entry. */
export interface ClientClosureEntryReport {
  entry: string;
  /** True when the entry file is not on this tree. An absent entry is never clean. */
  absent: boolean;
  /** Files in the value-import closure, including the entry itself. */
  walked: number;
  findings: ClientClosureFinding[];
  typeOnlyRefs: ClientClosureTypeOnlyRef[];
  /** `<bad>/<walked> in <entry>` — a count with its denominator. */
  summary: string;
  /**
   * `findings.length === 0 && walked >= 2`. Never true for an absent root, and
   * never true for a root that has no value imports at all — a closure of one
   * file is the entry alone, which measures "I opened the file", not "I followed
   * the graph". `isMeasured()` is the public form of that half.
   */
  clean: boolean;
}

export type ClientClosureCollector = typeof collectClientClosureReport;
