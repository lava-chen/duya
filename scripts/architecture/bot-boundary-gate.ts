/**
 * bot-boundary-gate.ts — typed surface for the Bot boundary gate (plan 622
 * discipline, slice S0 of the personal-agent framework plan).
 *
 * ## The implementation lives in `bot-boundary-gate.mjs`
 *
 * Same split as `client-closure-gate.ts` and `boundary-gates.ts`: `tsx` is not
 * a dependency of this repository, so the detector cannot be a TypeScript
 * entry point. The logic is written once in plain ESM and this file adds the
 * annotations the unit tests rely on. Everything below re-exports from the
 * `.mjs` — there is no second implementation to drift.
 *
 * ## What the three rules are
 *
 * R1 scans every source file the bot package has (no barrel bypass) and
 * forbids any value import landing outside `{ bot, agent-protocol,
 * agent-core }`. R2 forbids a direct value edge from the five downward
 * packages into bot. R3 forbids a value edge from `packages/ui` or
 * `packages/client-core` into the host composition layer or the Desktop
 * main/preload/renderer trees. The contract and the reasoning live in the
 * `.mjs` header and in `docs/design-docs/personal-bot-framework.md` §4; the
 * teeth live in `bot-boundary-gate.test.ts`.
 */

export {
  BOT_ALLOWED_PACKAGES,
  BOT_PACKAGE_DIR,
  BOT_PACKAGE_SRC,
  BOT_SURFACE_GROUPS,
  CLIENT_AXIS_FORBIDDEN_DIRS,
  CLIENT_AXIS_FROM_DIRS,
  CLIENT_AXIS_MIN_SCANNED,
  REVERSE_FROM_PACKAGES,
  REVERSE_MIN_SCANNED,
  botCensus,
  botClosureOwnerOf,
  botClosureRule,
  botSourceFiles,
  clientAxisRule,
  collectBotBoundaryReport,
  isBotBoundaryClean,
  reverseIntoBotRule,
} from './bot-boundary-gate.mjs';

/** One forbidden edge a bot source file makes, named by file and specifier. */
export interface BotClosureFinding {
  owner: string;
  from: string;
  spec: string;
  to: string;
}

/**
 * R1's measurement. `status` is the honest-state triad the gate exists to
 * keep distinguishable:
 *
 *   - `pending`  — the package is not on the tree (S0/S1 expected state).
 *   - `blind`    — the package directory exists but has no scannable
 *                  non-test source; a walk of nothing proves nothing.
 *   - `measured` — every seed was walked; `findings` is the verdict.
 *
 * `unreadable` counts files a transient OS lock made unscannable. It is NOT
 * folded into the status: one locked file must not fail CI, and it must not
 * be silent either — the CLI and the tests surface it so a green is never
 * carried on a hole.
 */
export interface BotClosureReport {
  present: boolean;
  status: 'pending' | 'blind' | 'measured';
  seeds: number;
  walked: number;
  unreadable: number;
  findings: BotClosureFinding[];
  typeOnlyRefs: { file: string; spec: string; owner: string | null }[];
  summary: string;
}

/** R2's measurement: direct value edges from the downward packages into bot. */
export interface ReverseIntoBotReport {
  scanned: number;
  blind: boolean;
  unreadable: number;
  findings: { from: string; spec: string; to: string }[];
  summary: string;
}

/** R3's measurement: client surfaces reaching the composition/run layers. */
export interface ClientAxisReport {
  scanned: number;
  blind: boolean;
  unreadable: number;
  findings: { from: string; spec: string; to: string; target: string }[];
  typeOnlyRefs: { file: string; spec: string; target: string }[];
  summary: string;
}

export interface BotBoundaryReport {
  botClosure: BotClosureReport;
  reverseIntoBot: ReverseIntoBotReport;
  clientAxis: ClientAxisReport;
  clean: boolean;
}

/** One census row: a bot surface group, its members and their non-test consumers. */
export interface BotCensusRow {
  group: string;
  members: number;
  consumers: string[];
  consumerCount: number;
}
