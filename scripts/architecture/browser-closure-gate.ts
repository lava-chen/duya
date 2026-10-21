/**
 * Plan 610 §4 — typed surface for gate G10.
 *
 * ## The implementation lives in `browser-closure-gate.mjs`
 *
 * Same split as `boundary-gates.ts`: `tsx` is not a dependency of this
 * repository, so the detector cannot be a TypeScript entry point. The logic is
 * written once in plain ESM and this file adds the annotations the unit tests
 * rely on. Everything below re-exports from the `.mjs` — there is no second
 * implementation to drift.
 *
 * ## What G10 is
 *
 * The value-import closure of a browser entry point must contain no Node
 * built-in. It exists because plan 610 A0 measured that the desktop renderer
 * reached `@duya/ai` → `providers/adapters.ts` → `api/bedrock-converse.ts` →
 * `node:crypto`, which Electron's Node-bearing renderer tolerates and a browser
 * cannot load. That coupling was invisible to every gate in the repo.
 *
 * ## The discipline
 *
 * The gate is proven in both directions by `browser-closure-gate.test.ts`: a
 * fixture is attached to a renderer-shaped entry and asserted RED, the same
 * fixture without it is asserted GREEN, and the live tree is asserted GREEN
 * with a non-zero walked count, so a green result cannot mean "inspected
 * nothing". The CLI form of the same proof, run against the real tree, is
 * `node scripts/architecture/browser-closure-gate.mjs`.
 */

export {
  BROWSER_ENTRIES,
  NODE_BUILTIN_RE,
  browserClosure,
  collectBrowserClosureReport,
  isBrowserClosureClean,
  isNodeBuiltinSpecifier,
  seedsFor,
} from './browser-closure-gate.mjs';

import type { collectBrowserClosureReport } from './browser-closure-gate.mjs';

/** One browser entry point, as `BROWSER_ENTRIES` names it. */
export interface BrowserEntry {
  /** Repo-relative. */
  readonly rel: string;
  readonly kind: 'dir' | 'file';
}

/** A Node built-in inside a browser entry's closure. */
export interface NodeBuiltinReach {
  /** The module that carries the import. */
  readonly file: string;
  /** The specifier as written, so `node:fs` and `fs` stay distinguishable. */
  readonly spec: string;
  /** The browser entry the closure was walked from. */
  readonly from: string;
  /** The file one hop closer to the entry — the edge whose removal severs it. */
  readonly via: string | null;
}

/** How much of one entry the walk actually opened. */
export interface BrowserEntryCoverage {
  readonly rel: string;
  /** Non-test files the entry contributed as walk seeds. */
  readonly seeds: number;
  /** Files in that entry's value-import closure. */
  readonly closure: number;
}

export interface BrowserClosureReport {
  /** `<bad>/<walked> in <scope>` — a count is never reported without both. */
  readonly summary: string;
  readonly scope: string;
  readonly entries: readonly BrowserEntryCoverage[];
  /** Entries named by `BROWSER_ENTRIES` that do not exist on this tree yet. */
  readonly absentEntries: readonly string[];
  /** Value imports of a Node built-in. Non-empty means RED. */
  readonly findings: readonly NodeBuiltinReach[];
  /**
   * Type-only imports of a Node built-in. Reported, never fatal: the compiler
   * erases them, so they cannot reach a bundle.
   */
  readonly typeOnlyBuiltins: readonly NodeBuiltinReach[];
  /** Files opened across all entries. Zero would mean the gate checked nothing. */
  readonly walked: number;
}

export type BrowserClosureCollector = typeof collectBrowserClosureReport;
