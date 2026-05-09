/**
 * EnterPlanModeTool Prompt
 * Original text from claude-code-haha
 */

export const DESCRIPTION = 'Enter plan mode to review and analyze code';

export function getPrompt(): string {
  return `Use this tool to enter plan mode.

## When to Use This Tool

- When you need to understand a complex codebase before making changes
- When you want to analyze code structure and dependencies
- When planning a refactoring or major change
- When the user asks you to "plan" or "think about" something

## Plan Mode Features

- Provides a structured environment for code analysis
- Helps identify affected files and potential issues
- Allows for careful step-by-step reasoning
- Creates a task list to track the planned work

## Notes

- Plan mode is read-only by default
- You can use TaskCreate to plan out work
- Use ExitPlanMode when you're done planning
`;
}
