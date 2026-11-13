import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { resolve } from 'node:path';

const execFileAsync = promisify(execFile);
const GIT_TIMEOUT_MS = 3_000;

export interface WorkbenchWorkspaceChange {
  readonly status: string;
  readonly path: string;
}

export interface WorkbenchWorkspaceSummary {
  readonly root: string;
  readonly branch: string | null;
  readonly linkedWorktree: boolean;
  readonly observed: boolean;
  readonly changedFiles: number | null;
  readonly changes: readonly WorkbenchWorkspaceChange[];
}

async function git(cwd: string, args: readonly string[]): Promise<string | null> {
  try {
    const result = await execFileAsync('git', ['-C', cwd, ...args], {
      encoding: 'utf8',
      timeout: GIT_TIMEOUT_MS,
      maxBuffer: 2 * 1024 * 1024,
      windowsHide: true,
    });
    return result.stdout;
  } catch {
    return null;
  }
}

/** A short, local-only reading of the session checkout for the Workbench. */
export async function readWorkbenchWorkspace(cwd: string): Promise<WorkbenchWorkspaceSummary> {
  const fallback = resolve(cwd);
  const [rootOutput, branchOutput, gitDirOutput, commonDirOutput, statusOutput] = await Promise.all([
    git(fallback, ['rev-parse', '--show-toplevel']),
    git(fallback, ['branch', '--show-current']),
    git(fallback, ['rev-parse', '--absolute-git-dir']),
    git(fallback, ['rev-parse', '--git-common-dir']),
    git(fallback, ['status', '--porcelain=v1', '--untracked-files=all']),
  ]);
  if (rootOutput === null || statusOutput === null) {
    return {
      root: fallback,
      branch: null,
      linkedWorktree: false,
      observed: false,
      changedFiles: null,
      changes: [],
    };
  }
  const root = resolve(rootOutput.trim());
  const changes = statusOutput.split(/\r?\n/u).flatMap((line) => {
    if (line.length < 4) return [];
    const status = line.slice(0, 2).trim() || '??';
    const path = line.slice(3).trim();
    return path === '' ? [] : [{ status, path }];
  });
  const gitDir = gitDirOutput === null ? null : resolve(fallback, gitDirOutput.trim());
  const commonDir = commonDirOutput === null ? null : resolve(fallback, commonDirOutput.trim());
  return {
    root,
    branch: branchOutput?.trim() || null,
    linkedWorktree: gitDir !== null && commonDir !== null && gitDir !== commonDir,
    observed: true,
    changedFiles: changes.length,
    changes: changes.slice(0, 3),
  };
}
