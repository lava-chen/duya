/**
 * aliveness.ts — real evidence for the provider's fail-closed ports
 * (plan 621, decision D4 / dispatch record note 2).
 *
 * `createCheckoutProvider` defaults `isSessionAlive` to "always alive" and
 * `cwdInUse` to "never in use" because only the caller can see the run
 * ledger. This module is that caller's half: a factory that rebuilds both
 * ports from the `runs` table, so prove-dead and reclaim decisions read
 * observable facts instead of the fail-closed stand-ins.
 *
 * ## No timestamps (decision D4)
 *
 * Every answer below is derived from a run's `status` column only. There is
 * no heartbeat, no "seen within N seconds", no clock comparison anywhere in
 * this file — a timeout model would release owners mid-task and contradict
 * the contract's "no lease expiry" rule.
 *
 * ## Wiring (owned by the Host composition, not by this file)
 *
 * - `listRunsBySession`: `RunStore.listRunsBySession` directly — its rows
 *   already carry `status`.
 * - `listRunningRunCwds`: one query joining `runs` (status = 'running') to
 *   `sessions.working_directory`, owned by whoever composes the provider.
 */

import * as path from 'node:path';
import type { ReclaimInputs } from './worktree-removal.js';
import { canonicalPath, samePath } from './fs-utils.js';

/** Observable facts this module needs but cannot derive itself. */
export interface AlivenessSources {
  /**
   * A session's runs, newest first — `RunStore.listRunsBySession`'s shape.
   * The source's default window applies (50 newest rows today); a run in
   * `running` status is by construction the session's newest row, so the
   * window never hides a live run behind terminal ones.
   */
  listRunsBySession(
    sessionId: string,
    limit?: number,
  ): Array<{ status: string }> | Promise<Array<{ status: string }>>;
  /** Working directories of every run currently in `running` status. */
  listRunningRunCwds(): Promise<readonly string[]>;
}

/**
 * True when `candidate` is `root` itself or lies underneath it.
 *
 * Both sides are canonicalized first (junctions, 8.3 short names) and the
 * comparison is case-insensitive on Windows, so one directory spelled two
 * ways can never split "in use" from "reclaimable". A bare `startsWith`
 * without the separator would let `/repo2` claim to be inside `/repo` — the
 * separator guard is what keeps sibling directories apart.
 */
export function cwdInsideRoot(root: string, candidate: string): boolean {
  const resolvedRoot = canonicalPath(root);
  const resolvedCandidate = canonicalPath(candidate);
  if (samePath(resolvedCandidate, resolvedRoot)) return true;
  const lower = process.platform === 'win32';
  const prefix = lower ? resolvedRoot.toLowerCase() : resolvedRoot;
  const full = lower ? resolvedCandidate.toLowerCase() : resolvedCandidate;
  return full.startsWith(prefix + path.sep);
}

/**
 * Build the provider's `ReclaimInputs` from the run ledger. Both answers are
 * pure reads of run status — no timestamp is consulted (decision D4).
 */
export function createAlivenessInputs(sources: AlivenessSources): ReclaimInputs {
  return {
    isSessionAlive: async (sessionId) => {
      const runs = await sources.listRunsBySession(sessionId);
      return runs.some((run) => run.status === 'running');
    },
    cwdInUse: async (root) => {
      const cwds = await sources.listRunningRunCwds();
      return cwds.some((cwd) => cwdInsideRoot(root, cwd));
    },
  };
}
