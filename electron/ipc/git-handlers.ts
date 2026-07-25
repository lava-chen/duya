// electron/ipc/git-handlers.ts
// Read-only git status IPC for the TaskDrawer / session-detail panel.
// Spawns `git diff --numstat HEAD` against the active session's working
// directory so the rail can show "+X / -Y" working-tree totals without
// trusting the agent's tool-use history.
//
// Channel: git:status
//   Input:  { cwd: string }
//   Output: {
//     isGitRepo: boolean,
//     fileChanges?: GitStatusFileChange[],
//     totals?:    GitStatusTotals,
//   }
//
// Failure modes that downgrade to { isGitRepo: false } instead of
// throwing — the renderer's hook just hides the section:
//   - .git directory absent (not a repo, or wrong cwd)
//   - git binary not on PATH (ENOENT)
//   - spawnSync timeout / non-zero exit
//   - any other unexpected error

import { ipcMain } from 'electron';
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

const GIT_TIMEOUT_MS = 5000;
const GIT_DIFF_ARGS = ['diff', '--numstat', 'HEAD'];

export interface GitStatusFileChange {
  path: string;
  additions: number;
  removals: number;
}

export interface GitStatusTotals {
  additions: number;
  removals: number;
  fileCount: number;
}

export interface GitStatusResult {
  isGitRepo: boolean;
  fileChanges?: GitStatusFileChange[];
  totals?: GitStatusTotals;
}

function isGitRepoDir(cwd: string): boolean {
  try {
    // A real `.git` dir is the common case; `.git` can also be a file
    // pointing at a gitdir (git worktrees, submodules). existsSync
    // returns true for both, which is what we want.
    return fs.existsSync(path.join(cwd, '.git'));
  } catch {
    return false;
  }
}

/**
 * Parse `git diff --numstat HEAD` output. Each line is `<add>\t<rem>\t<path>`.
 * Binary files use `-` for both add/rem; we preserve them as 0/0 so the
 * renderer still lists them in the change breakdown.
 */
function parseNumstat(output: string): GitStatusFileChange[] {
  const lines = output.split('\n');
  const changes: GitStatusFileChange[] = [];
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    const parts = line.split('\t');
    if (parts.length < 3) continue;
    const additions = parts[0] === '-' ? 0 : Number.parseInt(parts[0], 10);
    const removals = parts[1] === '-' ? 0 : Number.parseInt(parts[1], 10);
    if (Number.isNaN(additions) || Number.isNaN(removals)) continue;
    changes.push({
      path: parts.slice(2).join('\t'),
      additions,
      removals,
    });
  }
  return changes;
}

function computeTotals(changes: GitStatusFileChange[]): GitStatusTotals {
  let additions = 0;
  let removals = 0;
  for (const change of changes) {
    additions += change.additions;
    removals += change.removals;
  }
  return { additions, removals, fileCount: changes.length };
}

export function registerGitHandlers(): void {
  ipcMain.handle('git:status', async (_event, cwd: unknown): Promise<GitStatusResult> => {
    if (typeof cwd !== 'string' || cwd.length === 0) {
      return { isGitRepo: false };
    }
    if (!isGitRepoDir(cwd)) {
      return { isGitRepo: false };
    }

    try {
      const result = spawnSync('git', GIT_DIFF_ARGS, {
        cwd,
        encoding: 'utf-8',
        timeout: GIT_TIMEOUT_MS,
      });

      if (result.error) {
        // ENOENT (git not on PATH), ETIMEDOUT, etc. — never surface as
        // a hard error to the renderer.
        return { isGitRepo: false };
      }

      if (typeof result.stdout !== 'string') {
        return { isGitRepo: false };
      }

      const fileChanges = parseNumstat(result.stdout);
      return {
        isGitRepo: true,
        fileChanges,
        totals: computeTotals(fileChanges),
      };
    } catch {
      return { isGitRepo: false };
    }
  });
}