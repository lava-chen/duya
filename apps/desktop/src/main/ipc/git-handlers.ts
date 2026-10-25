// apps/desktop/src/main/ipc/git-handlers.ts
// Read-only Git IPC for session detail and the Code Review workspace.
// All commands use argument arrays, disable external diff drivers, and keep
// requests scoped to the active project directory. This module never stages,
// commits, pushes, or writes Git state.

import { spawnSync, type SpawnSyncReturns } from 'child_process';
import { ipcMain } from 'electron';
import * as fs from 'fs';
import * as path from 'path';
import { getDesktopHostLocalTurnReviewApi } from '../cli/desktop-host-api';

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
  GitTurnHistoryEntry,
  GitTurnHistoryResult,
  ReviewScopeParams,
  GitCommitInfo,
  GitListCommitsResult,
  GitListCommitsOptions,
  GitListBranchesResult,
  GitBranchRef,
  GitRepositoryState,
  GitCommitDetailResult,
} from '../../contracts/git';
import type { HostLocalTurnReviewRecord } from '@duya/agent-protocol';

function isGitRepoDir(cwd: string): boolean {
  try {
    // `.git` can be a directory or a worktree/submodule pointer file.
    return fs.existsSync(path.join(cwd, '.git'));
  } catch {
    return false;
  }
}

function runGit(cwd: string, args: string[], maxBuffer = MAX_DIFF_BYTES): SpawnSyncReturns<string> {
  return spawnSync('git', [...gitSafetyArgs(), ...args], {
    cwd,
    encoding: 'utf-8',
    timeout: GIT_TIMEOUT_MS,
    maxBuffer,
  });
}

// ── Executable-config hardening ──────────────────────────────────
//
// Everything below renders diffs of repositories the user may not control, so
// the Git configuration that Git reads is itself untrusted input: a repo can
// ship a `.gitattributes` naming a filter driver, and if that driver is defined
// anywhere in the config chain, `git diff` runs it as a shell command. The same
// is true of hooks. A read-only review panel has no reason to execute either.
//
// Three layers, matching what the reference implementation does:
//
//   1. `core.hooksPath` → the null device, so no hook is found to run. Applied
//      on EVERY call, because there is no reason to scope it to diffs.
//   2. Filter drivers are enumerated and neutralized per call (below).
//   3. `--no-ext-diff --no-textconv`, injected centrally by `runGitDiff`
//      rather than repeated in each argument list. Both disable a config-driven
//      executable path; neither is valid on `git status`/`git log`, which is
//      why they cannot simply live on `runGit`.

/** The platform's null device, used to point hooks and diffs at "nothing". */
const NULL_DEVICE = process.platform === 'win32' ? 'NUL' : '/dev/null';

/** `-c` overrides applied to every Git invocation. */
function gitSafetyArgs(): string[] {
  return ['-c', `core.hooksPath=${NULL_DEVICE}`];
}

/** Keys that make a configured filter driver executable. */
const EXECUTABLE_FILTER_PATTERN = '^filter\\..*\\.(clean|process)$';

/**
 * `-c` overrides that neutralize every configured filter driver.
 *
 * Git has no "disable all filters" switch, so the drivers are enumerated
 * first and each one is then overridden. Empty `clean`/`process` means "no
 * filter"; `required=false` keeps Git from failing when the (now absent)
 * command is looked up. Enumerating rather than guessing names is what makes
 * this complete — an attacker picks the driver name.
 *
 * Not cached: the enumeration is one extra short-lived process per diff call,
 * and diffs are user-initiated rather than per-frame. A cache would make a
 * newly added filter survive for the rest of the session, which is the one
 * direction of staleness that matters.
 */
function filterNeutralizerArgs(cwd: string): string[] {
  const result = spawnSync('git', [...gitSafetyArgs(), 'config', '--null', '--name-only', '--get-regexp', EXECUTABLE_FILTER_PATTERN], {
    cwd,
    encoding: 'utf-8',
    timeout: GIT_TIMEOUT_MS,
  });
  // Exit 1 means "no matches", which is the common case — not a failure.
  if (result.error || (result.status !== 0 && result.status !== 1) || typeof result.stdout !== 'string') {
    return [];
  }

  const drivers = new Set<string>();
  for (const key of result.stdout.split('\0')) {
    const driver = key.endsWith('.clean')
      ? key.slice(0, -'.clean'.length)
      : key.endsWith('.process')
        ? key.slice(0, -'.process'.length)
        : null;
    if (driver !== null && driver !== '') drivers.add(driver);
  }

  const args: string[] = [];
  for (const driver of drivers) {
    args.push('-c', `${driver}.clean=`, '-c', `${driver}.process=`, '-c', `${driver}.required=false`);
  }
  return args;
}

/**
 * Run a Git command that produces a diff.
 *
 * The diff-suppressing flags are inserted immediately after the subcommand so
 * a caller cannot forget them; every argument list in this file routes through
 * here instead of repeating `--no-ext-diff` by hand, which is how the previous
 * state of this file ended up with it on some paths and not others.
 */
function runGitDiff(cwd: string, args: string[], maxBuffer = MAX_DIFF_BYTES): SpawnSyncReturns<string> {
  const [subcommand, ...rest] = args;
  if (subcommand === undefined) return runGit(cwd, args, maxBuffer);
  const hardened = [subcommand, '--no-ext-diff', '--no-textconv', ...rest];
  return runGit(cwd, [...filterNeutralizerArgs(cwd), ...hardened], maxBuffer);
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
    const numstat = stdoutOf(runGitDiff(cwd, ['diff', '--numstat', '-M', '-C', 'HEAD', '--', ...trackedPaths]));
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
    const result = runGitDiff(cwd, ['diff', '--no-ext-diff', '--no-color', '--unified=20', 'HEAD', '--', ...tracked.map((file) => file.path)]);
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
    const result = runGitDiff(cwd, ['diff', '--no-index', '--no-color', '--unified=20', emptyFile, file.path]);
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

function rowToTurnReview(row: HostLocalTurnReviewRecord): GitTurnReview | null {
  try {
    const files = parseStoredTurnFiles(JSON.parse(row.filesJson));
    if (!files) return null;
    return {
      id: row.id,
      sessionId: row.sessionId,
      turnId: row.turnId,
      workingDirectory: row.workingDirectory,
      files,
      totals: { additions: row.additions, removals: row.removals, fileCount: files.length },
      patch: row.patch,
      truncated: row.truncated === 1,
      binary: row.binary === 1,
      capturedAt: row.capturedAt,
    };
  } catch {
    return null;
  }
}

function getTurnReviewApiOrNull() {
  try {
    return getDesktopHostLocalTurnReviewApi();
  } catch {
    return null;
  }
}

async function readLatestTurnReview(sessionId: string): Promise<GitLatestTurnReviewResult> {
  const api = getTurnReviewApiOrNull();
  if (!api) return { isGitRepo: true, error: 'Review history is unavailable.' };
  // Plan 308 Phase 2: match by session_id only. Filtering on the stored
  // working_directory with exact string equality silently returned no rows
  // whenever the agent cwd and the renderer cwd drifted in separators or
  // case on Windows. session_id is unique per session and indexed for this
  // lookup (idx_chat_turn_reviews_latest).
  const row = await api.getLatestTurnReview(sessionId);
  if (!row) return { isGitRepo: true };
  const review = rowToTurnReview(row);
  if (!review) return { isGitRepo: true, error: 'Stored review history is invalid.' };
  return { isGitRepo: true, review };
}

async function readTurnHistory(sessionId: string, limit: number): Promise<GitTurnHistoryResult> {
  const api = getTurnReviewApiOrNull();
  if (!api) return { isGitRepo: true, error: 'Review history is unavailable.' };
  const rows = await api.listTurnReviewHistory(sessionId, limit);
  const turns: GitTurnHistoryEntry[] = [];
  for (const row of rows) {
    let fileCount = 0;
    try {
      const parsed: unknown = JSON.parse(row.filesJson);
      if (Array.isArray(parsed)) fileCount = parsed.length;
    } catch {
      // Unreadable payload — still list the turn with a zero count.
    }
    turns.push({
      id: row.id,
      turnId: row.turnId,
      additions: row.additions,
      removals: row.removals,
      fileCount,
      capturedAt: row.capturedAt,
    });
  }
  return { isGitRepo: true, turns };
}

async function readTurnDetail(reviewId: string): Promise<GitLatestTurnReviewResult> {
  const api = getTurnReviewApiOrNull();
  if (!api) return { isGitRepo: true, error: 'Review history is unavailable.' };
  const row = await api.getTurnReviewById(reviewId);
  if (!row) return { isGitRepo: true };
  const review = rowToTurnReview(row);
  if (!review) return { isGitRepo: true, error: 'Stored review history is invalid.' };
  return { isGitRepo: true, review };
}

async function readTurnReviewByTurnId(sessionId: string, turnId: string): Promise<GitLatestTurnReviewResult> {
  const api = getTurnReviewApiOrNull();
  if (!api) return { isGitRepo: true, error: 'Review history is unavailable.' };
  const row = await api.getTurnReviewByTurnId(sessionId, turnId);
  if (!row) return { isGitRepo: true };
  const review = rowToTurnReview(row);
  if (!review) return { isGitRepo: true, error: 'Stored review history is invalid.' };
  return { isGitRepo: true, review };
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
  const numstat = stdoutOf(runGitDiff(cwd, numstatArgs));
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
  const result = runGitDiff(cwd, diffArgs);
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
  const result = runGitDiff(cwd, [...baseArgs, '--', relativePath]);
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
      const stdout = stdoutOf(runGitDiff(cwd, GIT_DIFF_ARGS));
      if (stdout === null) return { isGitRepo: false };
      const fileChanges = parseNumstat(stdout);
      // `git diff` misses untracked files; merge them in from porcelain so
      // a turn that only creates new files still surfaces (plan 308 Phase 2).
      const porcelain = stdoutOf(runGit(cwd, GIT_REVIEW_STATUS_ARGS));
      if (porcelain !== null) {
        const known = new Set(fileChanges.map((change) => change.path));
        for (const entry of parsePorcelainStatus(porcelain)) {
          if (entry.status !== 'untracked' || known.has(entry.path)) continue;
          fileChanges.push({
            path: entry.path,
            additions: countFileLines(path.join(cwd, entry.path)),
            removals: 0,
          });
        }
      }
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
      return await readLatestTurnReview(sessionId);
    } catch {
      return { isGitRepo: true, error: 'Unable to load review history.' };
    }
  });

  ipcMain.handle('git:review-turn-history', async (_event, sessionId: unknown, cwd: unknown, limit: unknown): Promise<GitTurnHistoryResult> => {
    if (
      typeof sessionId !== 'string'
      || sessionId.length === 0
      || typeof cwd !== 'string'
      || cwd.length === 0
      || !isGitRepoDir(cwd)
    ) {
      return { isGitRepo: false };
    }
    const capped = typeof limit === 'number' && limit > 0 && limit <= 200 ? Math.floor(limit) : 50;
    try {
      return await readTurnHistory(sessionId, capped);
    } catch {
      return { isGitRepo: true, error: 'Unable to load review history.' };
    }
  });

  ipcMain.handle('git:review-turn-detail', async (_event, cwd: unknown, reviewId: unknown): Promise<GitLatestTurnReviewResult> => {
    if (
      typeof reviewId !== 'string'
      || reviewId.length === 0
      || reviewId.length > 128
      || typeof cwd !== 'string'
      || cwd.length === 0
      || !isGitRepoDir(cwd)
    ) {
      return { isGitRepo: false };
    }
    try {
      return await readTurnDetail(reviewId);
    } catch {
      return { isGitRepo: true, error: 'Unable to load review history.' };
    }
  });

  ipcMain.handle('git:review-turn-by-turn-id', async (_event, sessionId: unknown, cwd: unknown, turnId: unknown): Promise<GitLatestTurnReviewResult> => {
    if (
      typeof sessionId !== 'string'
      || sessionId.length === 0
      || typeof cwd !== 'string'
      || cwd.length === 0
      || !isGitRepoDir(cwd)
      || typeof turnId !== 'string'
      || turnId.length === 0
    ) {
      return { isGitRepo: false };
    }
    try {
      return await readTurnReviewByTurnId(sessionId, turnId);
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

      let result = runGitDiff(cwd, [...GIT_PATCH_ARGS, target.relativePath]);
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
        result = runGitDiff(cwd, [...GIT_UNTRACKED_PATCH_ARGS, emptyFile, target.absolutePath]);
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
    if (!['uncommitted', 'unstaged', 'staged', 'commit', 'branch', 'commit-pair'].includes(params.type)) {
      return { isGitRepo: false };
    }

    try {
      const files = readScopedReviewFiles(cwd, params);
      if (!files) return { isGitRepo: false };
      const fullPatch = buildScopedFullPatch(cwd, params);
      return {
        isGitRepo: true,
        branch: scopeBranchLabel(params),
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

  ipcMain.handle('git:list-commits', async (_event, cwd: unknown, options: unknown): Promise<GitListCommitsResult> => {
    if (typeof cwd !== 'string' || cwd.length === 0 || !isGitRepoDir(cwd)) {
      return { commits: [] };
    }
    // Backwards-compatible signature: legacy callers passed a number for
    // `count` directly. Tolerate either form.
    const opts = normaliseListCommitsOptions(options);
    const limit = typeof opts.count === 'number' && opts.count > 0 && opts.count <= 200 ? opts.count : 50;
    const args: string[] = [
      'log',
      '--no-color',
      `--format=${GIT_LOG_FORMAT}`,
      '-z',
      `-n${limit}`,
    ];
    if (opts.ref && validateGitRef(opts.ref)) {
      args.push(opts.ref);
    }
    if (opts.grep) args.push('--grep', opts.grep);
    if (opts.author) args.push('--author', opts.author);
    try {
      const output = stdoutOf(runGit(cwd, args, 512 * 1024));
      if (!output) return { commits: [] };
      return { commits: parseCommitLogOutput(output) };
    } catch {
      return { commits: [] };
    }
  });

  ipcMain.handle('git:list-branches', async (_event, cwd: unknown): Promise<GitListBranchesResult> => {
    if (typeof cwd !== 'string' || cwd.length === 0 || !isGitRepoDir(cwd)) {
      return { isGitRepo: false, locals: [], remotes: [] };
    }
    // Single `for-each-ref` pass over both refs/heads and refs/remotes so
    // the result is consistent under concurrent ref creation. The format is
    // space-delimited: HEAD marker (only for the current local branch), full
    // refname, short SHA. A space is a legal delimiter because refnames and
    // object names can never contain one — unlike the previous concatenated
    // format, whose regex split silently ate the tail of any branch name
    // ending in four or more hex characters (`pr-441` parsed as `pr-`).
    const output = stdoutOf(
      runGit(cwd, [
        'for-each-ref',
        '--format=%(HEAD) %(refname) %(objectname:short)',
        'refs/heads',
        'refs/remotes',
      ], 256 * 1024),
    );
    if (output === null) return { isGitRepo: false, locals: [], remotes: [] };

    const locals: GitBranchRef[] = [];
    const remotes: GitBranchRef[] = [];
    for (const line of output.split('\n')) {
      if (!line) continue;
      const [headMarker, fullName, head] = line.split(' ');
      if (!fullName || !head) continue;
      const current = headMarker === '*';
      if (fullName.startsWith('refs/heads/')) {
        locals.push({ name: fullName.slice('refs/heads/'.length), current, head });
      } else if (fullName.startsWith('refs/remotes/')) {
        const tail = fullName.slice('refs/remotes/'.length);
        const slash = tail.indexOf('/');
        if (slash < 0) continue;
        const remote = tail.slice(0, slash);
        const name = tail.slice(slash + 1);
        // Hide HEAD pseudo-refs kept on the remote side (`origin/HEAD`).
        if (name === 'HEAD') continue;
        remotes.push({ name, remote, head });
      }
    }
    return { isGitRepo: true, locals, remotes };
  });

  ipcMain.handle('git:repo-state', async (_event, cwd: unknown): Promise<GitRepositoryState> => {
    if (typeof cwd !== 'string' || cwd.length === 0 || !isGitRepoDir(cwd)) {
      return { isGitRepo: false };
    }
    const [branchOut, headOut, statusOut] = await Promise.all([
      Promise.resolve().then(() => stdoutOf(runGit(cwd, ['branch', '--show-current']))),
      Promise.resolve().then(() => stdoutOf(runGit(cwd, ['rev-parse', '--short', 'HEAD']))),
      Promise.resolve().then(() => stdoutOf(runGit(cwd, ['status', '--porcelain']))),
    ]);
    const branch = branchOut?.trim() || undefined;
    const head = headOut?.trim() || undefined;
    const dirty = statusOut ? statusOut.split('\n').filter((l) => l.length > 0).length : 0;
    return { isGitRepo: true, branch, head, dirty };
  });

  ipcMain.handle('git:commit-detail', async (_event, cwd: unknown, sha: unknown): Promise<GitCommitDetailResult> => {
    if (typeof cwd !== 'string' || cwd.length === 0 || !isGitRepoDir(cwd)) {
      return { isGitRepo: false, error: 'Not a Git repository.' };
    }
    if (!validateGitRef(sha)) {
      return { isGitRepo: true, error: 'Invalid commit ref.' };
    }
    try {
      const meta = stdoutOf(
        runGit(cwd, ['show', '--no-patch', `--format=${GIT_LOG_FORMAT}`, '-z', sha as string], 16 * 1024),
      );
      if (!meta) return { isGitRepo: true, error: 'Commit not found.' };
      const commits = parseCommitLogOutput(meta);
      if (commits.length === 0) return { isGitRepo: true, error: 'Commit not found.' };
      const commit = commits[0];

      const numstat = stdoutOf(
        runGitDiff(cwd, ['show', '--numstat', '--format=', sha as string], MAX_DIFF_BYTES),
      );
      const files: GitReviewFile[] = [];
      if (numstat) {
        for (const change of parseNumstat(numstat)) {
          files.push({ ...change, status: 'modified' });
        }
      }

      const patchResult = runGitDiff(cwd, ['show', '--no-ext-diff', '--no-color', '--unified=20', sha as string], MAX_DIFF_BYTES);
      const patch = patchStdoutOf(patchResult) ?? '';
      const binary = patch.length > 0 ? isBinaryPatch(patch) : files.length === 0;
      const bounded = boundedPatchPart(patch, MAX_DIFF_BYTES);
      return {
        isGitRepo: true,
        commit,
        files,
        totals: computeTotals(files, files.length),
        patch: bounded.patch,
        truncated: bounded.truncated || didExceedDiffBuffer(patchResult) || undefined,
        binary,
      };
    } catch {
      return { isGitRepo: true, error: 'Unable to load commit detail.' };
    }
  });
}

/** Human-readable label for the scope selector. */
function scopeLabel(scope: ReviewScopeParams): string {
  switch (scope.type) {
    case 'uncommitted': return 'HEAD → 工作区';
    case 'unstaged':   return '索引 → 工作区';
    case 'staged':     return 'HEAD → 索引';
    case 'commit':     return `${(scope.commitTo ?? 'HEAD').slice(0, 7)} (commit)`;
    case 'branch':     return `HEAD → ${scope.commitTo ?? '?'}`;
    case 'commit-pair': return `${(scope.commitFrom ?? '?').slice(0, 7)} → ${(scope.commitTo ?? '?').slice(0, 7)}`;
    default:           return '?';
  }
}

/** Short tag for the scope selector (replaces the legacy two-arrow label). */
function scopeBranchLabel(scope: ReviewScopeParams): string | undefined {
  switch (scope.type) {
    case 'commit':
      return `${(scope.commitTo ?? 'HEAD').slice(0, 7)} (commit)`;
    case 'branch':
      return scope.commitTo;
    case 'commit-pair':
      return `${(scope.commitFrom ?? '?').slice(0, 7)}…${(scope.commitTo ?? '?').slice(0, 7)}`;
    default:
      return undefined;
  }
}

// ── Rich commit log parsing (plan 518) ────────────────────────────

/**
 * `git log` format string. Fields are unit-separated (`\x1f`) within a
 * commit, and `\x00` separates commits, so commit messages with embedded
 * newlines don't poison the row split. Fields mirror `GitCommitInfo` in
 * the order the parser expects.
 */
const GIT_LOG_FORMAT = '%H%x1f%h%x1f%s%x1f%b%x1f%an%x1f%ae%x1f%aI%x1f%P%x1f%D%x00';

/** Parse the output of `git log --format=<GIT_LOG_FORMAT> -z`. */
export function parseCommitLogOutput(output: string): GitCommitInfo[] {
  const commits: GitCommitInfo[] = [];
  const records = output.split('\0');
  for (const record of records) {
    if (!record) continue;
    const parts = record.split('\x1f');
    if (parts.length < 9) continue;
    const [hash, shortHash, subject, body, author, authorEmail, authorDate, parentsRaw, refsRaw] = parts;
    if (!/^[0-9a-f]{7,40}$/i.test(hash) || !/^[0-9a-f]{7,40}$/i.test(shortHash)) continue;
    const parents = parentsRaw.trim() ? parentsRaw.trim().split(/\s+/).filter(Boolean) : [];
    const refs = refsRaw.trim() ? refsRaw.trim().split(/,\s*/).filter(Boolean) : [];
    commits.push({
      hash,
      shortHash,
      subject,
      body: body ?? '',
      author: author ?? '',
      authorEmail: authorEmail ?? '',
      authorDate: authorDate ?? '',
      parents,
      refs,
      isMerge: parents.length > 1,
    });
  }
  return commits;
}

/** Coerce legacy numeric `count` argument to the new options bag. */
function normaliseListCommitsOptions(value: unknown): GitListCommitsOptions {
  if (value == null) return {};
  if (typeof value === 'number') return { count: value };
  if (typeof value === 'object') return value as GitListCommitsOptions;
  return {};
}
