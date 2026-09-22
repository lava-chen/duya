// src/hooks/useGitRepo.ts
// Single data source for the TaskDrawer's three Git rows (更改 / 分支 /
// 提交或推送) and for the Git graph's remote-name hints.
//
// This deliberately replaces `useGitStatus` inside the drawer rather than
// sitting next to it: the drawer needs file changes *and* branch/upstream state,
// and running two pollers would spawn two overlapping sets of `git` processes
// every tick. `useGitStatus` stays as-is for ChatView / MessageInput, which only
// want the change counters.

'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { usePolling } from '@/hooks/usePolling';
import {
  EMPTY_REPO_STATE,
  getGitBranches,
  getGitRepoState,
  getGitStatus,
  type GitBranchRef,
  type GitRepositoryState,
  type GitStatusFileChange,
  type GitStatusTotals,
} from '@/lib/git-ipc';

export interface UseGitRepoResult {
  isGitRepo: boolean;
  fileChanges: GitStatusFileChange[];
  totals: GitStatusTotals;
  state: GitRepositoryState;
  locals: GitBranchRef[];
  remotes: GitBranchRef[];
  /** Distinct remote names, for the graph's local-vs-remote ref heuristic. */
  remoteNames: string[];
  /** Force an immediate re-read; call after any Git mutation. */
  refresh: () => void;
}

const POLL_INTERVAL_MS = 4_000;

const EMPTY_TOTALS: GitStatusTotals = { additions: 0, removals: 0, fileCount: 0 };

const EMPTY: UseGitRepoResult = {
  isGitRepo: false,
  fileChanges: [],
  totals: EMPTY_TOTALS,
  state: EMPTY_REPO_STATE,
  locals: [],
  remotes: [],
  remoteNames: [],
  refresh: () => {},
};

export function useGitRepo(
  cwd: string | null | undefined,
  enabled = true,
): UseGitRepoResult {
  const [value, setValue] = useState<Omit<UseGitRepoResult, 'refresh'>>(EMPTY);
  const cwdRef = useRef(cwd);
  cwdRef.current = cwd;
  const enabledRef = useRef(enabled);
  enabledRef.current = enabled;
  const [nonce, setNonce] = useState(0);

  const refresh = useCallback(() => {
    setNonce((current) => current + 1);
  }, []);

  const fetchRepo = useCallback(async (): Promise<void> => {
    const requestCwd = cwdRef.current;
    if (!enabledRef.current || !requestCwd) return;

    // Three independent reads; one failing must not blank the others, so each
    // degrades to its own empty value.
    const [status, state, branches] = await Promise.all([
      getGitStatus(requestCwd).catch(() => null),
      getGitRepoState(requestCwd).catch(() => null),
      getGitBranches(requestCwd).catch(() => null),
    ]);

    // Drop the response if the working directory changed while it was in flight.
    if (!enabledRef.current || cwdRef.current !== requestCwd) return;

    const fileChanges = status?.fileChanges ?? [];
    const totals = status?.totals ?? {
      additions: fileChanges.reduce((sum, change) => sum + change.additions, 0),
      removals: fileChanges.reduce((sum, change) => sum + change.removals, 0),
      fileCount: fileChanges.length,
    };
    const remotes = branches?.remotes ?? [];

    setValue({
      isGitRepo: Boolean(
        (status?.isGitRepo ?? false) || (state?.isGitRepo ?? false) || (branches?.isGitRepo ?? false),
      ),
      fileChanges,
      totals,
      state: state ?? EMPTY_REPO_STATE,
      locals: branches?.locals ?? [],
      remotes,
      remoteNames: Array.from(
        new Set(remotes.map((remote) => remote.remote).filter((name): name is string => Boolean(name))),
      ),
    });
  }, []);

  useEffect(() => {
    if (!enabled || !cwd) {
      setValue(EMPTY);
      return;
    }
    void fetchRepo();
  }, [cwd, enabled, fetchRepo, nonce]);

  usePolling(fetchRepo, POLL_INTERVAL_MS, {
    activeWhen: () => enabled && Boolean(cwd),
    noImmediate: true,
  });

  return { ...value, refresh };
}
