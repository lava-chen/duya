/**
 * observe.ts — read-only observation of pull requests (plan 621 slice C).
 *
 * Every function here answers one question: "what does GitHub say right now?".
 * Observation is deliberately side-effect free — no DB row, no cache, no file,
 * no `gh` mutation. The same inputs produce the same facts on every call, with
 * `observedAt` as the only value that moves.
 *
 * Contract rules that the code below must keep (plan 621 §4.3 / §4.4):
 *   - `observed_*` values are never evidence for "can I write" / "can I
 *     delete" / "is this the same thing"; they are a rebuildable projection.
 *   - A failed observation is `unknown` + `observedError`. It is never
 *     downgraded to `open`: "GitHub did not answer" is not "no problems".
 */

import { createGhRunner, GhError, readJsonField, type GhRunner } from './gh-cli.js';
import type { HostIntegrationState } from './integration-state.js';

/**
 * Normalised outcome of one status check. GitHub exposes two shapes in
 * `statusCheckRollup`: `CheckRun` (`status` + `conclusion`) and the legacy
 * `StatusContext` (`state`). Both collapse onto these four buckets so the state
 * mapping itself stays a pure function of a small, testable input.
 */
export type PrCheckOutcome = 'success' | 'pending' | 'failing' | 'other';

/** What the mapping function needs to know about a PR. */
export interface PrIntegrationSignal {
  state: 'OPEN' | 'CLOSED' | 'MERGED';
  isDraft: boolean;
  /** GitHub `reviewDecision`; `null` and `''` both mean "no review required". */
  reviewDecision: string | null;
  checks: readonly PrCheckOutcome[];
}

/** The observed shape of one PR, after `gh` JSON was validated. */
export interface GhPrView {
  state: 'OPEN' | 'CLOSED' | 'MERGED';
  isDraft: boolean;
  headRefOid: string | null;
  baseRefName: string | null;
  url: string | null;
  reviewDecision: string | null;
  checks: PrCheckOutcome[];
}

/** The minimum `gh pr list` gives us: enough to match a ref to a PR number. */
export interface GhPrRefMatch {
  number: number;
  headRefName: string | null;
  headRefOid: string | null;
  state: 'OPEN' | 'CLOSED' | 'MERGED';
}

/**
 * Facts about a single PR. This is what slice E writes into the
 * `observed_*` columns; it is never an identity.
 */
export interface ObservedPrFacts {
  repo: string;
  prNumber: number;
  state: HostIntegrationState;
  headSha: string | null;
  baseRef: string | null;
  url: string | null;
  observedAt: number;
  observedError: string | null;
}

/**
 * Facts about "the PR for this ref". `ref` is a branch name or a commit sha
 * (detached checkouts have no branch name — plan 621 D3), `state` is `none`
 * when no PR matched.
 */
export interface ObservedRefFacts {
  repo: string;
  ref: string;
  prNumber: number | null;
  state: HostIntegrationState;
  headSha: string | null;
  baseRef: string | null;
  url: string | null;
  observedAt: number;
  observedError: string | null;
}

export interface ScmObserverDeps {
  /** Injected in tests; the default runner shells out to the real `gh`. */
  runner?: GhRunner;
  /** Injected clock so tests can pin `observedAt`. */
  now?: () => number;
}

const PR_VIEW_FIELDS = [
  'state',
  'isDraft',
  // Requested for conflict reporting in a later slice; it does not take part
  // in the state mapping below.
  'mergeable',
  'headRefOid',
  'baseRefName',
  'url',
  'reviewDecision',
  'statusCheckRollup',
].join(',');

/**
 * The listing only has to answer "which PR number owns this ref". It is kept
 * deliberately light: `statusCheckRollup` on a list call makes gh fetch checks
 * for every PR in the page, which measured 26s for 100 PRs on this repository
 * and blows the 20s budget, while these four fields take 9s for 500. The heavy
 * facts are then read per matched PR by `observePr`, which is bounded by the
 * caller's refs (usually a handful), not by repository size.
 */
const PR_LIST_FIELDS = ['number', 'headRefName', 'headRefOid', 'state'].join(',');

/**
 * `gh pr list` defaults to 30 results, which would silently miss the PR of an
 * old checkout. One page of 500 covers realistic repositories; a repo with more
 * PRs than this is a known gap (see the slice report) rather than a reason to
 * issue N per-ref list calls.
 */
const PR_LIST_LIMIT = 500;

/** A full or abbreviated commit sha, which is how a detached checkout is named. */
const SHA_LIKE_REF = /^[0-9a-f]{7,40}$/i;

let sharedRunner: GhRunner | null = null;

function defaultRunner(): GhRunner {
  sharedRunner ??= createGhRunner();
  return sharedRunner;
}

/**
 * Map GitHub facts to the Integration state. THIS ORDER IS THE CONTRACT
 * (plan 621 §4.4); each rule is pinned by a table-driven test, so changing one
 * means changing a named row.
 *
 *   1. merged            — state MERGED, even with red checks or as a draft.
 *   2. closed_unmerged   — state CLOSED.
 *   3. draft             — isDraft, even when CI is already red.
 *   4. checks_failing    — any check FAILURE / CANCELLED / TIMED_OUT.
 *   5. open              — any pending check (IN_PROGRESS / QUEUED / EXPECTED);
 *                          pending is explicitly NOT `checks_passing`.
 *   6..8. approved / changes_requested / review_requested — every check green
 *                          and the review decision says so.
 *   9. checks_passing    — every check green, no review requirement.
 *  10. open              — everything else: empty rollup, an unclassifiable
 *                          check, or a review decision we do not recognise.
 *
 * `unknown` is never produced here. It exists only for failed observations.
 */
export function deriveIntegrationState(signal: PrIntegrationSignal): HostIntegrationState {
  if (signal.state === 'MERGED') return 'merged';
  if (signal.state === 'CLOSED') return 'closed_unmerged';
  if (signal.isDraft) return 'draft';
  if (signal.checks.includes('failing')) return 'checks_failing';
  if (signal.checks.includes('pending')) return 'open';
  // Rules 6-9 require every check to be green, so an empty rollup or a check we
  // cannot classify is `open`, never `checks_passing`.
  if (signal.checks.length === 0 || signal.checks.includes('other')) return 'open';
  if (signal.reviewDecision === 'APPROVED') return 'approved';
  if (signal.reviewDecision === 'CHANGES_REQUESTED') return 'changes_requested';
  if (signal.reviewDecision === 'REVIEW_REQUIRED') return 'review_requested';
  if (signal.reviewDecision === null || signal.reviewDecision === '') return 'checks_passing';
  return 'open';
}

function invalidPrJson(fieldName: string): GhError {
  return new GhError(
    'invalid_json',
    `GitHub CLI returned a pull request Duya could not read (unexpected "${fieldName}"). Update gh to the latest version, then retry.`,
  );
}

function readPrState(source: unknown): 'OPEN' | 'CLOSED' | 'MERGED' {
  const state = readJsonField(source, 'state');
  if (state === 'OPEN' || state === 'CLOSED' || state === 'MERGED') return state;
  throw invalidPrJson('state');
}

function readRequiredBoolean(source: unknown, fieldName: string): boolean {
  const value = readJsonField(source, fieldName);
  if (typeof value !== 'boolean') throw invalidPrJson(fieldName);
  return value;
}

function readOptionalString(source: unknown, fieldName: string): string | null {
  const value = readJsonField(source, fieldName);
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string') throw invalidPrJson(fieldName);
  // gh emits "" for "no review decision"; treat it as absent, not as a value.
  return value.length > 0 ? value : null;
}

function readNumber(source: unknown, fieldName: string): number {
  const value = readJsonField(source, fieldName);
  if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) {
    throw invalidPrJson(fieldName);
  }
  return value;
}

function readCheckOutcome(entry: unknown): PrCheckOutcome {
  if (readJsonField(entry, '__typename') === 'StatusContext') {
    const state = readJsonField(entry, 'state');
    if (state === 'SUCCESS') return 'success';
    if (state === 'PENDING' || state === 'EXPECTED') return 'pending';
    if (state === 'FAILURE' || state === 'ERROR') return 'failing';
    return 'other';
  }

  const conclusion = readJsonField(entry, 'conclusion');
  if (conclusion === 'FAILURE' || conclusion === 'CANCELLED' || conclusion === 'TIMED_OUT') {
    return 'failing';
  }
  const status = readJsonField(entry, 'status');
  if (
    status === 'IN_PROGRESS' ||
    status === 'QUEUED' ||
    status === 'EXPECTED' ||
    status === 'PENDING' ||
    status === 'WAITING' ||
    status === 'REQUESTED'
  ) {
    return 'pending';
  }
  // NEUTRAL / SKIPPED are not failures; they are green for our purposes.
  if (conclusion === 'SUCCESS' || conclusion === 'NEUTRAL' || conclusion === 'SKIPPED') {
    return 'success';
  }
  return 'other';
}

function readChecks(source: unknown): PrCheckOutcome[] {
  const rollup = readJsonField(source, 'statusCheckRollup');
  if (rollup === null || rollup === undefined) return [];
  if (!Array.isArray(rollup)) throw invalidPrJson('statusCheckRollup');
  const entries: unknown[] = rollup;
  return entries.map(readCheckOutcome);
}

/**
 * Narrow one `gh pr view --json …` payload. Anything that does not look like
 * the requested shape is `invalid_json`, not a best-effort guess.
 */
export function parsePrView(value: unknown): GhPrView {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw invalidPrJson('pr view');
  }
  return {
    state: readPrState(value),
    isDraft: readRequiredBoolean(value, 'isDraft'),
    headRefOid: readOptionalString(value, 'headRefOid'),
    baseRefName: readOptionalString(value, 'baseRefName'),
    url: readOptionalString(value, 'url'),
    reviewDecision: readOptionalString(value, 'reviewDecision'),
    checks: readChecks(value),
  };
}

/** Narrow one `gh pr list --json number,headRefName,headRefOid,state` payload. */
export function parsePrList(value: unknown): GhPrRefMatch[] {
  if (!Array.isArray(value)) throw invalidPrJson('pr list');
  const entries: unknown[] = value;
  return entries.map((entry) => {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      throw invalidPrJson('pr list entry');
    }
    return {
      number: readNumber(entry, 'number'),
      headRefName: readOptionalString(entry, 'headRefName'),
      headRefOid: readOptionalString(entry, 'headRefOid'),
      state: readPrState(entry),
    };
  });
}

function describeObservationFailure(error: unknown): string {
  if (error instanceof GhError) return error.message;
  if (error instanceof Error) return error.message;
  return String(error);
}

function factsFromView(
  repo: string,
  prNumber: number,
  view: GhPrView,
  observedAt: number,
): ObservedPrFacts {
  return {
    repo,
    prNumber,
    state: deriveIntegrationState({
      state: view.state,
      isDraft: view.isDraft,
      reviewDecision: view.reviewDecision,
      checks: view.checks,
    }),
    headSha: view.headRefOid,
    baseRef: view.baseRefName,
    url: view.url,
    observedAt,
    observedError: null,
  };
}

/**
 * Observe one PR.
 *
 * A failure never throws: the caller gets `unknown` plus the user-facing
 * sentence, which is exactly the value slice E persists. Throwing here would
 * force every caller to re-implement the same mapping.
 */
export async function observePr(
  repo: string,
  prNumber: number,
  deps: ScmObserverDeps = {},
): Promise<ObservedPrFacts> {
  const now = deps.now ?? Date.now;
  const observedAt = now();
  const runner = deps.runner ?? defaultRunner();

  try {
    const view = await runner.runJson(
      ['pr', 'view', String(prNumber), '--repo', repo, '--json', PR_VIEW_FIELDS],
      parsePrView,
    );
    return factsFromView(repo, prNumber, view, observedAt);
  } catch (error) {
    return {
      repo,
      prNumber,
      // Never `open`: we did not observe anything.
      state: 'unknown',
      headSha: null,
      baseRef: null,
      url: null,
      observedAt,
      observedError: describeObservationFailure(error),
    };
  }
}

/**
 * Pick the PR that belongs to one ref.
 *
 * A ref is matched as a branch name when it is not sha-like, otherwise as a
 * commit sha prefix — a detached checkout (plan 621 D3) has no branch name, so
 * the sha is the only link back to its PR.
 *
 * A branch can carry several PRs over its lifetime (closed, then a new number
 * after a force-push). Prefer the newest non-closed PR, then the newest one.
 */
function selectPrForRef(entries: readonly GhPrRefMatch[], ref: string): GhPrRefMatch | null {
  const candidates = SHA_LIKE_REF.test(ref)
    ? entries.filter((entry) => entry.headRefOid?.toLowerCase().startsWith(ref.toLowerCase()) === true)
    : entries.filter((entry) => entry.headRefName === ref);
  if (candidates.length === 0) return null;

  const newestFirst = [...candidates].sort((a, b) => b.number - a.number);
  return newestFirst.find((entry) => entry.state !== 'CLOSED') ?? newestFirst[0] ?? null;
}

/**
 * Observe the PRs behind several refs.
 *
 * Matching is ONE `gh pr list` call followed by local comparison, so a caller
 * with 20 checkouts still pays one listing instead of 20. The heavy per-PR
 * facts (checks, review decision) are then read once per DISTINCT matched PR —
 * bounded by `refs`, never by repository size — and all facts in one call share
 * a single `observedAt` so a batch is internally consistent.
 *
 * `refs` are trimmed; blank entries are dropped and input order is preserved,
 * so callers can zip the result back onto their checkouts. A ref with no PR is
 * reported as `state: 'none'`, not as an error — "no PR yet" is an answer.
 * A failed listing makes every ref `unknown` with the same `observedError`.
 */
export async function observePrsForRefs(
  repo: string,
  refs: readonly string[],
  deps: ScmObserverDeps = {},
): Promise<ObservedRefFacts[]> {
  const wanted = refs.map((ref) => ref.trim()).filter((ref) => ref.length > 0);
  if (wanted.length === 0) return [];

  const now = deps.now ?? Date.now;
  const observedAt = now();
  const runner = deps.runner ?? defaultRunner();

  let matches: GhPrRefMatch[];
  try {
    matches = await runner.runJson(
      [
        'pr',
        'list',
        '--repo',
        repo,
        // `--state all`: a merged PR is the normal case for a finished
        // checkout, and closed-without-merge still needs to be reported.
        '--state',
        'all',
        '--limit',
        String(PR_LIST_LIMIT),
        '--json',
        PR_LIST_FIELDS,
      ],
      parsePrList,
    );
  } catch (error) {
    const observedError = describeObservationFailure(error);
    return wanted.map((ref) => ({
      repo,
      ref,
      prNumber: null,
      state: 'unknown' as const,
      headSha: null,
      baseRef: null,
      url: null,
      observedAt,
      observedError,
    }));
  }

  const observed = new Map<number, ObservedPrFacts>();
  const results: ObservedRefFacts[] = [];
  for (const ref of wanted) {
    const match = selectPrForRef(matches, ref);
    if (match === null) {
      results.push({
        repo,
        ref,
        prNumber: null,
        state: 'none',
        headSha: null,
        baseRef: null,
        url: null,
        observedAt,
        observedError: null,
      });
      continue;
    }

    let facts = observed.get(match.number);
    if (facts === undefined) {
      facts = await observePr(repo, match.number, { runner, now: () => observedAt });
      observed.set(match.number, facts);
    }
    results.push({ ...facts, ref });
  }
  return results;
}
