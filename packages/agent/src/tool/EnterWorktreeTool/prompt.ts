/**
 * EnterWorktreeTool Prompt
 * Original text from claude-code-haha
 */

export const DESCRIPTION = 'Enter a git worktree';

export function getPrompt(): string {
  return `Use this tool to enter a git worktree.

## When to Use This Tool

- When you need to work on multiple branches simultaneously
- When you want to isolate work on a specific feature or fix
- When you need to test changes without affecting the main branch

## Notes

- A worktree allows you to have multiple working directories for the same repository
- Each worktree has its own branch
- You cannot enter a worktree that already exists
- Use ExitWorktree when you're done to clean up

## Requirements

- The repository must be a git repository
- The worktree must not already exist
`;
}
