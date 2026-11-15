/**
 * packages/cli/src/tui/pr-badge.ts
 *
 * The pull-request badge the TUI footer shows for the current session, and
 * the shared vocabulary the `/pr` panel prints the same states with.
 *
 * ## The badge is a reading, not a fact
 *
 * Every value here comes from the Host's integration projection, which is what
 * the Host observed the LAST time it looked. `observedAt` travels with the
 * badge and the `/pr` panel prints it, because a badge without a timestamp
 * reads as "this is true right now" while a pull request's CI state changes
 * without the badge moving.
 *
 * ## One badge for many pull requests
 *
 * A session can contribute to several pull requests over its life (§4.1 of
 * plan 621), so the projection is a list. The badge shows ONE of them — the
 * one the user is most likely looking at — and the panel shows the rest.
 *
 * ## The label and colour share the state
 *
 * The footer is a fixed-width row that must never wrap. Keep the explicit
 * state wording short and let its color reinforce the label. A symbol would
 * cost a column whose width is ambiguous in CJK terminals — the footer has
 * already been bitten by a glyph the width table called one cell and Windows
 * Terminal drew as two (see `footer.ts`).
 */

import type { HostIntegrationRecord, HostIntegrationState } from '@duya/agent-protocol';

/** What the footer shows about one pull request. */
export interface PrBadge {
  /** `owner/name`. */
  readonly repo: string;
  readonly prNumber: number;
  readonly state: HostIntegrationState;
  /** Hosting URL; null when the observation never saw one. */
  readonly url: string | null;
  /** When the Host read this from the hosting service. */
  readonly observedAt: number;
  /** `PR #123` — the text the footer paints. */
  readonly label: string;
}

/** Compact state shown beside the session's path in the composer footer. */
export function prFooterLabel(badge: PrBadge): string {
  const state = badge.state === 'checks_failing' ? 'checks failed'
    : badge.state === 'checks_passing' ? 'checks passed'
    : badge.state === 'review_requested' ? 'review requested'
    : badge.state === 'changes_requested' ? 'changes requested'
    : badge.state === 'closed_unmerged' ? 'closed'
    : badge.state === 'unknown' ? 'unknown'
    : badge.state;
  return `${badge.label} · ${state}`;
}

/**
 * The tone the badge is painted with. Mirrors the footer's style vocabulary.
 *
 * `unknown` is MUTED and not error: "we could not look" is not "something is
 * broken", and painting it red would report a failure that did not happen.
 */
export type PrTone = 'success' | 'error' | 'warning' | 'muted' | 'accent';

/** The tone for one state. */
export function prTone(state: HostIntegrationState): PrTone {
  switch (state) {
    case 'merged':
    case 'checks_passing':
    case 'approved':
      return 'success';
    case 'checks_failing':
      return 'error';
    case 'review_requested':
    case 'changes_requested':
      return 'warning';
    case 'draft':
    case 'closed_unmerged':
    case 'unknown':
      return 'muted';
    default:
      return 'accent';
  }
}

/**
 * What each state means, in one line.
 *
 * The Host's state names are contract vocabulary (`checks_failing` is not a
 * phrase a person says), so the panel translates them rather than printing
 * them raw.
 */
export function prStateLabel(state: HostIntegrationState): string {
  switch (state) {
    case 'none':
      return 'no pull request';
    case 'draft':
      return 'draft — not open for review yet';
    case 'open':
      return 'open — CI is still running or no review is required';
    case 'checks_failing':
      return 'a check failed';
    case 'checks_passing':
      return 'all checks passed';
    case 'review_requested':
      return 'review requested — no verdict yet';
    case 'changes_requested':
      return 'a reviewer asked for changes';
    case 'approved':
      return 'approved — not merged yet';
    case 'merged':
      return 'merged — the changes landed';
    case 'closed_unmerged':
      return 'closed without merging';
    case 'unknown':
      return 'the observation failed';
  }
}

/** The panel groups states by what they ask of the reader. */
export type PrGroup = 'in progress' | 'needs attention' | 'done' | 'not observed';

/** The group a state belongs to. */
export function prGroup(state: HostIntegrationState): PrGroup {
  switch (state) {
    case 'open':
    case 'draft':
    case 'review_requested':
      return 'in progress';
    case 'checks_failing':
    case 'changes_requested':
      return 'needs attention';
    case 'checks_passing':
    case 'approved':
    case 'merged':
    case 'closed_unmerged':
      return 'done';
    case 'none':
    case 'unknown':
      return 'not observed';
  }
}

/** The order the groups are printed in: what needs the reader first. */
export const PR_GROUP_ORDER: readonly PrGroup[] = [
  'needs attention',
  'in progress',
  'done',
  'not observed',
];

/**
 * The states that describe work still in flight.
 *
 * A finished pull request does not outrank an open one just because it was
 * observed more recently: the badge is for the work the user is watching.
 */
const ACTIVE_STATES: ReadonlySet<HostIntegrationState> = new Set<HostIntegrationState>([
  'open',
  'draft',
  'checks_failing',
  'checks_passing',
  'review_requested',
  'changes_requested',
  'approved',
]);

/**
 * The badge for a session's pull requests, or null when there is none.
 *
 * `none` is not a pull request — it is the absence of one — so it never
 * becomes a badge. Among the rest, work in flight outranks a finished pull
 * request; within a group the most recently observed wins, and a tie is broken
 * by the higher number (the newer pull request on the same branch).
 */
export function pickPrBadge(records: readonly HostIntegrationRecord[]): PrBadge | null {
  const candidates = records.filter((record) => record.state !== 'none');
  if (candidates.length === 0) return null;

  const sorted = [...candidates].sort((a, b) => {
    const active = Number(ACTIVE_STATES.has(b.state)) - Number(ACTIVE_STATES.has(a.state));
    if (active !== 0) return active;
    if (b.observedAt !== a.observedAt) return b.observedAt - a.observedAt;
    return b.prNumber - a.prNumber;
  });

  const picked = sorted[0];
  if (picked === undefined) return null;
  return {
    repo: picked.repo,
    prNumber: picked.prNumber,
    state: picked.state,
    url: picked.url,
    observedAt: picked.observedAt,
    label: `PR #${picked.prNumber}`,
  };
}
