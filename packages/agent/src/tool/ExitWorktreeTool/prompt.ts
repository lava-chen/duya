/**
 * ExitWorktreeTool Prompt
 * Original text from claude-code-haha
 */

export const DESCRIPTION = 'Exit a git worktree';

export function getPrompt(): string {
  return `Use this tool to exit and remove a git worktree.

## When to Use This Tool

- When you're done working in a worktree
- When you want to clean up a worktree that is no longer needed
- When you need to remove a feature branch after merging

## Notes

- This removes the worktree but does NOT delete the branch
- The worktree directory is removed from the filesystem
- You cannot exit the main worktree (the main branch)
- Make sure all changes are committed before exiting

## Requirements

- The repository must be a git repository
- The worktree must exist
`;
}
