/**
 * Plan 610 §14 P0 — typed surface for the worker IPC channel census.
 *
 * ## The implementation lives in `ipc-channel-census.mjs`
 *
 * `tsx` is not a dependency of this repository, so a TypeScript file cannot be
 * the CLI entry point. The detector logic is therefore written once in plain
 * ESM JavaScript and this file only re-exports it with the annotations the unit
 * tests rely on — the same split `boundary-gates.ts` uses. There is no second
 * implementation to drift.
 *
 * ## What the census is for
 *
 * One worker IPC request channel costs seven hand-synced sites across
 * `packages/host` and `apps/desktop`; `router.ts` carries three copies of the
 * same condition. Missing one produces no compile error and no gate failure —
 * only a runtime `UNKNOWN_ACTION` or a silent 15s / 30s timeout. Plans 454 and
 * 575 each lost a round to exactly that.
 *
 * `scripts/` is in no `typecheck:*` project, so nothing in the repo's gates
 * checks this file. The tests in `ipc-channel-census.test.ts` are its only
 * verification, and every rule there is proven by a planted fixture carrying
 * the violation it forbids.
 */

export { REPO_ROOT, collectIpcChannelCensus, discoverChannels } from './ipc-channel-census.mjs';

/** One rule a site's per-channel count is judged against. */
export type SiteRule =
  /** Exactly `value` occurrences: catches both absence and copy-paste surplus. */
  | { readonly kind: 'exactly'; readonly value: number }
  /** At least `value`: where a legitimate variant split exists. */
  | { readonly kind: 'min'; readonly value: number }
  /** Must match the majority profile across channels; deviation must be declared. */
  | { readonly kind: 'consensus' };

/** A site's verdict for one channel. */
export interface IpcChannelCell {
  readonly channel: string;
  readonly count: number;
  /** 1-based lines where the probe matched, so a verdict is clickable. */
  readonly lines: readonly number[];
  /** Informational second probe, or null when the site defines none. */
  readonly extraCount: number | null;
  readonly extraLabel: string | null;
}

/** One physical place that must mention every channel. */
export interface IpcChannelSite {
  readonly id: string;
  readonly title: string;
  readonly file: string;
  readonly note: string;
  readonly rule: SiteRule;
  readonly missingFile: boolean;
  /** Majority count across channels, or null when the rule is not `consensus`. */
  readonly consensusValue: number | null;
  readonly cells: readonly IpcChannelCell[];
}

export interface IpcChannelFinding {
  /**
   * `error` blocks (a channel cannot work), `asymmetry` needs a decision
   * (implement it or declare the exception), `duplicate` is structural debt
   * with no runtime effect.
   */
  readonly severity: 'error' | 'asymmetry' | 'duplicate';
  readonly site: string;
  /** Null only for a whole-site finding, such as a missing file. */
  readonly channel: string | null;
  readonly file: string;
  readonly message: string;
  readonly lines: readonly number[];
}

export interface IpcChannelCensusReport {
  /** Sorted union of both witnesses — see the `.mjs` header for why two. */
  readonly channels: readonly string[];
  readonly sites: readonly IpcChannelSite[];
  readonly findings: readonly IpcChannelFinding[];
}
