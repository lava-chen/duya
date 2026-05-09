/**
 * WebFetchTool Prompt
 */

export const DESCRIPTION = 'Fetch a URL and extract content as Markdown';

export function getPrompt(): string {
  return `IMPORTANT: WebFetch WILL FAIL for authenticated or private URLs. Before using this tool, check if the URL points to an authenticated service (e.g. Google Docs, Confluence, Jira, GitHub). If so, look for a specialized MCP tool that provides authenticated access.

Use this tool to fetch and extract content from a URL.

## When to Use This Tool

- To retrieve content from a web page
- To extract information from documentation
- To fetch data from public APIs
- To read online articles or resources
- After using WebSearch to get relevant URLs

## Input

- **url**: The URL to fetch content from (must be a valid URL)
- **prompt**: Optional prompt to guide content extraction

## Notes

- Authentication-required URLs will fail
- Large content may be truncated to 100K characters
- Content is converted to Markdown format
- Use WebSearch to find URLs first
`;
}
