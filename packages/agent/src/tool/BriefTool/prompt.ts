/**
 * BriefTool Prompt
 * Original text from claude-code-haha
 */

export const DESCRIPTION = 'Generate a brief summary of the codebase';

export function getPrompt(): string {
  return `Use this tool to generate a brief summary of the codebase.

## When to Use This Tool

- When starting work on a new project
- To understand the overall structure of a codebase
- To get a quick overview before deep diving
- To share project context with teammates

## Output

Returns a summary including:
- Project type and purpose
- Directory structure
- Key files and their purposes
- Dependencies
- Build and test commands
`;
}
