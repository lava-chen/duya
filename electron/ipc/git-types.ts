// Shared Git IPC types for the Code Review workspace.
// This file is the single source of truth consumed by both
// electron/ipc/git-handlers.ts and electron/preload.ts.
// Renderer-side code (src/lib/git-ipc.ts) maintains its own copy
// because it cannot import from the Electron side.

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

// ── Scoped review (plan 227) ──────────────────────────────────────

export type ReviewScopeType = 'uncommitted' | 'unstaged' | 'staged' | 'commit';

export interface ReviewScopeParams {
  type: ReviewScopeType;
  /** For 'commit' scope: the older commit hash. */
  commitFrom?: string;
  /** For 'commit' scope: the newer commit hash. */
  commitTo?: string;
}

export interface GitCommitInfo {
  hash: string;
  subject: string;
}

export interface GitListCommitsResult {
  commits: GitCommitInfo[];
}

export interface GitAPI {
  status: (cwd: string) => Promise<GitStatusResult>;
  review: (cwd: string) => Promise<GitReviewResult>;
  reviewDiff: (cwd: string, filePath: string) => Promise<GitReviewDiffResult>;
  reviewFullDiff: (cwd: string) => Promise<GitReviewFullDiffResult>;
  reviewLatestTurn: (sessionId: string, cwd: string) => Promise<GitLatestTurnReviewResult>;
  /** Unified scoped review: unstaged / staged / uncommitted / commit. */
  reviewScoped: (cwd: string, scope: ReviewScopeParams) => Promise<GitReviewResult>;
  reviewScopedDiff: (cwd: string, scope: ReviewScopeParams, filePath: string) => Promise<GitReviewDiffResult>;
  listCommits: (cwd: string, count?: number) => Promise<GitListCommitsResult>;
}