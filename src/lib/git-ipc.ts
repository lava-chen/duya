// src/lib/git-ipc.ts
// Renderer-side wrapper around the `git:status` IPC. The return type
// is hand-written here — we deliberately don't import from
// `electron/preload.ts` because that's excluded from the renderer
// tsconfig. The shapes must stay in sync with the preload interface;
// any drift surfaces as a `window.electronAPI.git.status` call-site
// type error.

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

export type GitReviewFileStatus = 'modified' | 'added' | 'deleted' | 'renamed' | 'untracked';

export interface GitReviewFile extends GitStatusFileChange {
  status: GitReviewFileStatus;
  oldPath?: string;
}

export interface GitReviewResult {
  isGitRepo: boolean;
  branch?: string;
  baseRef?: string;
  files?: GitReviewFile[];
  totals?: GitStatusTotals;
  /** Preloaded full diff (scoped review returns it inline). */
  patch?: string;
  truncated?: boolean;
  binary?: boolean;
}

export interface GitReviewDiffResult {
  isGitRepo: boolean;
  path?: string;
  patch?: string;
  binary?: boolean;
  truncated?: boolean;
  error?: string;
}

export interface GitReviewFullDiffResult {
  isGitRepo: boolean;
  patch?: string;
  binary?: boolean;
  truncated?: boolean;
  error?: string;
}

export interface GitTurnReview {
  id: string;
  sessionId: string;
  turnId: string;
  workingDirectory: string;
  files: GitReviewFile[];
  totals: GitStatusTotals;
  patch: string;
  binary: boolean;
  truncated: boolean;
  capturedAt: number;
}

export interface GitLatestTurnReviewResult {
  isGitRepo: boolean;
  review?: GitTurnReview;
  error?: string;
}

export async function getGitStatus(cwd: string): Promise<GitStatusResult> {
  // Default to `isGitRepo: false` when the bridge isn't present so
  // tests / non-electron renderers don't blow up.
  return window.electronAPI?.git?.status(cwd) ?? { isGitRepo: false };
}

export async function getGitReview(cwd: string): Promise<GitReviewResult> {
  return window.electronAPI?.git?.review(cwd) ?? { isGitRepo: false };
}

export async function getGitReviewDiff(cwd: string, filePath: string): Promise<GitReviewDiffResult> {
  return window.electronAPI?.git?.reviewDiff(cwd, filePath) ?? { isGitRepo: false };
}

export async function getGitReviewFullDiff(cwd: string): Promise<GitReviewFullDiffResult> {
  return window.electronAPI?.git?.reviewFullDiff(cwd) ?? { isGitRepo: false };
}

export async function getGitLatestTurnReview(sessionId: string, cwd: string): Promise<GitLatestTurnReviewResult> {
  return window.electronAPI?.git?.reviewLatestTurn(sessionId, cwd) ?? { isGitRepo: false };
}

// ── Scoped review (plan 227) ──────────────────────────────────────

export type ReviewScopeType = 'uncommitted' | 'unstaged' | 'staged' | 'commit';

export interface ReviewScopeParams {
  type: ReviewScopeType;
  commitFrom?: string;
  commitTo?: string;
}

export interface GitCommitInfo {
  hash: string;
  subject: string;
}

export interface GitListCommitsResult {
  commits: GitCommitInfo[];
}

export async function getGitReviewScoped(cwd: string, scope: ReviewScopeParams): Promise<GitReviewResult> {
  return window.electronAPI?.git?.reviewScoped(cwd, scope) ?? { isGitRepo: false };
}

export async function getGitReviewScopedDiff(cwd: string, scope: ReviewScopeParams, filePath: string): Promise<GitReviewDiffResult> {
  return window.electronAPI?.git?.reviewScopedDiff(cwd, scope, filePath) ?? { isGitRepo: false };
}

export async function getGitCommits(cwd: string, count?: number): Promise<GitListCommitsResult> {
  return window.electronAPI?.git?.listCommits(cwd, count) ?? { commits: [] };
}
