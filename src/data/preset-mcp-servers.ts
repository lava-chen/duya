import type { MCPServerConfig } from "@/types";

export type MCPCategory = 'search' | 'development' | 'data' | 'ai' | 'filesystem' | 'browser' | 'communication';

export interface PresetMCPServer {
  id: string;
  name: string;
  description: string;
  command: string;
  args: string[];
  env: Record<string, string>;
  category: MCPCategory;
  docsUrl?: string;
}

export const MCP_CATEGORIES: { key: MCPCategory; label: string }[] = [
  { key: 'search', label: 'Search' },
  { key: 'development', label: 'Development' },
  { key: 'data', label: 'Data' },
  { key: 'ai', label: 'AI' },
  { key: 'filesystem', label: 'Filesystem' },
  { key: 'browser', label: 'Browser' },
  { key: 'communication', label: 'Communication' },
];

export const PRESET_MCP_SERVERS: PresetMCPServer[] = [
  {
    id: 'brave-search',
    name: 'Brave Search',
    description: 'Web search via Brave Search API',
    command: 'npx',
    args: ['-y', '@anthropic/mcp-server-brave'],
    env: {},
    category: 'search',
  },
  {
    id: 'github',
    name: 'GitHub',
    description: 'GitHub API: repos, issues, PRs, and more',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-github'],
    env: {},
    category: 'development',
  },
  {
    id: 'filesystem',
    name: 'Filesystem',
    description: 'Read, write, and manage files on disk',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-filesystem'],
    env: {},
    category: 'filesystem',
  },
  {
    id: 'postgres',
    name: 'PostgreSQL',
    description: 'Query and manage PostgreSQL databases',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-postgres'],
    env: {},
    category: 'data',
  },
  {
    id: 'sqlite',
    name: 'SQLite',
    description: 'Query and manage SQLite databases',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-sqlite'],
    env: {},
    category: 'data',
  },
  {
    id: 'puppeteer',
    name: 'Puppeteer',
    description: 'Control a headless Chrome browser',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-puppeteer'],
    env: {},
    category: 'browser',
  },
  {
    id: 'minimax',
    name: 'MiniMax',
    description: 'MiniMax coding plan MCP server',
    command: 'uvx',
    args: ['minimax-coding-plan-mcp', '-y'],
    env: {},
    category: 'ai',
  },
  {
    id: 'sequential-thinking',
    name: 'Sequential Thinking',
    description: 'Structured reasoning and step-by-step problem solving',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-sequential-thinking'],
    env: {},
    category: 'ai',
  },
  {
    id: 'memory',
    name: 'Memory',
    description: 'Persistent memory for agents across sessions',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-memory'],
    env: {},
    category: 'ai',
  },
  {
    id: 'fetch',
    name: 'Web Fetch',
    description: 'Fetch web content and convert to markdown',
    command: 'npx',
    args: ['-y', '@anthropic/mcp-server-fetch'],
    env: {},
    category: 'development',
  },
  {
    id: 'context7',
    name: 'Context7',
    description: 'Up-to-date library documentation lookup',
    command: 'npx',
    args: ['-y', '@upstash/context7-mcp'],
    env: {},
    category: 'development',
  },
  {
    id: 'playwright',
    name: 'Playwright',
    description: 'Browser automation with Playwright',
    command: 'npx',
    args: ['-y', '@playwright/mcp'],
    env: {},
    category: 'browser',
  },
  {
    id: 'docker',
    name: 'Docker',
    description: 'Manage Docker containers and images',
    command: 'npx',
    args: ['-y', '@anthropic/mcp-server-docker'],
    env: {},
    category: 'development',
  },
  {
    id: 'tavily',
    name: 'Tavily Search',
    description: 'AI-optimized web search via Tavily API',
    command: 'npx',
    args: ['-y', 'tavily-mcp'],
    env: {},
    category: 'search',
  },
  {
    id: 'serena',
    name: 'Serena Code Analysis',
    description: 'Semantic code analysis and navigation',
    command: 'uvx',
    args: ['serena-mcp-server', '-y'],
    env: {},
    category: 'development',
  },
];

export function presetToMCPServerConfig(preset: PresetMCPServer): MCPServerConfig {
  return {
    name: preset.id,
    command: preset.command,
    args: preset.args,
    env: preset.env,
    enabled: true,
  };
}

export function getPresetById(id: string): PresetMCPServer | undefined {
  return PRESET_MCP_SERVERS.find((p) => p.id === id);
}

export function getPresetsByCategory(category: MCPCategory): PresetMCPServer[] {
  return PRESET_MCP_SERVERS.filter((p) => p.category === category);
}