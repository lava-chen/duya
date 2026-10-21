/** Notice injected into fresh children running in an isolated worktree. */
export function buildWorktreeSpawnNotice(
  parentCwd: string,
  worktreeCwd: string,
  branch: string,
): string {
  return `You are running in an isolated git worktree at ${worktreeCwd} (branch ${branch}), created from the repository at ${parentCwd}. This is the same repository with the same relative file structure, but a separate working copy: your file changes stay in this worktree and will NOT be visible in ${parentCwd} until they are merged or cherry-picked. Absolute paths that point into ${parentCwd} do not exist for you — use paths relative to ${worktreeCwd} instead. Report the worktree branch name in your final summary so the parent knows how to adopt your changes.`;
}
