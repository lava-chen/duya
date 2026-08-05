// electron/plugins/catalog.test.ts
// Plan 101 — Phase 0/4: failing baseline + post-Phase-4 contract test for
// catalog capabilityCounts derivation.
//
// Once Phase 4 lands, `deriveCapabilityCounts(manifest, pluginDir)` should
// derive counts from the on-disk plugin directory when one is provided
// (using `discoverAllCapabilities` from
// `packages/agent/src/plugins/builtin/capability-discovery.ts`), instead
// of relying on the `manifest.capabilities` field alone. The bundled
// `literature` entry must therefore resolve to
// `{ skills: 2, mcpServers: 1, cli: 0, ui: 0, hooks: 0 }`.

import { describe, it, expect, vi } from 'vitest';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

// Mock the electron module so the catalog module can be imported in a
// plain vitest environment (catalog.ts pulls in `app` lazily for the
// local-marketplace lookup, which we never trigger in this test).
vi.mock('electron', () => ({
  app: {
    isPackaged: false,
    getPath: () => '/tmp/duya-test',
  },
}));

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, '..', '..');
const LITERATURE_DIR = join(REPO_ROOT, 'packages', 'agent', 'src', 'plugins', 'builtin', 'literature');
const POSTGRES_READONLY_DIR = join(REPO_ROOT, 'packages', 'agent', 'src', 'plugins', 'builtin', 'postgres-readonly');

const LITERATURE_MANIFEST = {
  schemaVersion: 'duya.plugin.v1' as const,
  id: 'com.duya.literature',
  name: 'Literature Plugin',
  version: '0.1.0',
  description: 'Literature asset and evidence management for research workflows.',
  author: { name: 'DUYA Team' },
  capabilities: {
    skills: ['paper-analysis', 'citation-format'],
    mcpServers: [
      { name: 'literature', command: 'node', args: ['./agent-bundle/literature-mcp-server.js'] },
    ],
  },
  permissions: [
    { name: 'agent.memory.read', scope: 'research' },
    { name: 'agent.memory.write', scope: 'research' },
    { name: 'workspace.read' },
  ],
  engines: { duya: '>=0.1.0', node: '>=20' },
};

// Plan 313 Phase 0/3 — exercises the v2 subdirectory skills layout
// (`skills/<name>/SKILL.md`). The manifest inline shape stays v1 so the
// existing `PluginManifest` type accepts it; the on-disk `plugin.json` is
// v2 but the catalog loader does not read it yet. Phase 3 hardened the
// read-only posture: the connection string is passed as the first
// positional arg; read-only is enforced by the DB role + permission policy.
const POSTGRES_READONLY_MANIFEST = {
  schemaVersion: 'duya.plugin.v1' as const,
  id: 'com.duya.postgres-readonly',
  name: 'PostgreSQL Read-only',
  version: '0.1.0',
  description: 'Read-only PostgreSQL inspection, safe query, and data analysis.',
  author: { name: 'DUYA Team' },
  capabilities: {
    skills: ['schema-inspection', 'safe-query', 'data-analysis'],
    mcpServers: [
      { name: 'postgres-readonly', command: 'npx', args: ['-y', '@modelcontextprotocol/server-postgres', '${setup.connectionString}'] },
    ],
  },
  permissions: [
    { name: 'workspace.read' },
  ],
  setup: [
    { id: 'connectionString', label: 'PostgreSQL connection string — use a read-only role (e.g. duya_reader); read-only access is enforced by the database role, not an MCP flag', type: 'secret' as const, required: true },
  ],
  engines: { duya: '>=0.1.0' },
};

describe('deriveCapabilityCounts — derive from disk (post-Phase-4 contract)', () => {
  it('exposes a deriveCapabilityCounts helper', async () => {
    const mod = await import('./capability-counts.js');
    expect(typeof mod.deriveCapabilityCounts).toBe('function');
  });

  it('derives skills + hooks from the on-disk directory and mcpServers/cli from the manifest', async () => {
    const { deriveCapabilityCounts } = await import('./capability-counts.js');
    const counts = deriveCapabilityCounts(
      LITERATURE_MANIFEST as unknown as Parameters<typeof deriveCapabilityCounts>[0],
      LITERATURE_DIR,
    );
    expect(counts).toEqual({
      skills: 2,        // paper-analysis.md + citation-format.md
      mcpServers: 1,    // from manifest.capabilities.mcpServers
      cli: 0,
      ui: 0,
      hooks: 0,         // literature has no hooks/hooks.json
      workflows: 1,    // literature/workflows/ has one schema-valid template (Plan 311)
    });
  });

  it('falls back to manifest-only counts when no pluginDir is provided', async () => {
    const { deriveCapabilityCounts } = await import('./capability-counts.js');
    const counts = deriveCapabilityCounts(
      LITERATURE_MANIFEST as unknown as Parameters<typeof deriveCapabilityCounts>[0],
    );
    expect(counts).toEqual({
      skills: 2,        // 2 skill names in manifest
      mcpServers: 1,
      cli: 0,
      ui: 0,
      hooks: 0,         // 0 hook entries in manifest
      workflows: 0,    // v1 manifest has no components.workflows
    });
  });
});

// Plan 313 Phase 0 — the postgres-readonly plugin is the reference
// scaffold for the v2 subdirectory skills layout. The catalog must
// (a) include the entry, (b) derive 3 skills from disk via the extended
// `discoverSkills()` (subdirectory layout), and (c) keep mcpServers at 1.
describe('Plan 313 Phase 0 — postgres-readonly catalog entry', () => {
  it('is present in BUNDLED_PLUGIN_CATALOG with official trust and data category', async () => {
    const { BUNDLED_PLUGIN_CATALOG } = await import('./catalog.js');
    const entry = BUNDLED_PLUGIN_CATALOG.find((e) => e.id === 'com.duya.postgres-readonly');
    expect(entry).toBeDefined();
    expect(entry?.source).toBe('bundled');
    expect(entry?.trustLevel).toBe('official');
    expect(entry?.category).toBe('data');
    expect(entry?.name).toBe('PostgreSQL Read-only');
    expect(entry?.manifest.capabilities.skills).toEqual([
      'schema-inspection',
      'safe-query',
      'data-analysis',
    ]);
  });

  it('derives 3 skills + 1 mcpServer from the on-disk subdirectory layout', async () => {
    const { deriveCapabilityCounts } = await import('./capability-counts.js');
    const counts = deriveCapabilityCounts(
      POSTGRES_READONLY_MANIFEST as unknown as Parameters<typeof deriveCapabilityCounts>[0],
      POSTGRES_READONLY_DIR,
    );
    expect(counts).toEqual({
      skills: 3,        // schema-inspection / safe-query / data-analysis
      mcpServers: 1,    // postgres-readonly MCP server
      cli: 0,
      ui: 0,
      hooks: 0,
      workflows: 0,
    });
  });

  it('exposes a read-only setup field for the connection string', async () => {
    const { BUNDLED_PLUGIN_CATALOG } = await import('./catalog.js');
    const entry = BUNDLED_PLUGIN_CATALOG.find((e) => e.id === 'com.duya.postgres-readonly');
    expect(entry?.manifest.setup).toEqual([
      expect.objectContaining({
        id: 'connectionString',
        type: 'secret',
        required: true,
      }),
    ]);
  });
});

// Plan 313 Phase 1a — GitHub Development plugin. Skills use the v2
// subdirectory layout; catalog must list 5 skills + 1 MCP server.
describe('Plan 313 Phase 1a — github-development catalog entry', () => {
  const GITHUB_DIR = join(REPO_ROOT, 'packages', 'agent', 'src', 'plugins', 'builtin', 'github-development');

  const GITHUB_MANIFEST = {
    schemaVersion: 'duya.plugin.v1' as const,
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
        { name: 'github', command: 'docker', args: ['run', '-i', '--rm', '-e', 'GITHUB_PERSONAL_ACCESS_TOKEN', 'ghcr.io/github/github-mcp-server'] },
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
        type: 'secret' as const,
        required: true,
      },
    ],
    engines: { duya: '>=0.1.0' },
  };

  it('is present in BUNDLED_PLUGIN_CATALOG with official trust and development category', async () => {
    const { BUNDLED_PLUGIN_CATALOG } = await import('./catalog.js');
    const entry = BUNDLED_PLUGIN_CATALOG.find((e) => e.id === 'com.duya.github-development');
    expect(entry).toBeDefined();
    expect(entry?.source).toBe('bundled');
    expect(entry?.trustLevel).toBe('official');
    expect(entry?.category).toBe('development');
  });

  it('derives 5 skills + 1 mcpServer from the on-disk subdirectory layout', async () => {
    const { deriveCapabilityCounts } = await import('./capability-counts.js');
    const counts = deriveCapabilityCounts(
      GITHUB_MANIFEST as unknown as Parameters<typeof deriveCapabilityCounts>[0],
      GITHUB_DIR,
    );
    expect(counts).toEqual({
      skills: 5,
      mcpServers: 1,
      cli: 0,
      ui: 0,
      hooks: 0,
      workflows: 0,
    });
  });

  it('runs the official github-mcp-server image via Docker as the transitional transport', async () => {
    const { BUNDLED_PLUGIN_CATALOG } = await import('./catalog.js');
    const entry = BUNDLED_PLUGIN_CATALOG.find((e) => e.id === 'com.duya.github-development');
    const server = entry?.manifest.capabilities.mcpServers?.[0];
    expect(server?.command).toBe('docker');
    expect(server?.args).toEqual(['run', '-i', '--rm', '-e', 'GITHUB_PERSONAL_ACCESS_TOKEN', 'ghcr.io/github/github-mcp-server']);
  });
});

// Plan 313 Phase 1b — Playwright Web Operator plugin. Catalog must list
// 5 skills + 1 MCP server, and the MCP command must align with the
// legacy `playwright` preset in `preset-mcp-servers.ts`.
describe('Plan 313 Phase 1b — playwright-web-operator catalog entry', () => {
  const PLAYWRIGHT_DIR = join(REPO_ROOT, 'packages', 'agent', 'src', 'plugins', 'builtin', 'playwright-web-operator');

  const PLAYWRIGHT_MANIFEST = {
    schemaVersion: 'duya.plugin.v1' as const,
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
        { name: 'playwright', command: 'npx', args: ['-y', '@playwright/mcp'] },
      ],
    },
    permissions: [
      { name: 'workspace.read' },
      { name: 'workspace.write' },
    ],
    engines: { duya: '>=0.1.0' },
  };

  it('is present in BUNDLED_PLUGIN_CATALOG with official trust and automation category', async () => {
    const { BUNDLED_PLUGIN_CATALOG } = await import('./catalog.js');
    const entry = BUNDLED_PLUGIN_CATALOG.find((e) => e.id === 'com.duya.playwright-web-operator');
    expect(entry).toBeDefined();
    expect(entry?.source).toBe('bundled');
    expect(entry?.trustLevel).toBe('official');
    expect(entry?.category).toBe('automation');
  });

  it('derives 5 skills + 1 mcpServer from the on-disk subdirectory layout', async () => {
    const { deriveCapabilityCounts } = await import('./capability-counts.js');
    const counts = deriveCapabilityCounts(
      PLAYWRIGHT_MANIFEST as unknown as Parameters<typeof deriveCapabilityCounts>[0],
      PLAYWRIGHT_DIR,
    );
    expect(counts).toEqual({
      skills: 5,
      mcpServers: 1,
      cli: 0,
      ui: 0,
      hooks: 0,
      workflows: 0,
    });
  });

  it('aligns the MCP command with the legacy playwright preset', async () => {
    const { BUNDLED_PLUGIN_CATALOG } = await import('./catalog.js');
    const entry = BUNDLED_PLUGIN_CATALOG.find((e) => e.id === 'com.duya.playwright-web-operator');
    const server = entry?.manifest.capabilities.mcpServers?.[0];
    // Mirrors preset-mcp-servers.ts line 127: npx -y @playwright/mcp
    expect(server?.command).toBe('npx');
    expect(server?.args).toEqual(['-y', '@playwright/mcp']);
  });
});

// Plan 313 Phase 3 — postgres-readonly hardening. The connection string is
// passed as the first positional arg (server-postgres parses argv[2] as the
// URL directly; --read-only is not a supported flag). Read-only posture is
// enforced by the DB role plus the permission policy.
describe('Plan 313 Phase 3 — postgres-readonly read-only hardening', () => {
  it('passes the connection string as the first positional MCP arg', async () => {
    const { BUNDLED_PLUGIN_CATALOG } = await import('./catalog.js');
    const entry = BUNDLED_PLUGIN_CATALOG.find((e) => e.id === 'com.duya.postgres-readonly');
    const server = entry?.manifest.capabilities.mcpServers?.[0];
    // server-postgres expects the connection string at process.argv[2];
    // ${setup.connectionString} is substituted by expandMcpServerConfig.
    expect(server?.args).toEqual(['-y', '@modelcontextprotocol/server-postgres', '${setup.connectionString}']);
  });

  it('documents the read-only role requirement in the setup label', async () => {
    const { BUNDLED_PLUGIN_CATALOG } = await import('./catalog.js');
    const entry = BUNDLED_PLUGIN_CATALOG.find((e) => e.id === 'com.duya.postgres-readonly');
    const setup = entry?.manifest.setup?.[0];
    expect(setup?.id).toBe('connectionString');
    expect(setup?.type).toBe('secret');
    expect(setup?.label).toMatch(/read-only role/i);
    expect(setup?.label).toMatch(/database role/i);
  });
});

// Plan 313 Phase 2b — Figma Design plugin. Skills use the v2
// subdirectory layout; catalog must list 5 skills + 1 MCP server, and
// 4 schema-valid workflows.
describe('Plan 313 Phase 2b — figma-design catalog entry', () => {
  const FIGMA_DIR = join(REPO_ROOT, 'packages', 'agent', 'src', 'plugins', 'builtin', 'figma-design');

  const FIGMA_MANIFEST = {
    schemaVersion: 'duya.plugin.v1' as const,
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
        { name: 'figma', command: 'npx', args: ['-y', 'figma-developer-mcp', '--stdio'] },
      ],
    },
    permissions: [
      { name: 'workspace.read' },
      { name: 'workspace.write' },
    ],
    setup: [
      { id: 'figmaApiKey', label: 'Figma personal access token (preferred: scoped to Dev Mode)', type: 'secret' as const, required: true },
    ],
    engines: { duya: '>=0.1.0' },
  };

  it('is present in BUNDLED_PLUGIN_CATALOG with official trust and development category', async () => {
    const { BUNDLED_PLUGIN_CATALOG } = await import('./catalog.js');
    const entry = BUNDLED_PLUGIN_CATALOG.find((e) => e.id === 'com.duya.figma-design');
    expect(entry).toBeDefined();
    expect(entry?.source).toBe('bundled');
    expect(entry?.trustLevel).toBe('official');
    expect(entry?.category).toBe('development');
  });

  it('derives 5 skills + 1 mcpServer + 4 workflows from the on-disk layout', async () => {
    const { deriveCapabilityCounts } = await import('./capability-counts.js');
    const counts = deriveCapabilityCounts(
      FIGMA_MANIFEST as unknown as Parameters<typeof deriveCapabilityCounts>[0],
      FIGMA_DIR,
    );
    expect(counts).toEqual({
      skills: 5,
      mcpServers: 1,
      cli: 0,
      ui: 0,
      hooks: 0,
      workflows: 4,
    });
  });

  it('uses the figma-developer-mcp stdio fallback as transitional transport', async () => {
    const { BUNDLED_PLUGIN_CATALOG } = await import('./catalog.js');
    const entry = BUNDLED_PLUGIN_CATALOG.find((e) => e.id === 'com.duya.figma-design');
    const server = entry?.manifest.capabilities.mcpServers?.[0];
    expect(server?.command).toBe('npx');
    expect(server?.args).toEqual(['-y', 'figma-developer-mcp', '--stdio']);
  });

  it('exposes a secret setup field for the Figma access token', async () => {
    const { BUNDLED_PLUGIN_CATALOG } = await import('./catalog.js');
    const entry = BUNDLED_PLUGIN_CATALOG.find((e) => e.id === 'com.duya.figma-design');
    expect(entry?.manifest.setup).toEqual([
      expect.objectContaining({
        id: 'figmaApiKey',
        type: 'secret',
        required: true,
      }),
    ]);
  });
});

// Plan 313 Phase 2b — Supabase Development plugin. Catalog must list
// 4 skills + 1 MCP server + 4 workflows.
describe('Plan 313 Phase 2b — supabase-development catalog entry', () => {
  const SUPABASE_DIR = join(REPO_ROOT, 'packages', 'agent', 'src', 'plugins', 'builtin', 'supabase-development');

  const SUPABASE_MANIFEST = {
    schemaVersion: 'duya.plugin.v1' as const,
    id: 'com.duya.supabase-development',
    name: 'Supabase Development',
    version: '0.1.0',
    description: 'Supabase Postgres, migrations, Edge Functions, and auth.',
    author: { name: 'DUYA Team' },
    capabilities: {
      skills: [
        'postgres-best-practices',
        'migration-workflow',
        'edge-function-workflow',
        'auth-and-security',
      ],
      mcpServers: [
        { name: 'supabase', command: 'npx', args: ['-y', '@supabase/mcp-server-supabase'] },
      ],
    },
    permissions: [
      { name: 'workspace.read' },
      { name: 'workspace.write' },
    ],
    setup: [
      { id: 'supabaseAccessToken', label: 'Supabase personal access token', type: 'secret' as const, required: true },
      { id: 'supabaseProjectRef', label: 'Supabase project ref', type: 'text' as const, required: true },
    ],
    engines: { duya: '>=0.1.0' },
  };

  it('is present in BUNDLED_PLUGIN_CATALOG with official trust and development category', async () => {
    const { BUNDLED_PLUGIN_CATALOG } = await import('./catalog.js');
    const entry = BUNDLED_PLUGIN_CATALOG.find((e) => e.id === 'com.duya.supabase-development');
    expect(entry).toBeDefined();
    expect(entry?.source).toBe('bundled');
    expect(entry?.trustLevel).toBe('official');
    expect(entry?.category).toBe('development');
  });

  it('derives 4 skills + 1 mcpServer + 4 workflows from the on-disk layout', async () => {
    const { deriveCapabilityCounts } = await import('./capability-counts.js');
    const counts = deriveCapabilityCounts(
      SUPABASE_MANIFEST as unknown as Parameters<typeof deriveCapabilityCounts>[0],
      SUPABASE_DIR,
    );
    expect(counts).toEqual({
      skills: 4,
      mcpServers: 1,
      cli: 0,
      ui: 0,
      hooks: 0,
      workflows: 4,
    });
  });

  it('uses the @supabase/mcp-server-supabase stdio fallback', async () => {
    const { BUNDLED_PLUGIN_CATALOG } = await import('./catalog.js');
    const entry = BUNDLED_PLUGIN_CATALOG.find((e) => e.id === 'com.duya.supabase-development');
    const server = entry?.manifest.capabilities.mcpServers?.[0];
    expect(server?.command).toBe('npx');
    expect(server?.args?.[1]).toBe('@supabase/mcp-server-supabase');
  });

  it('exposes a secret setup field for the access token and a text field for project ref', async () => {
    const { BUNDLED_PLUGIN_CATALOG } = await import('./catalog.js');
    const entry = BUNDLED_PLUGIN_CATALOG.find((e) => e.id === 'com.duya.supabase-development');
    const setup = entry?.manifest.setup ?? [];
    expect(setup).toContainEqual(expect.objectContaining({ id: 'supabaseAccessToken', type: 'secret', required: true }));
    expect(setup).toContainEqual(expect.objectContaining({ id: 'supabaseProjectRef', type: 'text', required: true }));
  });
});

// Plan 313 Phase 2b — Sentry Debugging plugin. Catalog must list
// 4 skills + 1 MCP server + 3 workflows.
describe('Plan 313 Phase 2b — sentry-debugging catalog entry', () => {
  const SENTRY_DIR = join(REPO_ROOT, 'packages', 'agent', 'src', 'plugins', 'builtin', 'sentry-debugging');

  const SENTRY_MANIFEST = {
    schemaVersion: 'duya.plugin.v1' as const,
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
        { name: 'sentry', command: 'npx', args: ['-y', '@sentry/mcp-server'] },
      ],
    },
    permissions: [
      { name: 'workspace.read' },
      { name: 'workspace.write' },
    ],
    setup: [
      { id: 'sentryAuthToken', label: 'Sentry auth token', type: 'secret' as const, required: true },
      { id: 'sentryOrgSlug', label: 'Sentry organization slug', type: 'text' as const, required: true },
    ],
    engines: { duya: '>=0.1.0' },
  };

  it('is present in BUNDLED_PLUGIN_CATALOG with official trust and development category', async () => {
    const { BUNDLED_PLUGIN_CATALOG } = await import('./catalog.js');
    const entry = BUNDLED_PLUGIN_CATALOG.find((e) => e.id === 'com.duya.sentry-debugging');
    expect(entry).toBeDefined();
    expect(entry?.source).toBe('bundled');
    expect(entry?.trustLevel).toBe('official');
    expect(entry?.category).toBe('development');
  });

  it('derives 4 skills + 1 mcpServer + 3 workflows from the on-disk layout', async () => {
    const { deriveCapabilityCounts } = await import('./capability-counts.js');
    const counts = deriveCapabilityCounts(
      SENTRY_MANIFEST as unknown as Parameters<typeof deriveCapabilityCounts>[0],
      SENTRY_DIR,
    );
    expect(counts).toEqual({
      skills: 4,
      mcpServers: 1,
      cli: 0,
      ui: 0,
      hooks: 0,
      workflows: 3,
    });
  });

  it('uses the @sentry/mcp-server stdio fallback', async () => {
    const { BUNDLED_PLUGIN_CATALOG } = await import('./catalog.js');
    const entry = BUNDLED_PLUGIN_CATALOG.find((e) => e.id === 'com.duya.sentry-debugging');
    const server = entry?.manifest.capabilities.mcpServers?.[0];
    expect(server?.command).toBe('npx');
    expect(server?.args).toEqual(['-y', '@sentry/mcp-server']);
  });

  it('exposes a secret setup field for the auth token and a text field for the org slug', async () => {
    const { BUNDLED_PLUGIN_CATALOG } = await import('./catalog.js');
    const entry = BUNDLED_PLUGIN_CATALOG.find((e) => e.id === 'com.duya.sentry-debugging');
    const setup = entry?.manifest.setup ?? [];
    expect(setup).toContainEqual(expect.objectContaining({ id: 'sentryAuthToken', type: 'secret', required: true }));
    expect(setup).toContainEqual(expect.objectContaining({ id: 'sentryOrgSlug', type: 'text', required: true }));
  });
});

// Plan 313 Phase 2c — Vercel Deployment plugin. Catalog must list
// 4 skills + 1 MCP server + 4 workflows.
describe('Plan 313 Phase 2c — vercel-deployment catalog entry', () => {
  const VERCEL_DIR = join(REPO_ROOT, 'packages', 'agent', 'src', 'plugins', 'builtin', 'vercel-deployment');

  const VERCEL_MANIFEST = {
    schemaVersion: 'duya.plugin.v1' as const,
    id: 'com.duya.vercel-deployment',
    name: 'Vercel Deployment',
    version: '0.1.0',
    description: 'Vercel deployment inspection, log diagnosis, preview validation, and production release.',
    author: { name: 'DUYA Team' },
    capabilities: {
      skills: [
        'deployment-inspection',
        'log-diagnosis',
        'preview-validation',
        'production-release',
      ],
      mcpServers: [
        { name: 'vercel', command: 'npx', args: ['-y', 'vercel-mcp-adapter'] },
      ],
    },
    permissions: [
      { name: 'workspace.read' },
      { name: 'workspace.write' },
    ],
    setup: [
      { id: 'vercelToken', label: 'Vercel access token', type: 'secret' as const, required: true },
      { id: 'vercelTeamId', label: 'Vercel team slug or ID', type: 'text' as const, required: true },
    ],
    engines: { duya: '>=0.1.0' },
  };

  it('is present in BUNDLED_PLUGIN_CATALOG with official trust and development category', async () => {
    const { BUNDLED_PLUGIN_CATALOG } = await import('./catalog.js');
    const entry = BUNDLED_PLUGIN_CATALOG.find((e) => e.id === 'com.duya.vercel-deployment');
    expect(entry).toBeDefined();
    expect(entry?.source).toBe('bundled');
    expect(entry?.trustLevel).toBe('official');
    expect(entry?.category).toBe('development');
  });

  it('derives 4 skills + 1 mcpServer + 4 workflows from the on-disk layout', async () => {
    const { deriveCapabilityCounts } = await import('./capability-counts.js');
    const counts = deriveCapabilityCounts(
      VERCEL_MANIFEST as unknown as Parameters<typeof deriveCapabilityCounts>[0],
      VERCEL_DIR,
    );
    expect(counts).toEqual({
      skills: 4,
      mcpServers: 1,
      cli: 0,
      ui: 0,
      hooks: 0,
      workflows: 4,
    });
  });

  it('uses the vercel-mcp-adapter stdio fallback', async () => {
    const { BUNDLED_PLUGIN_CATALOG } = await import('./catalog.js');
    const entry = BUNDLED_PLUGIN_CATALOG.find((e) => e.id === 'com.duya.vercel-deployment');
    const server = entry?.manifest.capabilities.mcpServers?.[0];
    expect(server?.command).toBe('npx');
    expect(server?.args).toEqual(['-y', 'vercel-mcp-adapter']);
  });

  it('exposes a secret setup field for the token and a text field for the team id', async () => {
    const { BUNDLED_PLUGIN_CATALOG } = await import('./catalog.js');
    const entry = BUNDLED_PLUGIN_CATALOG.find((e) => e.id === 'com.duya.vercel-deployment');
    const setup = entry?.manifest.setup ?? [];
    expect(setup).toContainEqual(expect.objectContaining({ id: 'vercelToken', type: 'secret', required: true }));
    expect(setup).toContainEqual(expect.objectContaining({ id: 'vercelTeamId', type: 'text', required: true }));
  });
});

// Plan 313 Phase 2c — Notion Knowledge plugin. Catalog must list
// 5 skills + 1 MCP server + 4 workflows. Productivity category (the
// only non-development entry in the first batch of 9).
describe('Plan 313 Phase 2c — notion-knowledge catalog entry', () => {
  const NOTION_DIR = join(REPO_ROOT, 'packages', 'agent', 'src', 'plugins', 'builtin', 'notion-knowledge');

  const NOTION_MANIFEST = {
    schemaVersion: 'duya.plugin.v1' as const,
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
        { name: 'notion', command: 'npx', args: ['-y', '@notionhq/notion-mcp-server'] },
      ],
    },
    permissions: [
      { name: 'workspace.read' },
      { name: 'workspace.write' },
    ],
    setup: [
      { id: 'notionApiKey', label: 'Notion internal integration token', type: 'secret' as const, required: true },
    ],
    engines: { duya: '>=0.1.0' },
  };

  it('is present in BUNDLED_PLUGIN_CATALOG with official trust and productivity category', async () => {
    const { BUNDLED_PLUGIN_CATALOG } = await import('./catalog.js');
    const entry = BUNDLED_PLUGIN_CATALOG.find((e) => e.id === 'com.duya.notion-knowledge');
    expect(entry).toBeDefined();
    expect(entry?.source).toBe('bundled');
    expect(entry?.trustLevel).toBe('official');
    expect(entry?.category).toBe('productivity');
  });

  it('derives 5 skills + 1 mcpServer + 4 workflows from the on-disk layout', async () => {
    const { deriveCapabilityCounts } = await import('./capability-counts.js');
    const counts = deriveCapabilityCounts(
      NOTION_MANIFEST as unknown as Parameters<typeof deriveCapabilityCounts>[0],
      NOTION_DIR,
    );
    expect(counts).toEqual({
      skills: 5,
      mcpServers: 1,
      cli: 0,
      ui: 0,
      hooks: 0,
      workflows: 4,
    });
  });

  it('uses the @notionhq/notion-mcp-server stdio fallback', async () => {
    const { BUNDLED_PLUGIN_CATALOG } = await import('./catalog.js');
    const entry = BUNDLED_PLUGIN_CATALOG.find((e) => e.id === 'com.duya.notion-knowledge');
    const server = entry?.manifest.capabilities.mcpServers?.[0];
    expect(server?.command).toBe('npx');
    expect(server?.args).toEqual(['-y', '@notionhq/notion-mcp-server']);
  });

  it('exposes a secret setup field for the integration token', async () => {
    const { BUNDLED_PLUGIN_CATALOG } = await import('./catalog.js');
    const entry = BUNDLED_PLUGIN_CATALOG.find((e) => e.id === 'com.duya.notion-knowledge');
    expect(entry?.manifest.setup).toEqual([
      expect.objectContaining({
        id: 'notionApiKey',
        type: 'secret',
        required: true,
      }),
    ]);
  });
});

// Plan 313 Phase 2c — Linear Project Execution plugin. Catalog must
// list 5 skills + 1 MCP server + 4 workflows.
describe('Plan 313 Phase 2c — linear-project-execution catalog entry', () => {
  const LINEAR_DIR = join(REPO_ROOT, 'packages', 'agent', 'src', 'plugins', 'builtin', 'linear-project-execution');

  const LINEAR_MANIFEST = {
    schemaVersion: 'duya.plugin.v1' as const,
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
        { name: 'linear', command: 'npx', args: ['-y', '@tacticlaunch/mcp-linear'] },
      ],
    },
    permissions: [
      { name: 'workspace.read' },
      { name: 'workspace.write' },
    ],
    setup: [
      { id: 'linearApiKey', label: 'Linear personal API key', type: 'secret' as const, required: true },
    ],
    engines: { duya: '>=0.1.0' },
  };

  it('is present in BUNDLED_PLUGIN_CATALOG with official trust and development category', async () => {
    const { BUNDLED_PLUGIN_CATALOG } = await import('./catalog.js');
    const entry = BUNDLED_PLUGIN_CATALOG.find((e) => e.id === 'com.duya.linear-project-execution');
    expect(entry).toBeDefined();
    expect(entry?.source).toBe('bundled');
    expect(entry?.trustLevel).toBe('official');
    expect(entry?.category).toBe('development');
  });

  it('derives 5 skills + 1 mcpServer + 4 workflows from the on-disk layout', async () => {
    const { deriveCapabilityCounts } = await import('./capability-counts.js');
    const counts = deriveCapabilityCounts(
      LINEAR_MANIFEST as unknown as Parameters<typeof deriveCapabilityCounts>[0],
      LINEAR_DIR,
    );
    expect(counts).toEqual({
      skills: 5,
      mcpServers: 1,
      cli: 0,
      ui: 0,
      hooks: 0,
      workflows: 4,
    });
  });

  it('uses the @tacticlaunch/mcp-linear stdio fallback', async () => {
    const { BUNDLED_PLUGIN_CATALOG } = await import('./catalog.js');
    const entry = BUNDLED_PLUGIN_CATALOG.find((e) => e.id === 'com.duya.linear-project-execution');
    const server = entry?.manifest.capabilities.mcpServers?.[0];
    expect(server?.command).toBe('npx');
    expect(server?.args).toEqual(['-y', '@tacticlaunch/mcp-linear']);
  });

  it('exposes a secret setup field for the API key', async () => {
    const { BUNDLED_PLUGIN_CATALOG } = await import('./catalog.js');
    const entry = BUNDLED_PLUGIN_CATALOG.find((e) => e.id === 'com.duya.linear-project-execution');
    expect(entry?.manifest.setup).toEqual([
      expect.objectContaining({
        id: 'linearApiKey',
        type: 'secret',
        required: true,
      }),
    ]);
  });
});

// Plan 313 Phase 5 — full catalog coverage. The 9 first-party plugins
// (literature + devtools + postgres-readonly + github-development +
// playwright-web-operator + figma-design + supabase-development +
// sentry-debugging + vercel-deployment + notion-knowledge +
// linear-project-execution) should all be present, all marked
// `trustLevel: 'official'`, and all marked `source: 'bundled'`.
describe('Plan 313 Phase 5 — full first-party catalog coverage', () => {
  const EXPECTED_OFFICIAL_IDS = [
    'com.duya.literature',
    'com.duya.devtools',
    'com.duya.postgres-readonly',
    'com.duya.github-development',
    'com.duya.playwright-web-operator',
    'com.duya.figma-design',
    'com.duya.supabase-development',
    'com.duya.sentry-debugging',
    'com.duya.vercel-deployment',
    'com.duya.notion-knowledge',
    'com.duya.linear-project-execution',
  ];

  it('every expected official entry is present, bundled, and official-trust', async () => {
    const { BUNDLED_PLUGIN_CATALOG } = await import('./catalog.js');
    for (const id of EXPECTED_OFFICIAL_IDS) {
      const entry = BUNDLED_PLUGIN_CATALOG.find((e) => e.id === id);
      expect(entry, `expected catalog entry for ${id}`).toBeDefined();
      expect(entry?.source).toBe('bundled');
      expect(entry?.trustLevel).toBe('official');
    }
  });

  it('no duplicate ids in BUNDLED_PLUGIN_CATALOG', async () => {
    const { BUNDLED_PLUGIN_CATALOG } = await import('./catalog.js');
    const ids = BUNDLED_PLUGIN_CATALOG.map((e) => e.id);
    const unique = new Set(ids);
    expect(unique.size).toBe(ids.length);
  });
});

