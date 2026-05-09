/**
 * ExitPlanModeTool Prompt
 * Original text from claude-code-haha
 */

export const DESCRIPTION = 'Exit plan mode';

export function getPrompt(): string {
  return `Use this tool to exit plan mode.

## When to Use This Tool

- When you've finished planning and want to start implementation
- When you want to leave the planning environment
- When the user confirms your plan and you're ready to proceed

## Notes

- Make sure you've completed your planning before exiting
- Any tasks created in plan mode will remain
- You can re-enter plan mode at any time
`;
}
