/**
 * useSessionWorktreeBadges — the branch / pull-request / merge badges on a
 * session row (Claude parity, 2026-10-27).
 *
 * ## What the badges mean
 *
 *   branch  — the session owns a managed checkout, i.e. it worked in a
 *              checkout of its own rather than in the user's own tree.
 *   PR      — the session contributed to a pull request that is still live
 *              (open, draft, in review, or waiting on CI).
 *   merged  — the session's pull request reached the `merged` state.
 *
 * Claude Code renders exactly two of these on a row — a green "PR" glyph and
 * a purple "merge" glyph, each followed by a count when there is more than
 * one. The branch glyph is duya's own addition, because a duya session owns
 * its checkout explicitly (Plan 621) and that fact is worth one glance.
 *
 * ## The counts come from the Host, not from a guess
 *
 * Pull requests are read through `observeIntegrationsForSession`, which the
 * Host answers from its integration store — a projection of what GitHub was
 * observed to be, never a live query. `merged` is a terminal state, so a
 * pull request contributes at most one merge.
 *
 * `unknown` is NOT counted as an open pull request. The integration contract
 * is explicit that an observation which failed to read is not the same fact
 * as "the PR is open", and a badge that claims a PR exists when nobody could
 * look is exactly that fabrication.
 *
 * ## Asking the Host is not free — so it is not asked carelessly
 *
 * The pull-request observation is one indexed query. The checkout
 * observation is NOT: the Host resolves a session's checkout by running
 * `git rev-parse --show-toplevel` and inspecting the worktree registry, so
 * asking for every row of a long sidebar would spawn hundreds of git
 * processes.
 *
 * Two things keep that in check:
 *
 *   - The renderer only asks about a checkout when the session's working
 *     directory can plausibly BE one. A managed checkout always lives under
 *     `<data root>/worktrees/<repo>-<hash>/…`, and the Host answers `null`
 *     for a session sitting in the user's own checkout anyway — so the
 *     filter does not hide an answer, it only avoids asking a question whose
 *     answer is already known.
 *   - Every request goes through a scheduler with a small number of slots,
 *     so the sidebar can never open fifty git processes at once.
 *
 * The Host's answer stays authoritative either way: the filter only decides
 * whether to ask, never what to show.
 */

import { useEffect, useState } from "react";
import {
  observeCheckoutForSession,
  observeIntegrationsForSession,
} from "@/lib/workspace-lifecycle-ipc";
import type { HostIntegrationState } from "@duya/agent-protocol";

/** States in which a pull request still exists and is worth a badge. */
const LIVE_PR_STATES: ReadonlySet<HostIntegrationState> = new Set<HostIntegrationState>([
  "draft",
  "open",
  "checks_failing",
  "checks_passing",
  "review_requested",
  "changes_requested",
  "approved",
]);

/** How long an observation stays usable before the row asks again. */
const CACHE_TTL_MS = 30_000;
/** How many Host requests may be in flight at once. */
const MAX_CONCURRENCY = 4;

export interface SessionWorktreeBadgeCounts {
  /** Managed checkouts this session owns. */
  branches: number;
  /** Pull requests that are still live. */
  pullRequests: number;
  /** Pull requests that reached `merged`. */
  merged: number;
}

const EMPTY: SessionWorktreeBadgeCounts = { branches: 0, pullRequests: 0, merged: 0 };

interface CacheEntry {
  at: number;
  counts: SessionWorktreeBadgeCounts;
}

const cache = new Map<string, CacheEntry>();

/**
 * Whether a working directory can be a managed checkout.
 *
 * A managed checkout always sits under a `worktrees` directory
 * (`<data root>/worktrees/<repo>-<hash>/<slug>-<hash>`), so a path without
 * that segment is the user's own tree — and the Host answers `null` for it.
 */
function mayBeManagedCheckout(workingDirectory: string | null | undefined): boolean {
  if (!workingDirectory) return false;
  return workingDirectory.split(/[\\/]/).includes("worktrees");
}

/* ── A tiny scheduler so the sidebar cannot open fifty requests at once ── */

let inFlight = 0;
const queue: Array<() => void> = [];

function schedule(task: () => void): void {
  if (inFlight >= MAX_CONCURRENCY) {
    queue.push(task);
    return;
  }
  inFlight += 1;
  task();
}

function release(): void {
  const next = queue.shift();
  if (next) {
    next();
    return;
  }
  inFlight -= 1;
}

function request<T>(run: () => Promise<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    schedule(() => {
      run().then(resolve, reject).finally(release);
    });
  });
}

/* ── The observation ── */

async function observeCounts(
  sessionId: string,
  workingDirectory: string | null | undefined,
): Promise<SessionWorktreeBadgeCounts> {
  const integrations = await request(() => observeIntegrationsForSession(sessionId));

  let pullRequests = 0;
  let merged = 0;
  for (const record of integrations ?? []) {
    if (record.state === "merged") merged += 1;
    else if (LIVE_PR_STATES.has(record.state)) pullRequests += 1;
  }

  let branches = 0;
  if (mayBeManagedCheckout(workingDirectory)) {
    const checkoutView = await request(() => observeCheckoutForSession(sessionId));
    branches = checkoutView?.checkout != null && checkoutView.isOwner ? 1 : 0;
  }

  return { branches, pullRequests, merged };
}

function sameCounts(a: SessionWorktreeBadgeCounts, b: SessionWorktreeBadgeCounts): boolean {
  return a.branches === b.branches && a.pullRequests === b.pullRequests && a.merged === b.merged;
}

export function useSessionWorktreeBadges(
  sessionId: string,
  workingDirectory: string | null | undefined,
): SessionWorktreeBadgeCounts {
  const [counts, setCounts] = useState<SessionWorktreeBadgeCounts>(EMPTY);

  useEffect(() => {
    let cancelled = false;
    const cached = cache.get(sessionId);
    if (cached && Date.now() - cached.at < CACHE_TTL_MS) {
      setCounts(cached.counts);
      return;
    }
    void observeCounts(sessionId, workingDirectory)
      .then((next) => {
        if (cancelled) return;
        cache.set(sessionId, { at: Date.now(), counts: next });
        // Most rows own no checkout and touch no pull request, so the common
        // answer is "no badges". Skipping the update when nothing changed
        // keeps a long sidebar from re-rendering every row once on load.
        setCounts((prev) => (sameCounts(prev, next) ? prev : next));
      })
      .catch(() => {
        // A failed observation leaves the row without badges rather than
        // with a made-up count.
        if (!cancelled) setCounts((prev) => (sameCounts(prev, EMPTY) ? prev : EMPTY));
      });
    return () => {
      cancelled = true;
    };
  }, [sessionId, workingDirectory]);

  return counts;
}
