/**
 * Audited upstream sources for Duya first-party presets.
 *
 * This registry is deliberately metadata only: it never downloads a skill at
 * runtime, and it never carries credentials. A provider's MCP endpoint is
 * authoritative for its tools; Duya-owned skills remain policy overlays for
 * confirmations, project context, and product workflows.
 */

export type OfficialMcpTransport = 'stdio' | 'streamable-http'
export type OfficialSkillMode = 'upstream-sync' | 'duya-overlay'

export interface OfficialMcpAsset {
  provider: string
  transport: OfficialMcpTransport
  authentication: 'oauth' | 'local' | 'none'
  url?: string
  package?: string
  repository?: string
  ref?: string
}

export interface OfficialSkillAsset {
  mode: OfficialSkillMode
  repository?: string
  ref?: string
  path?: string
}

export interface OfficialPluginAssets {
  mcp: OfficialMcpAsset
  skills: OfficialSkillAsset
}

const OFFICIAL_PLUGIN_ASSETS: Readonly<Record<string, OfficialPluginAssets>> = {
  'com.duya.github-development': {
    mcp: {
      provider: 'GitHub',
      transport: 'stdio',
      authentication: 'oauth',
      package: 'ghcr.io/github/github-mcp-server',
      repository: 'https://github.com/github/github-mcp-server',
      ref: 'd080b23f593d153808fc212dc9a69d6e38ef68c9',
    },
    skills: { mode: 'duya-overlay' },
  },
  'com.duya.playwright-web-operator': {
    mcp: { provider: 'Microsoft Playwright', transport: 'stdio', authentication: 'local', package: '@playwright/mcp' },
    skills: {
      mode: 'upstream-sync',
      repository: 'https://github.com/microsoft/playwright-mcp',
      ref: '55679f5f3d4b4f3e2534ec0ce2fc5683ba2eaf3f',
      path: '.claude/skills',
    },
  },
  'com.duya.figma-design': {
    mcp: { provider: 'Figma', transport: 'streamable-http', authentication: 'oauth', url: 'https://mcp.figma.com/mcp' },
    skills: { mode: 'duya-overlay' },
  },
  'com.duya.supabase-development': {
    mcp: { provider: 'Supabase', transport: 'streamable-http', authentication: 'oauth', url: 'https://mcp.supabase.com/mcp' },
    skills: {
      mode: 'upstream-sync',
      repository: 'https://github.com/supabase/agent-skills',
      ref: '1ad9aaeb49caafd9e95c0a91116f71890eebbc53',
      path: 'skills',
    },
  },
  'com.duya.sentry-debugging': {
    mcp: { provider: 'Sentry', transport: 'streamable-http', authentication: 'oauth', url: 'https://mcp.sentry.dev' },
    skills: {
      mode: 'upstream-sync',
      repository: 'https://github.com/getsentry/sentry-mcp',
      ref: '676e430748fc17656874dcd2c412172df0048969',
      path: '.agents/skills',
    },
  },
  'com.duya.vercel-deployment': {
    mcp: { provider: 'Vercel', transport: 'streamable-http', authentication: 'oauth', url: 'https://mcp.vercel.com' },
    skills: {
      mode: 'upstream-sync',
      repository: 'https://github.com/vercel/vercel-plugin',
      ref: 'b61a2c5f4b9d4f8814af0c469fa0a6a91d50addf',
      path: 'skills',
    },
  },
  'com.duya.notion-knowledge': {
    mcp: { provider: 'Notion', transport: 'streamable-http', authentication: 'oauth', url: 'https://mcp.notion.com/mcp' },
    skills: { mode: 'duya-overlay' },
  },
  'com.duya.linear-project-execution': {
    mcp: { provider: 'Linear', transport: 'streamable-http', authentication: 'oauth', url: 'https://mcp.linear.app/mcp' },
    skills: { mode: 'duya-overlay' },
  },
}

export function getOfficialPluginAssets(pluginId: string): OfficialPluginAssets | undefined {
  return OFFICIAL_PLUGIN_ASSETS[pluginId]
}

export function listOfficialPluginAssets(): Readonly<Record<string, OfficialPluginAssets>> {
  return OFFICIAL_PLUGIN_ASSETS
}
