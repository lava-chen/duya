/**
 * WebSearchTool Prompt
 * Web search tool (currently disabled)
 */

import { SEARCH_SOURCES } from './constants.js';

export const DESCRIPTION = 'Search the web using 15+ platforms (Google, HackerNews, Reddit, 小红书, B站, YouTube, etc.)';

export const VALID_SOURCES = SEARCH_SOURCES.join(', ');

export const EXAMPLE_CALL = `\`\`\`json
{
  "query": "your search query here",
  "source": "google",
  "limit": 10
}
\`\`\``;

export function getPrompt(): string {
  return `Use this tool to search the web for current information.

## Supported Sources

The \`source\` parameter accepts these exact values: ${VALID_SOURCES}

**Common sources:**
- \`google\` - General web search (DEFAULT, use when unsure)
- \`hackernews\` - Tech news, startup discussions, AI/LLM topics
- \`stackoverflow\` - Technical Q&A, error debugging
- \`reddit\` - Community discussions, opinions
- \`wikipedia\` - Encyclopedia summaries
- \`arxiv\` - Research papers (English)
- \`youtube\` - English videos, tutorials
- \`xiaohongshu\` - Real experiences, reviews (Chinese)
- \`bilibili\` - Video tutorials, courses (Chinese)
- \`zhihu\` - Expert answers (Chinese)
- \`twitter\` - Real-time opinions, KOL views
- \`xueqiu\` - Chinese stock/finance discussions

## Correct Usage

**Basic search example:**
${EXAMPLE_CALL}

**Search with subtype:**
${EXAMPLE_CALL.replace('"source": "google"', '"source": "hackernews", "subtype": "top"')}

## Common Mistakes to Avoid

- **DO NOT** invent source names. Only use: ${VALID_SOURCES}
- **DO NOT** use vague sources like "web", "internet", or "online"
- **DO NOT** specify source in the query text (e.g., "site:stackoverflow.com"). Use the \`source\` parameter instead.
- If unsure which source to use, default to \`google\`

## Input Schema

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| query | string | Yes | Search query (min 2 chars) |
| source | enum | No | Platform name (default: google) |
| limit | number | No | Max results (default: 10, max: 20) |
| subtype | enum | No | Variant: "hot", "top", "new", "search" |

## Notes

- This tool is currently disabled
- Use browser_tool for web search functionality instead
`;
}
