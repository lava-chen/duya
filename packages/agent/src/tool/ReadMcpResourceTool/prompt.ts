/**
 * ReadMcpResourceTool Prompt
 * Original text from claude-code-haha
 */

export const DESCRIPTION = 'Read an MCP resource by URI';

export function getPrompt(): string {
  return `Use this tool to read a specific MCP resource by its URI.

## When to Use This Tool

- After listing resources with ListMcpResources
- To fetch data from a known resource URI
- To get the contents of a file or database resource

## Input

- **uri**: The URI of the resource to read (e.g., "file://path/to/file.txt")

## Notes

- The resource must exist and be accessible
- Some resources may require authentication
- Large resources may be truncated
`;
}
