/**
 * ListMcpResourcesTool Prompt
 * Original text from claude-code-haha
 */

export const DESCRIPTION = 'List available MCP resources';

export function getPrompt(): string {
  return `Use this tool to list available MCP (Model Context Protocol) resources.

## When to Use This Tool

- To see what resources are available from MCP servers
- To find resources you can read with ReadMcpResource
- To discover available data sources and their URIs

## MCP Resources

MCP resources are data sources provided by MCP servers, such as:
- File contents
- Database queries
- API responses
- Documentation
- Configuration data

## Notes

- Resources have URIs that identify them
- Use ReadMcpResource to read a specific resource by its URI
`;
}
