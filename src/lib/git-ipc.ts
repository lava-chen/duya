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

export async function getGitStatus(cwd: string): Promise<GitStatusResult> {
  // Default to `isGitRepo: false` when the bridge isn't present so
  // tests / non-electron renderers don't blow up.
  return window.electronAPI?.git?.status(cwd) ?? { isGitRepo: false };
}