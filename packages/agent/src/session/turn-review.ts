import { spawnSync, type SpawnSyncReturns } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const GIT_TIMEOUT_MS = 5_000;
export const MAX_TURN_REVIEW_DIFF_BYTES = 1_000_000;

export type TurnReviewFileStatus = 'modified' | 'added' | 'deleted' | 'renamed' | 'untracked';

export interface TurnReviewFile {
  path: string;
  status: TurnReviewFileStatus;
  oldPath?: string;
  additions: number;
  removals: number;
}

export interface TurnReviewBaseline {
  workingDirectory: string;
  tree: string;
}

export interface CompletedTurnReview {
  workingDirectory: string;
  files: TurnReviewFile[];
  patch: string;
  additions: number;
  removals: number;
  truncated: boolean;
  binary: boolean;
}

function runGit(
  cwd: string,
  args: string[],
  options: { env?: NodeJS.ProcessEnv; maxBuffer?: number } = {},
): SpawnSyncReturns<string> {
  return spawnSync('git', args, {
    cwd,
    encoding: 'utf8',
    timeout: GIT_TIMEOUT_MS,
    maxBuffer: options.maxBuffer ?? MAX_TURN_REVIEW_DIFF_BYTES,
    env: options.env,
  });
}

function stdoutOf(result: SpawnSyncReturns<string>): string | null {
  return result.error || typeof result.stdout !== 'string' ? null : result.stdout;
}

function patchStdoutOf(result: SpawnSyncReturns<string>): string | null {
  const code = (result.error as NodeJS.ErrnoException | undefined)?.code;
  if (result.error && code !== 'ENOBUFS') return null;
  return typeof result.stdout === 'string' ? result.stdout : null;
}

function wasTruncated(result: SpawnSyncReturns<string>): boolean {
  return (result.error as NodeJS.ErrnoException | undefined)?.code === 'ENOBUFS';
}

/**
 * Materialize the complete working tree into an isolated index and return its
 * tree object. The user's real index is never read from or written to.
 */
function captureWorkingTree(cwd: string): string | null {
  const repo = stdoutOf(runGit(cwd, ['rev-parse', '--is-inside-work-tree'], { maxBuffer: 16 * 1024 }));
  if (repo?.trim() !== 'true') return null;

  const tempDirectory = mkdtempSync(join(tmpdir(), 'duya-turn-review-'));
  const indexPath = join(tempDirectory, 'index');
  const env = { ...process.env, GIT_INDEX_FILE: indexPath };
  try {
    const readTree = runGit(cwd, ['read-tree', 'HEAD'], { env, maxBuffer: 16 * 1024 });
    if (readTree.error || readTree.status !== 0) return null;
    const add = runGit(cwd, ['add', '-A'], { env, maxBuffer: 16 * 1024 });
    if (add.error || add.status !== 0) return null;
    const tree = stdoutOf(runGit(cwd, ['write-tree'], { env, maxBuffer: 16 * 1024 }));
    return tree?.trim() || null;
  } finally {
    // Best-effort cleanup. On Windows the git child process may have
    // just exited but the OS can still hold `index.lock` for a few
    // milliseconds, causing EBUSY/EPERM. `force: true` only ignores
    // ENOENT, so swallow transient FS errors here — the OS temp-dir
    // reaper will eventually clean up.
    try {
      rmSync(tempDirectory, { recursive: true, force: true });
    } catch {
      // Intentionally empty: temp dir cleanup is best-effort.
    }
  }
}

function statusFromCode(code: string): TurnReviewFileStatus {
  switch (code) {
    case 'A': return 'added';
    case 'D': return 'deleted';
    case 'R': return 'renamed';
    default: return 'modified';
  }
}

function readFiles(cwd: string, baseTree: string, currentTree: string): TurnReviewFile[] | null {
  const status = stdoutOf(runGit(cwd, ['diff', '--name-status', '-z', '-M', baseTree, currentTree]));
  if (status === null) return null;

  const stats = stdoutOf(runGit(cwd, ['diff', '--numstat', '-z', '-M', baseTree, currentTree]));
  if (stats === null) return null;

  const statsByPath = new Map<string, { additions: number; removals: number }>();
  const statTokens = stats.split('\0');
  for (let index = 0; index < statTokens.length; index += 1) {
    const entry = statTokens[index];
    if (!entry) continue;
    const parts = entry.split('\t');
    if (parts.length < 3) continue;
    const additions = parts[0] === '-' ? 0 : Number.parseInt(parts[0], 10);
    const removals = parts[1] === '-' ? 0 : Number.parseInt(parts[1], 10);
    if (Number.isNaN(additions) || Number.isNaN(removals)) continue;
    let targetPath = parts.slice(2).join('\t');
    if (!targetPath) {
      index += 2;
      targetPath = statTokens[index] ?? '';
    }
    if (targetPath) statsByPath.set(targetPath, { additions, removals });
  }

  const files: TurnReviewFile[] = [];
  const tokens = status.split('\0');
  for (let index = 0; index < tokens.length; index += 1) {
    const entry = tokens[index];
    if (!entry) continue;
    const code = entry[0];
    if (!code) continue;
    if (code === 'R' || code === 'C') {
      const oldPath = tokens[index + 1];
      const path = tokens[index + 2];
      index += 2;
      if (!path) continue;
      const stat = statsByPath.get(path);
      files.push({ path, oldPath: oldPath || undefined, status: 'renamed', additions: stat?.additions ?? 0, removals: stat?.removals ?? 0 });
      continue;
    }
    const path = tokens[index + 1];
    index += 1;
    if (!path) continue;
    const stat = statsByPath.get(path);
    files.push({ path, status: statusFromCode(code), additions: stat?.additions ?? 0, removals: stat?.removals ?? 0 });
  }
  return files;
}

export function captureTurnReviewBaseline(workingDirectory: string): TurnReviewBaseline | null {
  if (!workingDirectory) return null;
  const tree = captureWorkingTree(workingDirectory);
  return tree ? { workingDirectory, tree } : null;
}

export function completeTurnReview(baseline: TurnReviewBaseline): CompletedTurnReview | null {
  const currentTree = captureWorkingTree(baseline.workingDirectory);
  if (!currentTree) return null;
  const files = readFiles(baseline.workingDirectory, baseline.tree, currentTree);
  if (!files) return null;

  const result = runGit(
    baseline.workingDirectory,
    ['diff', '--no-ext-diff', '--no-color', '--binary', '--unified=20', '-M', baseline.tree, currentTree],
  );
  const patch = patchStdoutOf(result);
  if (patch === null) return null;

  return {
    workingDirectory: baseline.workingDirectory,
    files,
    patch,
    additions: files.reduce((total, file) => total + file.additions, 0),
    removals: files.reduce((total, file) => total + file.removals, 0),
    truncated: wasTruncated(result),
    binary: patch.includes('Binary files ') || patch.includes('GIT binary patch'),
  };
}
