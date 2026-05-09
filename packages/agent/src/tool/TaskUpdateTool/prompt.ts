/**
 * TaskUpdateTool Prompt
 * Original text from claude-code-haha
 */

export const DESCRIPTION = 'Update a task in the task list';

export function getPrompt(): string {
  return `Use this tool to update a task in the task list.

## When to Use This Tool

- To mark a task as in_progress when starting work
- To mark a task as completed when finished
- To add or modify task dependencies (blocks/blockedBy)
- To update task description or subject

## Task Fields

- **subject**: A brief, actionable title in imperative form
- **description**: What needs to be done
- **status**: 'pending', 'in_progress', or 'completed'
- **activeForm**: Present continuous form for spinner (e.g., "Fixing bug")
- **owner**: The agent ID currently assigned to this task. Set when claiming a task; set to null to release.
- **blocks**: Task IDs that this task blocks
- **blockedBy**: Task IDs that must complete before this task can start

## Tips

- Set status to 'in_progress' and assign \`owner\` BEFORE beginning work on a task
- Set status to 'completed' when finished
- Use blockedBy to set up task dependencies
- Check TaskList first to see which tasks are unassigned (no \`owner\`)
- Do NOT start work on a task that already has a different \`owner\`
- When completing a task, include a summary of results in the \`metadata.output\` field so other agents can see the output via TaskOutput
`;
}
