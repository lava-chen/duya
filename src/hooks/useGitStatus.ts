// src/hooks/useGitStatus.ts
// Polls `git:status` every 1.5s against the active session's working
// directory and exposes the result to the TaskDrawer.
//
// Returns `{ isGitRepo: false }` (EMPTY) when:
//   - polling is disabled (drawer closed or no cwd)
//   - the cwd isn't a git repo
//   - the IPC call throws / times out (handler already downgrades, but
//     this is a belt-and-braces catch)
// In every EMPTY case the EnvironmentInfoSection returns null, so
// callers can treat the result as "show this section iff isGitRepo".

'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { usePolling } from '@/hooks/usePolling';
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
  // Guards that drop responses resolving after cwd/enabled changed,
  // replacing the per-effect `cancelled` flag now that the fetch
  // callback outlives a single effect run.
  const cwdRef = useRef(cwd);
  cwdRef.current = cwd;
  const enabledRef = useRef(enabled);
  enabledRef.current = enabled;

  const fetchStatus = useCallback(async (): Promise<void> => {
    const requestCwd = cwdRef.current;
    if (!enabledRef.current || !requestCwd) return;
    try {
      const result = await getGitStatus(requestCwd);
      if (!enabledRef.current || cwdRef.current !== requestCwd) return;

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
      // Transient IPC failure: keep the previous status instead of clearing
      // to EMPTY — resetting here made the file-change pill flicker off for
      // a polling cycle (plan 308 Phase 2).
      if (!enabledRef.current || cwdRef.current !== requestCwd) setStatus(EMPTY);
    }
  }, []);

  // Immediate fetch on mount and whenever cwd/enabled changes; the
  // periodic cadence is owned by usePolling below.
  useEffect(() => {
    if (!enabled || !cwd) {
      setStatus(EMPTY);
      return;
    }
    void fetchStatus();
  }, [cwd, enabled, fetchStatus]);

  usePolling(fetchStatus, POLL_INTERVAL_MS, {
    activeWhen: () => enabled && Boolean(cwd),
    noImmediate: true,
  });

  return status;
}
