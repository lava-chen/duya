/**
 * Transport-neutral Integration (pull request / CI / review / merge) contract
 * for Duya Host (plan 621, slice B).
 *
 * ## GitHub is the authority; this is the projection
 *
 * Per §4.3, `(repo, prNumber)` identifies an Integration and only GitHub decides
 * its state. Nothing Duya stores can promote a PR to "merged". Consequently
 * every value here is an observation with an `observedAt`, and a client must
 * present it as "as of" rather than as fact.
 *
 * ## `unknown` is a real answer and must stay visible
 *
 * An observation can fail: no `gh`, no network, no token, rate limit. Encoding
 * that failure as `open` would turn "we could not look" into "the PR is open",
 * and every downstream decision (is this work finished? can this checkout be
 * reclaimed?) would be made on a fabricated fact. So `unknown` is a first-class
 * state and always travels with `observedError`; the pair is enforced by the
 * contract, not by convention.
 */

import type { Millis, SessionId } from './primitives.js';

/**
 * Projected integration state, in the order a PR usually passes through.
 *
 *   none                — no PR known for this ChangeSet yet.
 *   draft               — PR exists and is a draft.
 *   open                — PR is open for review.
 *   checks_failing      — CI is red.
 *   checks_passing      — CI is green.
 *   review_requested    — review requested, no verdict yet.
 *   changes_requested   — a reviewer asked for changes.
 *   approved            — approved, not merged.
 *   merged              — merged. Terminal.
 *   closed_unmerged     — closed without merging. Terminal for this PR.
 *   unknown             — observation failed. Legal, never folded into `open`.
 */
export type HostIntegrationState =
  | 'none'
  | 'draft'
  | 'open'
  | 'checks_failing'
  | 'checks_passing'
  | 'review_requested'
  | 'changes_requested'
  | 'approved'
  | 'merged'
  | 'closed_unmerged'
  | 'unknown';

/**
 * One observed PR.
 *
 * `null` fields mean "not observed", which is different from "observed empty":
 * a PR with no base ref was never fully read, and a client should not render
 * `null` as "no base branch".
 */
export interface HostIntegrationRecord {
  /** `owner/name`. Part of the Integration's identity, alongside `prNumber`. */
  readonly repo: string;
  readonly prNumber: number;
  readonly state: HostIntegrationState;
  /** HEAD the observation applies to; null when unknown. */
  readonly headSha: string | null;
  /** Base ref name, not a SHA; null when unknown. */
  readonly baseRef: string | null;
  /** Hosting URL for display; null when unknown. */
  readonly url: string | null;
  /** When this was read from GitHub. Observation only. */
  readonly observedAt: Millis;
  /**
   * Why the observation failed. Required when `state` is `'unknown'`, null on
   * success — an `unknown` without a reason is unusable in a UI and in a
   * support ticket.
   */
  readonly observedError: string | null;
}

/** Wire contract for Integration observation and session association. */
export interface HostIntegrationApiV1 {
  /**
   * Every integration associated with a session, across all its PRs.
   *
   * A session may contribute to several PRs over time and one PR may be built
   * by several sessions (§4.1, many-to-many), so this is a list and never a
   * single "the PR" field.
   */
  observeForSession(sessionId: SessionId): Promise<readonly HostIntegrationRecord[]>;

  /** Re-read one PR from the hosting service and return the refreshed observation. */
  observeForPr(repo: string, prNumber: number): Promise<HostIntegrationRecord>;

  /** Record that a session contributed to a PR. Idempotent; repeat links only refresh recency. */
  linkSession(repo: string, prNumber: number, sessionId: SessionId): Promise<void>;
}
