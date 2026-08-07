// electron/ipc/git-handlers.ts
// Read-only Git IPC for session detail and the Code Review workspace.
// All commands use argument arrays, disable external diff drivers, and keep
// requests scoped to the active project directory. This module never stages,
// commits, pushes, or writes Git state.

import { spawnSync, type SpawnSyncReturns } from 'child_process';
import { ipcMain } from 'electron';
import * as fs from 'fs';
import * as path from 'path';
import { getDatabase } from './db-handlers';

const GIT_TIMEOUT_MS = 5_000;
const MAX_DIFF_BYTES = 1_000_000;
const GIT_DIFF_ARGS = ['diff', '--numstat', 'HEAD'];
const GIT_REVIEW_STATUS_ARGS = ['status', '--porcelain=v1', '-z', '--untracked-files=all'];
const GIT_BRANCH_ARGS = ['branch', '--show-current'];
const GIT_PATCH_ARGS = ['diff', '--no-ext-diff', '--no-color', '--unified=20', 'HEAD', '--'];
const GIT_UNTRACKED_PATCH_ARGS = ['diff', '--no-index', '--no-color', '--unified=20', '--'];

import type {
  GitStatusFileChange,
  GitStatusTotals,
  GitStatusResult,
  GitReviewFileStatus,
  GitReviewFile,
  GitReviewResult,
  GitReviewDiffResult,
  GitReviewFullDiffResult,
  GitTurnReview,
  GitLatestTurnReviewResult,
  ReviewScopeParams,
  GitCommitInfo,
  GitListCommitsResult,
} from './git-types';

function isGitRepoDir(cwd: string): boolean {
  try {
    // `.git` can be a directory or a worktree/submodule pointer file.
    return fs.existsSync(path.join(cwd, '.git'));
  } catch {
    return false;
  }
}

function runGit(cwd: string, args: string[], maxBuffer = MAX_DIFF_BYTES): SpawnSyncReturns<string> {
  return spawnSync('git', args, {
    cwd,
    encoding: 'utf-8',
    timeout: GIT_TIMEOUT_MS,
    maxBuffer,
  });
}

function stdoutOf(result: SpawnSyncReturns<string>): string | null {
  if (result.error || typeof result.stdout !== 'string') return null;
  return result.stdout;
}

function didExceedDiffBuffer(result: SpawnSyncReturns<string>): boolean {
  return (result.error as NodeJS.ErrnoException | undefined)?.code === 'ENOBUFS';
}

/** Keep the partial stdout when the bounded diff buffer is exhausted. */
function patchStdoutOf(result: SpawnSyncReturns<string>): string | null {
  if (typeof result.stdout !== 'string') return null;
  if (result.error && !didExceedDiffBuffer(result)) return null;
  return result.stdout;
}

/** Parse `git diff --numstat HEAD` output. */
export function parseNumstat(output: string): GitStatusFileChange[] {
  const changes: GitStatusFileChange[] = [];
  for (const raw of output.split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    const parts = line.split('\t');
    if (parts.length < 3) continue;
    const additions = parts[0] === '-' ? 0 : Number.parseInt(parts[0], 10);
    const removals = parts[1] === '-' ? 0 : Number.parseInt(parts[1], 10);
    if (Number.isNaN(additions) || Number.isNaN(removals)) continue;
    changes.push({ path: parts.slice(2).join('\t'), additions, removals });
  }
  return changes;
}

function computeTotals(changes: GitStatusFileChange[], fileCount = changes.length): GitStatusTotals {
  return changes.reduce(
    (totals, change) => ({
      additions: totals.additions + change.additions,
      removals: totals.removals + change.removals,
      fileCount,
    }),
    { additions: 0, removals: 0, fileCount },
  );
}

function countFileLines(absolutePath: string): number {
  try {
    const content = fs.readFileSync(absolutePath, 'utf-8');
    if (content === '') return 0;
    let count = 0;
    for (let index = 0; index < content.length; index += 1) {
      if (content[index] === '\n') count += 1;
    }
    return content.endsWith('\n') ? count : count + 1;
  } catch {
    return 0;
  }
}

function boundedPatchPart(patch: string, maxBytes: number): { patch: string; truncated: boolean } {
  const bytes = Buffer.byteLength(patch, 'utf8');
  if (bytes <= maxBytes) return { patch, truncated: false };
  let buffer = Buffer.from(patch, 'utf8').subarray(0, maxBytes);
  const lastNewline = buffer.lastIndexOf('\n');
  if (lastNewline > 0) buffer = buffer.subarray(0, lastNewline + 1);
  return { patch: buffer.toString('utf8'), truncated: true };
}

function reviewStatusFromPorcelain(indexStatus: string, worktreeStatus: string): GitReviewFileStatus | null {
  if (indexStatus === '?' && worktreeStatus === '?') return 'untracked';
  if (indexStatus === 'D' || worktreeStatus === 'D') return 'deleted';
  if (indexStatus === 'R' || worktreeStatus === 'R') return 'renamed';
  if (indexStatus === 'A' || worktreeStatus === 'A') return 'added';
  if (indexStatus === 'M' || worktreeStatus === 'M' || indexStatus === 'T' || worktreeStatus === 'T') {
    return 'modified';
  }
  return null;
}

/** Parse `git status --porcelain=v1 -z`, including rename's second path field. */
export function parsePorcelainStatus(output: string): Array<{
  path: string;
  status: GitReviewFileStatus;
  oldPath?: string;
}> {
  const entries = output.split('\0');
  const files: Array<{ path: string; status: GitReviewFileStatus; oldPath?: string }> = [];

  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index];
    if (!entry || entry.length < 4) continue;

    const status = reviewStatusFromPorcelain(entry[0], entry[1]);
    if (!status || entry.slice(0, 3) !== `${entry[0]}${entry[1]} `) continue;

    const file: { path: string; status: GitReviewFileStatus; oldPath?: string } = {
      path: entry.slice(3),
      status,
    };
    if (status === 'renamed') {
      const oldPath = entries[index + 1];
      if (oldPath) {
        file.oldPath = oldPath;
        index += 1;
      }
    }
    files.push(file);
  }

  return files;
}

function readReviewFiles(cwd: string): GitReviewFile[] | null {
  const porcelain = stdoutOf(runGit(cwd, GIT_REVIEW_STATUS_ARGS));
  if (porcelain === null) return null;

  const files = parsePorcelainStatus(porcelain);
  if (files.length === 0) return [];

  const trackedPaths = files.filter((file) => file.status !== 'untracked').map((file) => file.path);
  const statsByPath = new Map<string, GitStatusFileChange>();

  if (trackedPaths.length > 0) {
    const numstat = stdoutOf(runGit(cwd, ['diff', '--numstat', '-M', '-C', 'HEAD', '--', ...trackedPaths]));
    if (numstat !== null) {
      for (const change of parseNumstat(numstat)) {
        const renameMatch = change.path.match(/^(.+?)\s+->\s+(.+)$/);
        const key = renameMatch ? renameMatch[2] : change.path;
        statsByPath.set(key, change);
      }
    }
  }

  return files.map((file) => {
    if (file.status === 'untracked') {
      const additions = countFileLines(path.join(cwd, file.path));
      return { path: file.path, status: file.status, additions, removals: 0 };
    }
    const stats = statsByPath.get(file.path);
    return {
      path: file.path,
      status: file.status,
      oldPath: file.oldPath,
      additions: stats?.additions ?? 0,
      removals: stats?.removals ?? 0,
    };
  });
}

function resolveReviewPath(cwd: string, requestedPath: unknown): { absolutePath: string; relativePath: string } | null {
  if (typeof requestedPath !== 'string' || requestedPath.length === 0 || path.isAbsolute(requestedPath)) {
    return null;
  }

  const absolutePath = path.resolve(cwd, requestedPath);
  const relativePath = path.relative(cwd, absolutePath);
  if (
    !relativePath ||
    relativePath === '..' ||
    relativePath.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relativePath) ||
    relativePath.split(path.sep).includes('.git')
  ) {
    return null;
  }
  return { absolutePath, relativePath: relativePath.split(path.sep).join('/') };
}

/**
 * Git can diff an untracked path directly, which would follow a symlink outside
 * the project. Resolve both ends before issuing the no-index fallback.
 */
function resolvesInsideWorkspace(cwd: string, absolutePath: string): boolean {
  try {
    const realWorkspace = fs.realpathSync(cwd);
    const realTarget = fs.realpathSync(absolutePath);
    const relativePath = path.relative(realWorkspace, realTarget);
    return (
      relativePath !== '' &&
      relativePath !== '..' &&
      !relativePath.startsWith(`..${path.sep}`) &&
      !path.isAbsolute(relativePath)
    );
  } catch {
    return false;
  }
}

function isBinaryPatch(patch: string): boolean {
  return patch.includes('Binary files ') || patch.includes('GIT binary patch');
}

function boundedPatch(output: string): Pick<GitReviewDiffResult, 'patch' | 'truncated'> {
  if (Buffer.byteLength(output, 'utf8') <= MAX_DIFF_BYTES) return { patch: output };
  return {
    patch: output.slice(0, MAX_DIFF_BYTES),
    truncated: true,
  };
}

function buildFullPatch(cwd: string, files: GitReviewFile[]): { patch: string; truncated: boolean } | null {
  const tracked = files.filter((file) => file.status !== 'untracked');
  const untracked = files.filter((file) => file.status === 'untracked');
  const parts: string[] = [];
  let truncated = false;
  let usedBytes = 0;

  if (tracked.length > 0) {
    const result = runGit(cwd, ['diff', '--no-ext-diff', '--no-color', '--unified=20', 'HEAD', '--', ...tracked.map((file) => file.path)]);
    const patch = patchStdoutOf(result);
    if (patch !== null) {
      parts.push(patch);
      usedBytes += Buffer.byteLength(patch, 'utf8');
      if (didExceedDiffBuffer(result)) truncated = true;
    }
  }

  const emptyFile = process.platform === 'win32' ? 'NUL' : '/dev/null';
  for (const file of untracked) {
    const absolutePath = path.resolve(cwd, file.path);
    if (!resolvesInsideWorkspace(cwd, absolutePath)) continue;
    const result = runGit(cwd, ['diff', '--no-index', '--no-color', '--unified=20', emptyFile, file.path]);
    const patch = patchStdoutOf(result);
    if (patch === null || patch === '') continue;
    const bounded = boundedPatchPart(patch, MAX_DIFF_BYTES - usedBytes);
    parts.push(bounded.patch);
    usedBytes += Buffer.byteLength(bounded.patch, 'utf8');
    if (bounded.truncated) truncated = true;
  }

  return { patch: parts.join(''), truncated };
}

function parseStoredTurnFiles(value: unknown): GitReviewFile[] | null {
  if (!Array.isArray(value)) return null;
  const files: GitReviewFile[] = [];
  for (const entry of value) {
    if (!entry || typeof entry !== 'object') return null;
    const file = entry as Record<string, unknown>;
    if (
      typeof file.path !== 'string'
      || !['modified', 'added', 'deleted', 'renamed', 'untracked'].includes(file.status as string)
      || typeof file.additions !== 'number'
      || typeof file.removals !== 'number'
    ) return null;
    files.push({
      path: file.path,
      status: file.status as GitReviewFileStatus,
      oldPath: typeof file.oldPath === 'string' ? file.oldPath : undefined,
      additions: file.additions,
      removals: file.removals,
    });
  }
  return files;
}

function readLatestTurnReview(sessionId: string, cwd: string): GitLatestTurnReviewResult {
  const db = getDatabase();
  if (!db) return { isGitRepo: true, error: 'Review history is unavailable.' };
  // Plan 328: chat_turn_reviews no longer joins chat_sessions (FK dropped in
  // migration 47). working_directory is stored on chat_turn_reviews directly.
  const row = db.prepare(`
    SELECT id, session_id, turn_id, working_directory, files_json,
           patch, additions, removals, truncated, binary, captured_at
    FROM chat_turn_reviews
    WHERE session_id = ? AND working_directory = ?
    ORDER BY captured_at DESC
    LIMIT 1
  `).get(sessionId, cwd) as {
    id: string;
    session_id: string;
    turn_id: string;
    working_directory: string;
    files_json: string;
    patch: string;
    additions: number;
    removals: number;
    truncated: number;
    binary: number;
    captured_at: number;
  } | undefined;
  if (!row) return { isGitRepo: true };
  try {
    const files = parseStoredTurnFiles(JSON.parse(row.files_json));
    if (!files) return { isGitRepo: true, error: 'Stored review history is invalid.' };
    return {
      isGitRepo: true,
      review: {
        id: row.id,
        sessionId: row.session_id,
        turnId: row.turn_id,
        workingDirectory: row.working_directory,
        files,
        totals: { additions: row.additions, removals: row.removals, fileCount: files.length },
        patch: row.patch,
        truncated: row.truncated === 1,
        binary: row.binary === 1,
        capturedAt: row.captured_at,
      },
    };
  } catch {
    return { isGitRepo: true, error: 'Stored review history is invalid.' };
  }
}

// ── Scoped review helpers (plan 227) ──────────────────────────────

const COMMIT_HASH_RE = /^[0-9a-f]{7,40}$/i;

function isValidCommitHash(value: string): boolean {
  return COMMIT_HASH_RE.test(value);
}

/** Build `git diff` args for a scoped full patch (no --numstat). */
function buildScopeDiffArgs(scope: ReviewScopeParams): string[] {
  switch (scope.type) {
    case 'uncommitted':
      return ['diff', '--no-ext-diff', '--no-color', '--unified=20', 'HEAD'];
    case 'unstaged':
      return ['diff', '--no-ext-diff', '--no-color', '--unified=20'];
    case 'staged':
      return ['diff', '--no-ext-diff', '--no-color', '--unified=20', '--cached'];
    case 'commit': {
      const from = scope.commitFrom ?? 'HEAD~1';
      const to = scope.commitTo ?? 'HEAD';
      if (!isValidCommitHash(from) || !isValidCommitHash(to)) return [];
      return ['diff', '--no-ext-diff', '--no-color', '--unified=20', from, to];
    }
    default:
      return [];
  }
}

/** Build `git diff --numstat` args for the file list. */
function buildScopeNumstatArgs(scope: ReviewScopeParams): string[] {
  switch (scope.type) {
    case 'uncommitted':
      return ['diff', '--numstat', 'HEAD'];
    case 'unstaged':
      return ['diff', '--numstat'];
    case 'staged':
      return ['diff', '--numstat', '--cached'];
    case 'commit': {
      const from = scope.commitFrom ?? 'HEAD~1';
      const to = scope.commitTo ?? 'HEAD';
      if (!isValidCommitHash(from) || !isValidCommitHash(to)) return [];
      return ['diff', '--numstat', from, to];
    }
    default:
      return [];
  }
}

function readScopedReviewFiles(cwd: string, scope: ReviewScopeParams): GitReviewFile[] | null {
  const numstatArgs = buildScopeNumstatArgs(scope);
  if (numstatArgs.length === 0) return null;
  const numstat = stdoutOf(runGit(cwd, numstatArgs));
  if (numstat === null) return null;
  const changes = parseNumstat(numstat);
  if (changes.length === 0) return [];
  return changes.map((change) => ({
    ...change,
    status: 'modified' as GitReviewFileStatus,
  }));
}

function buildScopedFullPatch(cwd: string, scope: ReviewScopeParams): { patch: string; truncated: boolean } | null {
  const diffArgs = buildScopeDiffArgs(scope);
  if (diffArgs.length === 0) return null;
  const result = runGit(cwd, diffArgs);
  const patch = patchStdoutOf(result);
  if (patch === null) return null;
  return {
    patch,
    truncated: didExceedDiffBuffer(result),
  };
}

function buildScopedSinglePatch(
  cwd: string,
  scope: ReviewScopeParams,
  relativePath: string,
): { patch: string; truncated: boolean } | null {
  const baseArgs = buildScopeDiffArgs(scope);
  if (baseArgs.length === 0) return null;
  const result = runGit(cwd, [...baseArgs, '--', relativePath]);
  const patch = patchStdoutOf(result);
  if (patch === null) return null;
  return {
    patch,
    truncated: didExceedDiffBuffer(result),
  };
}

// ── Register ──────────────────────────────────────────────────────

export function registerGitHandlers(): void {
  ipcMain.handle('git:status', async (_event, cwd: unknown): Promise<GitStatusResult> => {
    if (typeof cwd !== 'string' || cwd.length === 0 || !isGitRepoDir(cwd)) {
      return { isGitRepo: false };
    }

    try {
      const stdout = stdoutOf(runGit(cwd, GIT_DIFF_ARGS));
      if (stdout === null) return { isGitRepo: false };
      const fileChanges = parseNumstat(stdout);
      return { isGitRepo: true, fileChanges, totals: computeTotals(fileChanges) };
    } catch {
      return { isGitRepo: false };
    }
  });

  ipcMain.handle('git:review', async (_event, cwd: unknown): Promise<GitReviewResult> => {
    if (typeof cwd !== 'string' || cwd.length === 0 || !isGitRepoDir(cwd)) {
      return { isGitRepo: false };
    }

    try {
      const files = readReviewFiles(cwd);
      if (!files) return { isGitRepo: false };
      const branch = stdoutOf(runGit(cwd, GIT_BRANCH_ARGS, 16 * 1024))?.trim() || 'HEAD';
      return {
        isGitRepo: true,
        branch,
        baseRef: 'HEAD',
        files,
        totals: computeTotals(files, files.length),
      };
    } catch {
      return { isGitRepo: false };
    }
  });

  ipcMain.handle('git:review-full-diff', async (_event, cwd: unknown): Promise<GitReviewFullDiffResult> => {
    if (typeof cwd !== 'string' || cwd.length === 0 || !isGitRepoDir(cwd)) {
      return { isGitRepo: false };
    }

    try {
      const files = readReviewFiles(cwd);
      if (!files) return { isGitRepo: false };
      const fullPatch = buildFullPatch(cwd, files);
      if (!fullPatch) return { isGitRepo: true, error: 'Unable to load diff.' };
      return {
        isGitRepo: true,
        patch: fullPatch.patch,
        truncated: fullPatch.truncated || undefined,
        binary: isBinaryPatch(fullPatch.patch),
      };
    } catch {
      return { isGitRepo: true, error: 'Unable to load diff.' };
    }
  });

  ipcMain.handle('git:review-latest-turn', async (_event, sessionId: unknown, cwd: unknown): Promise<GitLatestTurnReviewResult> => {
    if (
      typeof sessionId !== 'string'
      || sessionId.length === 0
      || typeof cwd !== 'string'
      || cwd.length === 0
      || !isGitRepoDir(cwd)
    ) {
      return { isGitRepo: false };
    }
    try {
      return readLatestTurnReview(sessionId, cwd);
    } catch {
      return { isGitRepo: true, error: 'Unable to load review history.' };
    }
  });

  ipcMain.handle('git:review-diff', async (_event, cwd: unknown, requestedPath: unknown): Promise<GitReviewDiffResult> => {
    if (typeof cwd !== 'string' || cwd.length === 0 || !isGitRepoDir(cwd)) {
      return { isGitRepo: false };
    }
    const target = resolveReviewPath(cwd, requestedPath);
    if (!target) return { isGitRepo: true, error: 'Invalid review path.' };

    try {
      const files = readReviewFiles(cwd);
      const file = files?.find((entry) => entry.path === target.relativePath);
      if (!files || !file) {
        return { isGitRepo: true, path: target.relativePath, error: 'File has no uncommitted changes.' };
      }

      let result = runGit(cwd, [...GIT_PATCH_ARGS, target.relativePath]);
      let patch = patchStdoutOf(result);

      if (patch === '' && file.status === 'untracked') {
        if (!resolvesInsideWorkspace(cwd, target.absolutePath)) {
          return {
            isGitRepo: true,
            path: target.relativePath,
            error: 'Untracked paths outside the workspace cannot be reviewed inline.',
          };
        }
        const emptyFile = process.platform === 'win32' ? 'NUL' : '/dev/null';
        result = runGit(cwd, [...GIT_UNTRACKED_PATCH_ARGS, emptyFile, target.absolutePath]);
        patch = patchStdoutOf(result);
      }

      if (patch === null) {
        return { isGitRepo: true, path: target.relativePath, error: 'Unable to load this diff.' };
      }
      const bounded = boundedPatch(patch);
      return {
        isGitRepo: true,
        path: target.relativePath,
        ...bounded,
        truncated: bounded.truncated || didExceedDiffBuffer(result) || undefined,
        binary: isBinaryPatch(patch),
      };
    } catch {
      return { isGitRepo: true, path: target.relativePath, error: 'Unable to load this diff.' };
    }
  });

  // ── Scoped review handlers (plan 227) ───────────────────────────

  ipcMain.handle('git:review-scoped', async (_event, cwd: unknown, scope: unknown): Promise<GitReviewResult> => {
    if (typeof cwd !== 'string' || cwd.length === 0 || !isGitRepoDir(cwd)) {
      return { isGitRepo: false };
    }
    if (!scope || typeof scope !== 'object' || typeof (scope as Record<string, unknown>).type !== 'string') {
      return { isGitRepo: false };
    }
    const params = scope as ReviewScopeParams;
    if (!['uncommitted', 'unstaged', 'staged', 'commit'].includes(params.type)) {
      return { isGitRepo: false };
    }

    try {
      const files = readScopedReviewFiles(cwd, params);
      if (!files) return { isGitRepo: false };
      const fullPatch = buildScopedFullPatch(cwd, params);
      return {
        isGitRepo: true,
        branch: params.type === 'commit'
          ? `${params.commitFrom?.slice(0, 7) ?? '?'} → ${params.commitTo?.slice(0, 7) ?? '?'}`
          : undefined,
        baseRef: scopeLabel(params),
        files,
        totals: computeTotals(files, files.length),
        patch: fullPatch?.patch,
        truncated: fullPatch?.truncated,
        binary: fullPatch ? isBinaryPatch(fullPatch.patch) : undefined,
      };
    } catch {
      return { isGitRepo: false };
    }
  });

  ipcMain.handle('git:review-scoped-diff', async (_event, cwd: unknown, scope: unknown, requestedPath: unknown): Promise<GitReviewDiffResult> => {
    if (typeof cwd !== 'string' || cwd.length === 0 || !isGitRepoDir(cwd)) {
      return { isGitRepo: false };
    }
    if (!scope || typeof scope !== 'object' || typeof (scope as Record<string, unknown>).type !== 'string') {
      return { isGitRepo: false };
    }
    const params = scope as ReviewScopeParams;
    const target = resolveReviewPath(cwd, requestedPath);
    if (!target) return { isGitRepo: true, error: 'Invalid review path.' };

    try {
      const singlePatch = buildScopedSinglePatch(cwd, params, target.relativePath);
      if (!singlePatch) return { isGitRepo: true, path: target.relativePath, error: 'Unable to load this diff.' };
      const bounded = boundedPatch(singlePatch.patch);
      return {
        isGitRepo: true,
        path: target.relativePath,
        ...bounded,
        truncated: bounded.truncated || singlePatch.truncated || undefined,
        binary: isBinaryPatch(singlePatch.patch),
      };
    } catch {
      return { isGitRepo: true, path: target.relativePath, error: 'Unable to load this diff.' };
    }
  });

  ipcMain.handle('git:list-commits', async (_event, cwd: unknown, count: unknown): Promise<GitListCommitsResult> => {
    if (typeof cwd !== 'string' || cwd.length === 0 || !isGitRepoDir(cwd)) {
      return { commits: [] };
    }
    const limit = typeof count === 'number' && count > 0 && count <= 200 ? count : 50;
    try {
      const output = stdoutOf(runGit(cwd, ['log', '--oneline', `-n${limit}`, '--format=%H %s'], 256 * 1024));
      if (!output) return { commits: [] };
      const commits: GitCommitInfo[] = [];
      for (const line of output.trim().split('\n')) {
        const spaceIndex = line.indexOf(' ');
        if (spaceIndex < 7) continue;
        commits.push({
          hash: line.slice(0, spaceIndex),
          subject: line.slice(spaceIndex + 1),
        });
      }
      return { commits };
    } catch {
      return { commits: [] };
    }
  });
}

/** Human-readable label for the scope selector. */
function scopeLabel(scope: ReviewScopeParams): string {
  switch (scope.type) {
    case 'uncommitted': return 'HEAD → 工作区';
    case 'unstaged':   return '索引 → 工作区';
    case 'staged':     return 'HEAD → 索引';
    case 'commit':     return `${scope.commitFrom?.slice(0, 7) ?? '?'} → ${scope.commitTo?.slice(0, 7) ?? '?'}`;
    default:           return '?';
  }
}
