import fs from 'fs';
import path from 'path';
import { app } from 'electron';
import type { PluginCatalogEntry, PluginCategory, PluginManifest } from './types';
import { readPluginManifest } from './manifest';
import { getLogger, LogComponent } from '../logging/logger';
import { getBuiltinPluginDir } from '../../packages/agent/src/plugins/builtin/_registry.js';
import { getOfficialPluginAssets } from '../../packages/agent/src/plugins/builtin/official-assets.js';
import { deriveCapabilityCounts } from './capability-counts.js';
import { parseSkillFrontmatter } from '../utils/skill-parser';

const COMPONENT = 'PluginCatalog' as LogComponent;

interface LocalMarketplacePlugin {
  name: string;
  source: {
    source: string;
    path: string;
  };
  policy?: {
    installation?: string;
    authentication?: string;
  };
  category?: string;
}

interface LocalMarketplaceFile {
  name: string;
  plugins: LocalMarketplacePlugin[];
}

function readLocalMarketplaceFile(): LocalMarketplaceFile | null {
  try {
    const userData = app.getPath('userData');
    const marketplacePath = path.join(userData, 'plugins', 'marketplace.json');
    if (!fs.existsSync(marketplacePath)) {
      return null;
    }
    const raw = JSON.parse(fs.readFileSync(marketplacePath, 'utf8'));
    if (typeof raw !== 'object' || raw === null || !Array.isArray(raw.plugins)) {
      return null;
    }
    return raw as LocalMarketplaceFile;
  } catch {
    return null;
  }
}

const VALID_CATEGORIES: Set<string> = new Set([
  'productivity', 'development', 'research', 'data',
  'communication', 'media', 'automation', 'other',
]);

function normalizeCategory(cat: string | undefined): PluginCategory {
  if (!cat) return 'other';
  const lower = cat.toLowerCase();
  if (VALID_CATEGORIES.has(lower)) return lower as PluginCategory;
  return 'other';
}

function countCapabilities(manifest: Record<string, unknown>, pluginDir?: string): {
  skills: number;
  mcpServers: number;
  cli: number;
  ui: number;
  hooks: number;
} {
  // `deriveCapabilityCounts` handles the on-disk derivation; the wrapper
  // exists so we can keep the call sites in this file talking in terms
  // of a `Record<string, unknown>` (matching `readPluginManifest`'s
  // return type) without exposing the strongly-typed `PluginManifest`
  // shape to the rest of this module.
  return deriveCapabilityCounts(
    manifest as unknown as Parameters<typeof deriveCapabilityCounts>[0],
    pluginDir,
  );
}

function buildLocalCatalogEntry(
  mpEntry: LocalMarketplacePlugin,
  manifest: Record<string, unknown>,
): PluginCatalogEntry {
  const id = (manifest.id as string) || `com.duya.${mpEntry.name}`;
  const name = (manifest.name as string) || mpEntry.name;
  const version = (manifest.version as string) || '0.1.0';
  const description = (manifest.description as string) || `Plugin: ${mpEntry.name}`;
  const author = (manifest.author as { name: string; url?: string }) || { name: 'Unknown' };

  return {
    id,
    name,
    version,
    description,
    source: 'local',
    category: normalizeCategory(mpEntry.category),
    trustLevel: 'local',
    capabilityCounts: countCapabilities(manifest),
    manifest: manifest as PluginCatalogEntry['manifest'],
    author,
  };
}

function getLocalCatalogEntries(): PluginCatalogEntry[] {
  const logger = getLogger();
  const marketplace = readLocalMarketplaceFile();
  if (!marketplace || !marketplace.plugins.length) {
    return [];
  }

  const entries: PluginCatalogEntry[] = [];
  const marketplaceDir = path.join(app.getPath('userData'), 'plugins');

  for (const mpEntry of marketplace.plugins) {
    try {
      let pluginDir = mpEntry.source.path;
      if (!path.isAbsolute(pluginDir)) {
        pluginDir = path.resolve(marketplaceDir, pluginDir);
      }

      if (!fs.existsSync(pluginDir)) {
        logger.warn('Local plugin directory not found', { name: mpEntry.name, path: pluginDir }, COMPONENT);
        continue;
      }

      const manifest = readPluginManifest(pluginDir);
      const entry = buildLocalCatalogEntry(mpEntry, manifest as unknown as Record<string, unknown>);
      entries.push(entry);
    } catch (err) {
      logger.warn('Failed to read local plugin manifest', {
        name: mpEntry.name,
        error: err instanceof Error ? err.message : String(err),
      }, COMPONENT);
    }
  }

  return entries;
}

function bundledCatalogEntry(
  id: string,
  name: string,
  description: string,
  category: PluginCategory,
  builtinDirName: string,
  manifest: PluginCatalogEntry['manifest'],
): PluginCatalogEntry {
  const dir = getBuiltinPluginDir(builtinDirName);
  const officialAssets = getOfficialPluginAssets(id);
  return {
    id,
    name,
    version: manifest.version,
    description,
    source: 'bundled',
    category,
    trustLevel: 'official',
    capabilityCounts: deriveCapabilityCounts(manifest, dir),
    manifest: officialAssets ? { ...manifest, officialAssets } : manifest,
    author: manifest.author,
  };
}

export const BUNDLED_PLUGIN_CATALOG: PluginCatalogEntry[] = [
  bundledCatalogEntry(
    'com.duya.literature',
    'Literature Plugin',
    'Literature asset and evidence management for research workflows.',
    'research',
    'literature',
    {
      schemaVersion: 'duya.plugin.v1',
      id: 'com.duya.literature',
      name: 'Literature Plugin',
      version: '0.1.0',
      description: 'Literature asset and evidence management for research workflows.',
      author: { name: 'DUYA Team' },
      capabilities: {
        skills: ['paper-analysis', 'citation-format'],
        mcpServers: [
          {
            name: 'literature',
            command: 'node',
            args: ['./agent-bundle/literature-mcp-server.js'],
          },
        ],
      },
      permissions: [
        { name: 'agent.memory.read', scope: 'research' },
        { name: 'agent.memory.write', scope: 'research' },
        { name: 'workspace.read' },
      ],
      engines: { duya: '>=0.1.0', node: '>=20' },
    },
  ),
  bundledCatalogEntry(
    'com.duya.devtools',
    'DevTools Plus',
    'Developer helpers with MCP server and CLI tools.',
    'development',
    'devtools',
    {
      schemaVersion: 'duya.plugin.v1',
      id: 'com.duya.devtools',
      name: 'DevTools Plus',
      version: '0.1.0',
      description: 'Developer helpers with MCP server and CLI tools.',
      author: { name: 'DUYA Team' },
      capabilities: {
        mcpServers: [
          {
            name: 'devtools',
            command: 'node',
            args: ['./dist/mcp-server.js'],
          },
        ],
        cli: [
          {
            name: 'devtools',
            command: './bin/devtools',
          },
        ],
      },
      permissions: [
        { name: 'workspace.read' },
        { name: 'workspace.write' },
      ],
      engines: { duya: '>=0.1.0' },
    },
  ),
  // Plan 313 Phase 0/3 — reference scaffold for first-party plugin
  // packages and production-grade read-only plugin. Skills use the v2
  // subdirectory layout (`skills/<name>/SKILL.md`); `deriveCapabilityCounts`
  // reads 3 skills from disk via the extended `discoverSkills()`. The
  // on-disk `plugin.json` is v2 but the catalog inline manifest stays v1
  // until the v2 loader lands (Plan 311). Phase 3 hardened the read-only
  // posture: the MCP `--read-only` flag is set, the policy pins every
  // write-capable action to the destructive tier, and the recommended
  // setup uses a Postgres role whose grants are read-only
  // (defense-in-depth).
  bundledCatalogEntry(
    'com.duya.postgres-readonly',
    'PostgreSQL Read-only',
    'Read-only PostgreSQL inspection, safe query, and data analysis.',
    'data',
    'postgres-readonly',
    {
      schemaVersion: 'duya.plugin.v1',
      id: 'com.duya.postgres-readonly',
      name: 'PostgreSQL Read-only',
      version: '0.1.0',
      description: 'Read-only PostgreSQL inspection, safe query, and data analysis.',
      author: { name: 'DUYA Team' },
      capabilities: {
        skills: ['schema-inspection', 'safe-query', 'data-analysis'],
        mcpServers: [
          {
            name: 'postgres-readonly',
            command: 'npx',
            // server-postgres expects the connection string as the first
            // positional argument (process.argv[2]); it does not parse
            // --read-only as a flag. Read-only posture is enforced by the
            // Postgres role (see setup label) plus the permission policy.
            args: ['-y', '@modelcontextprotocol/server-postgres', '${setup.connectionString}'],
          },
        ],
      },
      permissions: [
        { name: 'workspace.read' },
      ],
      setup: [
        {
          id: 'connectionString',
          label: 'PostgreSQL connection string — use a read-only role (e.g. duya_reader); read-only access is enforced by the database role, not an MCP flag',
          type: 'secret',
          required: true,
        },
      ],
      engines: { duya: '>=0.1.0' },
    },
  ),
  // Plan 313 Phase 1a — GitHub Development plugin.
  // Uses the official `github-mcp-server` stdio binary as a transitional
  // transport until Plan 313 Phase 2a lands the Remote MCP HTTP transport.
  // Authentication prefers GitHub App installation tokens or OAuth over
  // long-lived PATs (see plugin.md).
  bundledCatalogEntry(
    'com.duya.github-development',
    'GitHub Development',
    'GitHub repository, issue, PR, review, CI, and release workflows.',
    'development',
    'github-development',
    {
      schemaVersion: 'duya.plugin.v1',
      id: 'com.duya.github-development',
      name: 'GitHub Development',
      version: '0.1.0',
      description: 'GitHub repository, issue, PR, review, CI, and release workflows.',
      author: { name: 'DUYA Team' },
      capabilities: {
        skills: [
          'repository-exploration',
          'issue-to-implementation',
          'pull-request-review',
          'fix-ci',
          'release-notes',
        ],
        mcpServers: [
          {
            name: 'github',
            command: 'github-mcp-server',
            args: ['stdio'],
          },
        ],
      },
      permissions: [
        { name: 'workspace.read' },
        { name: 'workspace.write' },
      ],
      setup: [
        {
          id: 'githubToken',
          label: 'GitHub App installation token or OAuth token (long-lived PAT discouraged)',
          type: 'secret',
          required: true,
        },
      ],
      engines: { duya: '>=0.1.0' },
    },
  ),
  // Plan 313 Phase 1b — Playwright Web Operator plugin.
  // Wraps Microsoft's official `@playwright/mcp` (aligned with the legacy
  // preset in `src/data/preset-mcp-servers.ts`, which is deprecated in
  // favor of this plugin). Positioned as browser & web automation, not a
  // testing tool — testing is one of five skills.
  bundledCatalogEntry(
    'com.duya.playwright-web-operator',
    'Playwright Web Operator',
    'Browser and web automation — navigate, extract, fill forms, verify frontends, run E2E tests.',
    'automation',
    'playwright-web-operator',
    {
      schemaVersion: 'duya.plugin.v1',
      id: 'com.duya.playwright-web-operator',
      name: 'Playwright Web Operator',
      version: '0.1.0',
      description: 'Browser and web automation — navigate, extract, fill forms, verify frontends, run E2E tests.',
      author: { name: 'DUYA Team' },
      capabilities: {
        skills: [
          'browser-navigation',
          'structured-extraction',
          'form-operation',
          'frontend-verification',
          'end-to-end-testing',
        ],
        mcpServers: [
          {
            name: 'playwright',
            command: 'npx',
            args: ['-y', '@playwright/mcp'],
          },
        ],
      },
      permissions: [
        { name: 'workspace.read' },
        { name: 'workspace.write' },
      ],
      engines: { duya: '>=0.1.0' },
    },
  ),
  // Plan 313 Phase 2b — Figma Design plugin.
  // Wraps the Figma Dev Mode MCP Server (stdio) as a transitional
  // transport until Plan 313 Phase 2a lands the Remote MCP HTTP
  // transport. The plugin will migrate to the official Figma Remote
  // MCP endpoint (https://mcp.figma.com/cmc) without breaking skills
  // or workflows. Authentication prefers a scoped Dev Mode PAT.
  bundledCatalogEntry(
    'com.duya.figma-design',
    'Figma Design',
    'Figma design context extraction, component mapping, implementation, and visual verification.',
    'development',
    'figma-design',
    {
      schemaVersion: 'duya.plugin.v1',
      id: 'com.duya.figma-design',
      name: 'Figma Design',
      version: '0.1.0',
      description: 'Figma design context extraction, component mapping, implementation, and visual verification.',
      author: { name: 'DUYA Team' },
      capabilities: {
        skills: [
          'design-context-extraction',
          'design-system-mapping',
          'component-implementation',
          'visual-comparison',
          'write-back-to-figma',
        ],
        mcpServers: [
          {
            name: 'figma',
            command: 'npx',
            args: ['-y', 'figma-developer-mcp', '--stdio'],
          },
        ],
      },
      permissions: [
        { name: 'workspace.read' },
        { name: 'workspace.write' },
      ],
      setup: [
        {
          id: 'figmaApiKey',
          label: 'Figma personal access token (preferred: scoped to Dev Mode)',
          type: 'secret',
          required: true,
        },
      ],
      engines: { duya: '>=0.1.0' },
    },
  ),
  // Plan 313 Phase 2b — Supabase Development plugin.
  // Wraps the official @supabase/mcp-server-supabase (stdio). Supabase
  // has not shipped an official Remote MCP endpoint as of 2026-07;
  // this stdio fallback is the canonical transport for now. Building,
  // migrating, and deploying are modify-tier — confirmed before
  // every apply/deploy.
  bundledCatalogEntry(
    'com.duya.supabase-development',
    'Supabase Development',
    'Supabase Postgres, migrations, Edge Functions, and auth — read-heavy with explicit confirmation on every build, migrate, and deploy.',
    'development',
    'supabase-development',
    {
      schemaVersion: 'duya.plugin.v1',
      id: 'com.duya.supabase-development',
      name: 'Supabase Development',
      version: '0.1.0',
      description: 'Supabase Postgres, migrations, Edge Functions, and auth — read-heavy with explicit confirmation on every build, migrate, and deploy.',
      author: { name: 'DUYA Team' },
      capabilities: {
        skills: [
          'postgres-best-practices',
          'migration-workflow',
          'edge-function-workflow',
          'auth-and-security',
        ],
        mcpServers: [
          {
            name: 'supabase',
            command: 'npx',
            args: [
              '-y',
              '@supabase/mcp-server-supabase',
              '--access-token',
              '${setup.supabaseAccessToken}',
              '--project-ref',
              '${setup.supabaseProjectRef}',
            ],
          },
        ],
      },
      permissions: [
        { name: 'workspace.read' },
        { name: 'workspace.write' },
      ],
      setup: [
        {
          id: 'supabaseAccessToken',
          label: 'Supabase personal access token (Project Settings > API)',
          type: 'secret',
          required: true,
        },
        {
          id: 'supabaseProjectRef',
          label: 'Supabase project ref (Project Settings > API)',
          type: 'text',
          required: true,
        },
      ],
      engines: { duya: '>=0.1.0' },
    },
  ),
  // Plan 313 Phase 2b — Sentry Debugging plugin.
  // Wraps @sentry/mcp-server (stdio) as a transitional transport.
  // Sentry also offers an official hosted Remote MCP endpoint at
  // https://mcp.sentry.dev; this plugin will migrate to it once
  // Plan 313 Phase 2a lands the HTTP transport. Read-heavy by
  // default; creating a release is write-tier; resolving, ignoring,
  // or deleting an issue is destructive-tier.
  bundledCatalogEntry(
    'com.duya.sentry-debugging',
    'Sentry Debugging',
    'Sentry issue investigation, stacktrace analysis, regression detection, and fix-and-verify loop.',
    'development',
    'sentry-debugging',
    {
      schemaVersion: 'duya.plugin.v1',
      id: 'com.duya.sentry-debugging',
      name: 'Sentry Debugging',
      version: '0.1.0',
      description: 'Sentry issue investigation, stacktrace analysis, regression detection, and fix-and-verify loop.',
      author: { name: 'DUYA Team' },
      capabilities: {
        skills: [
          'issue-investigation',
          'stacktrace-analysis',
          'regression-detection',
          'fix-and-verify',
        ],
        mcpServers: [
          {
            name: 'sentry',
            command: 'npx',
            args: ['-y', '@sentry/mcp-server'],
          },
        ],
      },
      permissions: [
        { name: 'workspace.read' },
        { name: 'workspace.write' },
      ],
      setup: [
        {
          id: 'sentryAuthToken',
          label: 'Sentry auth token (org-level, read scope minimum; write scope for releases)',
          type: 'secret',
          required: true,
        },
        {
          id: 'sentryOrgSlug',
          label: 'Sentry organization slug',
          type: 'text',
          required: true,
        },
      ],
      engines: { duya: '>=0.1.0' },
    },
  ),
  // Plan 313 Phase 2c — Vercel Deployment plugin.
  // Wraps a Vercel MCP adapter (stdio) as a transitional transport.
  // Vercel offers an official hosted Remote MCP endpoint at
  // https://mcp.vercel.com; this plugin will migrate to it once
  // Plan 313 Phase 2a lands the HTTP transport. Promoting to
  // production is destructive-tier — strong explicit confirmation,
  // every time.
  bundledCatalogEntry(
    'com.duya.vercel-deployment',
    'Vercel Deployment',
    'Vercel deployment inspection, log diagnosis, preview validation, and production release with strict gate on promote.',
    'development',
    'vercel-deployment',
    {
      schemaVersion: 'duya.plugin.v1',
      id: 'com.duya.vercel-deployment',
      name: 'Vercel Deployment',
      version: '0.1.0',
      description: 'Vercel deployment inspection, log diagnosis, preview validation, and production release with strict gate on promote.',
      author: { name: 'DUYA Team' },
      capabilities: {
        skills: [
          'deployment-inspection',
          'log-diagnosis',
          'preview-validation',
          'production-release',
        ],
        mcpServers: [
          {
            name: 'vercel',
            command: 'npx',
            args: ['-y', 'vercel-mcp-adapter'],
          },
        ],
      },
      permissions: [
        { name: 'workspace.read' },
        { name: 'workspace.write' },
      ],
      setup: [
        {
          id: 'vercelToken',
          label: 'Vercel access token (scoped to the target team)',
          type: 'secret',
          required: true,
        },
        {
          id: 'vercelTeamId',
          label: 'Vercel team slug or ID',
          type: 'text',
          required: true,
        },
      ],
      engines: { duya: '>=0.1.0' },
    },
  ),
  // Plan 313 Phase 2c — Notion Knowledge plugin.
  // Wraps @notionhq/notion-mcp-server (stdio) as a transitional
  // transport. Notion offers an official hosted Remote MCP endpoint
  // at https://mcp.notion.com; this plugin will migrate to it once
  // Plan 313 Phase 2a lands the HTTP transport. Read-heavy by
  // default; creating/updating a page is write-tier; archiving is
  // modify-tier; permanent delete is destructive-tier.
  bundledCatalogEntry(
    'com.duya.notion-knowledge',
    'Notion Knowledge',
    'Notion workspace search, research documentation, meeting knowledge capture, database maintenance, and spec-to-task.',
    'productivity',
    'notion-knowledge',
    {
      schemaVersion: 'duya.plugin.v1',
      id: 'com.duya.notion-knowledge',
      name: 'Notion Knowledge',
      version: '0.1.0',
      description: 'Notion workspace search, research documentation, meeting knowledge capture, database maintenance, and spec-to-task.',
      author: { name: 'DUYA Team' },
      capabilities: {
        skills: [
          'workspace-search',
          'research-documentation',
          'meeting-knowledge-capture',
          'database-maintenance',
          'spec-to-task',
        ],
        mcpServers: [
          {
            name: 'notion',
            command: 'npx',
            args: ['-y', '@notionhq/notion-mcp-server'],
          },
        ],
      },
      permissions: [
        { name: 'workspace.read' },
        { name: 'workspace.write' },
      ],
      setup: [
        {
          id: 'notionApiKey',
          label: 'Notion internal integration token (scoped to specific pages)',
          type: 'secret',
          required: true,
        },
      ],
      engines: { duya: '>=0.1.0' },
    },
  ),
  // Plan 313 Phase 2c — Linear Project Execution plugin.
  // Wraps a Linear MCP adapter (stdio) as a transitional transport.
  // Linear offers an official hosted Remote MCP endpoint at
  // https://mcp.linear.app/sse; this plugin will migrate to it
  // once Plan 313 Phase 2a lands the HTTP transport. Read-heavy
  // by default; creating/updating an issue is write-tier; archiving
  // is modify-tier; deleting is destructive-tier (Linear does not
  // support undo on delete).
  bundledCatalogEntry(
    'com.duya.linear-project-execution',
    'Linear Project Execution',
    'Linear issue triage, spec-to-issues, sprint planning, implementation status, and issue-to-code.',
    'development',
    'linear-project-execution',
    {
      schemaVersion: 'duya.plugin.v1',
      id: 'com.duya.linear-project-execution',
      name: 'Linear Project Execution',
      version: '0.1.0',
      description: 'Linear issue triage, spec-to-issues, sprint planning, implementation status, and issue-to-code.',
      author: { name: 'DUYA Team' },
      capabilities: {
        skills: [
          'issue-triage',
          'spec-to-issues',
          'sprint-planning',
          'implementation-status',
          'issue-to-code',
        ],
        mcpServers: [
          {
            name: 'linear',
            command: 'npx',
            args: ['-y', '@tacticlaunch/mcp-linear'],
          },
        ],
      },
      permissions: [
        { name: 'workspace.read' },
        { name: 'workspace.write' },
      ],
      setup: [
        {
          id: 'linearApiKey',
          label: 'Linear personal API key (scoped to read/write issues)',
          type: 'secret',
          required: true,
        },
      ],
      engines: { duya: '>=0.1.0' },
    },
  ),
];

let cachedCatalog: PluginCatalogEntry[] | null = null;
let cachedCatalogAt = 0;
const CACHE_TTL_MS = 5000;

export function getPluginCatalog(): PluginCatalogEntry[] {
  const now = Date.now();
  if (cachedCatalog && (now - cachedCatalogAt) < CACHE_TTL_MS) {
    return cachedCatalog;
  }

  const localEntries = getLocalCatalogEntries();
  const skillEntries = getBundledSkillCatalogEntries();
  cachedCatalog = [...BUNDLED_PLUGIN_CATALOG, ...localEntries, ...skillEntries];
  cachedCatalogAt = now;
  return cachedCatalog;
}

export function getPluginCatalogEntry(id: string): PluginCatalogEntry | undefined {
  const catalog = getPluginCatalog();
  return catalog.find((entry) => entry.id === id);
}

export function getLocalPluginPaths(): Map<string, string> {
  const marketplace = readLocalMarketplaceFile();
  if (!marketplace || !marketplace.plugins.length) {
    return new Map();
  }

  const result = new Map<string, string>();
  const marketplaceDir = path.join(app.getPath('userData'), 'plugins');

  for (const entry of marketplace.plugins) {
    let pluginDir = entry.source.path;
    if (!path.isAbsolute(pluginDir)) {
      pluginDir = path.resolve(marketplaceDir, pluginDir);
    }
    if (fs.existsSync(pluginDir)) {
      result.set(entry.name, pluginDir);
    }
  }

  return result;
}

// ----------------------------------------------------------------------------
// Bundled Skills Catalog
// ----------------------------------------------------------------------------
// Skills under `packages/agent/skills/` are exposed as standalone marketplace
// entries (`kind: 'skill'`) so users can selectively install them instead of
// having all skills auto-synced at runtime. Each skill becomes one catalog
// entry; installing copies the skill directory into the plugin's `skills/`
// folder, from where the existing skill loader picks it up.

/**
 * Resolve the bundled skills directory in the main process.
 * - Dev: `<repo>/packages/agent/skills`
 * - Prod: `<resourcesPath>/agent/skills` (electron-builder extraResources)
 */
function getBundledSkillsDir(): string {
  if (app.isPackaged) {
    return path.join(process.resourcesPath, 'agent', 'skills');
  }
  return path.join(app.getAppPath(), 'packages', 'agent', 'skills');
}

/**
 * Map a skill category directory name to a `PluginCategory` for marketplace
 * grouping. Skill categories follow the directory layout under
 * `packages/agent/skills/` (agentic, apple, cognition, communication,
 * development, media, office, research, websearch, visualize).
 */
const SKILL_CATEGORY_TO_PLUGIN_CATEGORY: Record<string, PluginCategory> = {
  agentic: 'development',
  apple: 'productivity',
  cognition: 'other',
  communication: 'communication',
  development: 'development',
  media: 'media',
  office: 'productivity',
  research: 'research',
  websearch: 'research',
  visualize: 'other',
};

interface BundledSkillInfo {
  /** Skill name from frontmatter `name` field. */
  name: string;
  /** Skill description from frontmatter. */
  description: string;
  /** Skill version from frontmatter, defaults to `'0.1.0'`. */
  version: string;
  /** Author name from frontmatter, defaults to `'DUYA Team'`. */
  author: string;
  /** Category directory name (e.g. `'office'`, `'research'`). */
  categoryDir: string;
  /** Absolute path to the skill source directory. */
  skillDir: string;
}

/**
 * Scan the bundled skills directory and collect one `BundledSkillInfo` per
 * skill (per category subdirectory containing a `SKILL.md`). Categories
 * without a `SKILL.md` child are skipped silently. Platform-conditional
 * skills (e.g. `apple/*` on non-macOS) are still listed — the marketplace
 * shows them, but the loader will skip them on incompatible platforms
 * after install.
 */
function scanBundledSkills(): BundledSkillInfo[] {
  const logger = getLogger();
  const root = getBundledSkillsDir();
  const skills: BundledSkillInfo[] = [];

  if (!fs.existsSync(root)) {
    logger.warn('Bundled skills directory not found', { dir: root }, COMPONENT);
    return skills;
  }

  let categoryDirs: fs.Dirent[];
  try {
    categoryDirs = fs.readdirSync(root, { withFileTypes: true });
  } catch (err) {
    logger.warn('Failed to read bundled skills directory', {
      dir: root,
      error: err instanceof Error ? err.message : String(err),
    }, COMPONENT);
    return skills;
  }

  for (const catEntry of categoryDirs) {
    if (!catEntry.isDirectory() || catEntry.name.startsWith('.')) continue;
    const categoryDir = catEntry.name;
    const categoryPath = path.join(root, categoryDir);

    let skillDirs: fs.Dirent[];
    try {
      skillDirs = fs.readdirSync(categoryPath, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const skillEntry of skillDirs) {
      if (!skillEntry.isDirectory() || skillEntry.name.startsWith('.')) continue;
      const skillDirPath = path.join(categoryPath, skillEntry.name);
      const skillMdPath = path.join(skillDirPath, 'SKILL.md');
      if (!fs.existsSync(skillMdPath)) continue;

      try {
        const raw = fs.readFileSync(skillMdPath, 'utf8');
        const { frontmatter } = parseSkillFrontmatter(raw);
        const name = (frontmatter.name as string) || skillEntry.name;
        const description = (frontmatter.description as string) || `Skill: ${name}`;
        const version = (frontmatter.version as string) || '0.1.0';
        const author = (frontmatter.author as string) || 'DUYA Team';
        skills.push({
          name,
          description,
          version,
          author,
          categoryDir,
          skillDir: skillDirPath,
        });
      } catch (err) {
        logger.warn('Failed to read skill frontmatter', {
          skill: skillEntry.name,
          category: categoryDir,
          error: err instanceof Error ? err.message : String(err),
        }, COMPONENT);
      }
    }
  }

  return skills;
}

let cachedSkillCatalog: PluginCatalogEntry[] | null = null;

/**
 * Build catalog entries for every bundled skill. Each entry is a
 * `kind: 'skill'` marketplace item that installs a single skill directory.
 * Results are cached for the process lifetime — the bundled skill set only
 * changes across app updates.
 */
function getBundledSkillCatalogEntries(): PluginCatalogEntry[] {
  if (cachedSkillCatalog) return cachedSkillCatalog;

  const skills = scanBundledSkills();
  cachedSkillCatalog = skills.map((skill) => {
    const id = `com.duya.skill.${skill.name}`;
    const manifest: PluginManifest = {
      schemaVersion: 'duya.plugin.v2',
      id,
      name: skill.name,
      version: skill.version,
      description: skill.description,
      author: { name: skill.author },
      components: {
        mcpServers: [],
        appConnections: [],
        skills: [skill.name],
        workflows: [],
      },
      permissions: [],
      engines: { duya: '>=0.1.0' },
    };
    return {
      id,
      name: skill.name,
      version: skill.version,
      description: skill.description,
      source: 'bundled' as const,
      category: SKILL_CATEGORY_TO_PLUGIN_CATEGORY[skill.categoryDir] || 'other',
      trustLevel: 'official' as const,
      kind: 'skill' as const,
      skillSourceDir: skill.skillDir,
      manifest,
      capabilityCounts: {
        skills: 1,
        mcpServers: 0,
        cli: 0,
        ui: 0,
        hooks: 0,
        workflows: 0,
      },
    };
  });

  return cachedSkillCatalog;
}
