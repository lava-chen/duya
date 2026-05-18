export const DESCRIPTION = 'Manage git worktree context: enter, exit, check status, or list worktrees'

export function getPrompt(): string {
  return `Use this tool to manage git worktree context. Worktrees allow you to work on multiple branches simultaneously in isolated directories.

## Actions

### enter
Create and enter a new git worktree. This creates a new working directory for the given branch.

### exit
Exit and remove an existing git worktree. This removes the worktree directory but does NOT delete the branch.

### status
Check the status of the current worktree context. Shows which worktree is currently active.

### list
List all existing git worktrees in the repository.

## When to Use

- When you need to work on multiple branches simultaneously
- When you want to isolate work on a specific feature or fix
- When you need to test changes without affecting the main branch
- When you're done with a worktree and want to clean up

## Notes

- Each worktree has its own branch
- The worktree directory is created under .worktrees/ by default
- Make sure all changes are committed before exiting a worktree
`
}