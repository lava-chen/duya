// src/lib/git-ipc.ts
// Renderer-side wrapper around the `git:*` IPC channels.
//
// The shapes are NOT hand-written here. They are re-exported from
// `electron/ipc/git-types.ts`, which is the single source of truth shared
// by `git-handlers.ts` and `preload.ts` and carries the per-field docs.
// This file used to keep its own copy of all 19 of them, justified by
// "we deliberately don't import from `electron/preload.ts` because that's
// excluded from the renderer tsconfig" — which is not why.
//
// `exclude` in tsconfig.json filters the `include` globs; it does not
// keep a file out of the program once something in `include` imports it.
// `src/global.d.ts` already does `import type { ElectronAPI } from
// '../electron/preload'`, so the renderer has been type-referencing the
// electron side all along. Everything below is `export type` and
// `import type`, so no electron code reaches the renderer bundle.

export type {
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
  ReviewScopeType,
  ReviewScopeParams,
  GitCommitInfo,
  GitListCommitsResult,
  GitBranchRef,
  GitListBranchesResult,
  GitRepositoryState,
} from '../../electron/ipc/git-types';

// The types this file's own signatures reference. `export type { … }` above
// re-exports without binding locally, so the body needs its own import.
import type {
  GitLatestTurnReviewResult,
  GitListBranchesResult,
  GitListCommitsResult,
  GitRepositoryState,
  GitReviewResult,
  GitStatusResult,
  GitTurnHistoryResult,
  ReviewScopeParams,
} from '../../electron/ipc/git-types';

export async function getGitStatus(cwd: string): Promise<GitStatusResult> {
  // Default to `isGitRepo: false` when the bridge isn't present so
  // tests / non-electron renderers don't blow up.
  return window.electronAPI?.git?.status(cwd) ?? { isGitRepo: false };
}

export async function getGitReview(cwd: string): Promise<GitReviewResult> {
  return window.electronAPI?.git?.review(cwd) ?? { isGitRepo: false };
}

// Plan 583 ISS-25: `getGitReviewDiff` / `getGitReviewFullDiff` /
// `getGitReviewScopedDiff` were removed. Nothing imported them — the review
// panel obtains its diff from `getGitReviewScoped`, which already carries the
// scoped diff — so they were dead wrappers around three bridge channels the
// panel never called. The handlers stay in `git-handlers.ts`; only the unused
// renderer-side wrappers are gone.

export async function getGitLatestTurnReview(sessionId: string, cwd: string): Promise<GitLatestTurnReviewResult> {
  return window.electronAPI?.git?.reviewLatestTurn(sessionId, cwd) ?? { isGitRepo: false };
}

export async function getGitTurnHistory(sessionId: string, cwd: string, limit?: number): Promise<GitTurnHistoryResult> {
  return window.electronAPI?.git?.reviewTurnHistory(sessionId, cwd, limit) ?? { isGitRepo: false };
}

export async function getGitTurnDetail(cwd: string, reviewId: string): Promise<GitLatestTurnReviewResult> {
  return window.electronAPI?.git?.reviewTurnDetail(cwd, reviewId) ?? { isGitRepo: false };
}

export async function getGitTurnReviewByTurnId(sessionId: string, cwd: string, turnId: string): Promise<GitLatestTurnReviewResult> {
  return window.electronAPI?.git?.reviewTurnByTurnId(sessionId, cwd, turnId) ?? { isGitRepo: false };
}

// ── Scoped review (plan 227) ──────────────────────────────────────

export async function getGitReviewScoped(cwd: string, scope: ReviewScopeParams): Promise<GitReviewResult> {
  return window.electronAPI?.git?.reviewScoped(cwd, scope) ?? { isGitRepo: false };
}

export async function getGitCommits(cwd: string, count?: number): Promise<GitListCommitsResult> {
  return window.electronAPI?.git?.listCommits(cwd, count) ?? { commits: [] };
}

// ── Branch and repo-state helpers (plan 308 Phase 2) ───────────────

/** Empty/default state for a non-repo or error path. */
export const EMPTY_REPO_STATE: GitRepositoryState = { isGitRepo: false };

export async function getGitBranches(cwd: string): Promise<GitListBranchesResult> {
  return window.electronAPI?.git?.listBranches(cwd) ?? { isGitRepo: false, locals: [], remotes: [] };
}

export async function getGitRepoState(cwd: string): Promise<GitRepositoryState> {
  return window.electronAPI?.git?.repoState(cwd) ?? { isGitRepo: false };
}
