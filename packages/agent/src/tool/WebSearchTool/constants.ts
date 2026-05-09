export const WEB_SEARCH_TOOL_NAME = 'WebSearch';

/**
 * All supported search platforms
 * Defined here (not in WebSearchTool.ts) to avoid circular dependency:
 * WebSearchTool.ts → prompt.ts → WebSearchTool.ts
 */
export const SEARCH_SOURCES = [
  // General
  'google',
  // Academic
  'arxiv', 'wikipedia',
  // English Tech Community
  'hackernews', 'reddit', 'stackoverflow', 'devto',
  // Chinese Community
  'zhihu', 'xiaohongshu', 'bilibili', 'weibo', 'v2ex',
  // Video
  'youtube',
  // Finance
  'xueqiu', 'sinafinance',
  // Social Media
  'twitter',
] as const;
