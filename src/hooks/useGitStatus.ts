// src/hooks/useGitStatus.ts
// Polls `git:status` every 1.5s against the active session's working
// directory and exposes the result to the TaskDrawer. Polling cadence
// matches useTaskCount so the rail's update rhythm is uniform.
//
// Returns `{ isGitRepo: false }` (EMPTY) when:
//   - polling is disabled (drawer closed or no cwd)
//   - the cwd isn't a git repo
//   - the IPC call throws / times out (handler already downgrades, but
//     this is a belt-and-braces catch)
// In every EMPTY case the EnvironmentInfoSection returns null, so
// callers can treat the result as "show this section iff isGitRepo".

'use client';

import { useEffect, useState } from 'react';
import { getGitStatus } from '@/lib/git-ipc';
import type { GitStatusFileChange, GitStatusTotals } from '@/lib/git-ipc';

export interface UseGitStatusResult {
  isGitRepo: boolean;
  fileChanges: GitStatusFileChange[];
  totals: GitStatusTotals;
}

const POLL_INTERVAL_MS = 1500;

const EMPTY: UseGitStatusResult = {
  isGitRepo: false,
  fileChanges: [],
  totals: { additions: 0, removals: 0, fileCount: 0 },
};

export function useGitStatus(
  cwd: string | null | undefined,
  enabled = true
): UseGitStatusResult {
  const [status, setStatus] = useState<UseGitStatusResult>(EMPTY);

  useEffect(() => {
    if (!enabled || !cwd) {
      setStatus(EMPTY);
      return;
    }

    let cancelled = false;

    const fetchStatus = async (): Promise<void> => {
      try {
        const result = await getGitStatus(cwd);
        if (cancelled) return;

        if (!result.isGitRepo || !result.fileChanges) {
          setStatus(EMPTY);
          return;
        }

        const totals: GitStatusTotals = result.totals ?? {
          additions: result.fileChanges.reduce((sum, c) => sum + c.additions, 0),
          removals: result.fileChanges.reduce((sum, c) => sum + c.removals, 0),
          fileCount: result.fileChanges.length,
        };

        setStatus({
          isGitRepo: true,
          fileChanges: result.fileChanges,
          totals,
        });
      } catch {
        if (!cancelled) setStatus(EMPTY);
      }
    };

    void fetchStatus();
    const id = setInterval(fetchStatus, POLL_INTERVAL_MS);

    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [cwd, enabled]);

  return status;
}