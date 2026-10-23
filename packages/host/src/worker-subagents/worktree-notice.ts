/** Notice injected into fresh children running in an isolated worktree.
 *
 * `baseSha` is the short base commit the checkout's detached HEAD starts from
 * (plan 621 D3): isolated checkouts have no branch, so the notice must not
 * promise one, and adoption happens through the commit itself, not a merge. */
export function buildWorktreeSpawnNotice(
  parentCwd: string,
  worktreeCwd: string,
  baseSha: string,
): string {
  return `You are running in an isolated git worktree at ${worktreeCwd} (detached HEAD at base commit ${baseSha}), created from the repository at ${parentCwd}. This is the same repository with the same relative file structure, but a separate working copy: your file changes stay in this worktree and will NOT be visible in ${parentCwd} until they are adopted (cherry-pick, patch, or merge of the commit you leave HEAD at). Absolute paths that point into ${parentCwd} do not exist for you — use paths relative to ${worktreeCwd} instead. Report the worktree path and the base commit in your final summary so the parent knows where your changes live.`;
}
