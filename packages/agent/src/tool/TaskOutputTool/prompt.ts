/**
 * TaskOutputTool Prompt
 * Original text from claude-code-haha
 */

export const DESCRIPTION = 'Get the output of a completed task';

export function getPrompt(): string {
  return `Use this tool to retrieve the output of a completed task.

## When to Use This Tool

- After a task is completed, to retrieve its output/results
- To check what a task produced when it finished
- To get error messages or logs from failed tasks

## Output

Returns the task output:
- **output**: The output produced by the task
- **exitCode**: The exit code if applicable
- **duration**: How long the task took to complete

## Notes

- Only completed tasks will have output
- Pending or in_progress tasks will return empty output
`;
}
