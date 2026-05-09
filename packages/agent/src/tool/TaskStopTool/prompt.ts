/**
 * TaskStopTool Prompt
 * Original text from claude-code-haha
 */

export const DESCRIPTION = 'Stop an in-progress task';

export function getPrompt(): string {
  return `Use this tool to stop an in-progress task.

## When to Use This Tool

- When a task needs to be cancelled
- When the user wants to abort a long-running operation
- When task dependencies change and the task is no longer needed

## Notes

- Only tasks that are 'in_progress' can be stopped
- Completed tasks cannot be stopped (use TaskUpdate to modify completed tasks)
- Stopping a task does not delete it - it remains in the list with 'pending' or 'completed' status
`;
}
