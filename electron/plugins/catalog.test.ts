// electron/plugins/catalog.test.ts
// Plan: plugin-config-simplification — tests for the disk-reading catalog.
//
// Self-contained tests using temp fixture plugins. No dependency on the
// real plugin source tree (plugins come from the duya-marketplace repo —
// plan 455).

import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

// Mock electron so the catalog module can be imported in a plain vitest
// environment.
vi.mock('electron', () => ({
  app: {
    isPackaged: false,
    getPath: () => '/tmp/duya-test',
    getAppPath: () => process.cwd(),
  },
}));

// Mutable marketplace registry so a test can point the catalog at temp
// fixture marketplaces. Everything else returns undefined, matching the
// unconfigured store the rest of this file already runs against.
const configMocks = vi.hoisted(() => ({
  marketplaces: {} as Record<string, unknown>,
}));

vi.mock('../config/store-instance', () => ({
  getConfigStore: () => ({
    getByPath: (path: string) =>
      path === 'marketplaces' ? configMocks.marketplaces : undefined,
  }),
}));

// ----------------------------------------------------------------------------
// Temp fixture builder — creates minimal on-disk plugins for testing.
// ----------------------------------------------------------------------------

interface FixturePlugin {
  name: string;
  version: string;
  description: string;
  category?: string;
  setup?: Array<{ id: string; label: string; type: string; required: boolean }>;
  skills?: string[];
  mcpServers?: Array<{ name: string; command: string; args?: string[] }>;
  workflows?: string[];
}

function buildFixturePlugin(root: string, plugin: FixturePlugin): string {
  const pluginDir = join(root, plugin.name);
  // .duya-plugin/plugin.json
  mkdirSync(join(pluginDir, '.duya-plugin'), { recursive: true });
  const manifest: Record<string, unknown> = {
    name: plugin.name,
    version: plugin.version,
    description: plugin.description,
    author: { name: 'DUYA Team', url: 'https://github.com/lava-chen/duya' },
    license: 'MIT',
    keywords: [plugin.name],
  };
  if (plugin.setup) manifest.setup = plugin.setup;
  if (plugin.category) {
    manifest.interface = {
      displayName: plugin.name,
      longDescription: plugin.description,
      category: plugin.category,
    };
  }
  writeFileSync(join(pluginDir, '.duya-plugin', 'plugin.json'), JSON.stringify(manifest, null, 2));

  // skills/<name>/SKILL.md
  if (plugin.skills) {
    for (const skill of plugin.skills) {
      mkdirSync(join(pluginDir, 'skills', skill), { recursive: true });
      writeFileSync(join(pluginDir, 'skills', skill, 'SKILL.md'), `# ${skill}\n`);
    }
  }

  // mcp/servers.json
  if (plugin.mcpServers) {
    mkdirSync(join(pluginDir, 'mcp'), { recursive: true });
    writeFileSync(
      join(pluginDir, 'mcp', 'servers.json'),
      JSON.stringify({ servers: plugin.mcpServers }, null, 2),
    );
  }

  // workflows/<name>.yaml (minimal valid workflow matching WorkflowTemplateSchema)
  if (plugin.workflows) {
    mkdirSync(join(pluginDir, 'workflows'), { recursive: true });
    for (const wf of plugin.workflows) {
      writeFileSync(
        join(pluginDir, 'workflows', `${wf}.yaml`),
        `id: ${wf}\nname: ${wf}\ndescription: ${wf} workflow\nprompt: "Do ${wf}"\n`,
      );
    }
  }

  // permissions/policy.json (required by readPluginManifest)
  mkdirSync(join(pluginDir, 'permissions'), { recursive: true });
  writeFileSync(
    join(pluginDir, 'permissions', 'policy.json'),
    JSON.stringify({ defaultMode: 'workspace', permissions: [] }, null, 2),
  );

  return pluginDir;
}

// Fixture plugin definitions
const FIXTURE_PLUGINS: FixturePlugin[] = [
  {
    name: 'test-research',
    version: '0.1.0',
    description: 'Test research plugin with skills, MCP, and workflows.',
    category: 'research',
    skills: ['paper-analysis', 'citation-format'],
    mcpServers: [{ name: 'test-research-mcp', command: 'node', args: ['server.js'] }],
    workflows: ['literature-review'],
  },
  {
    name: 'test-data',
    version: '0.2.0',
    description: 'Test data plugin with a setup field.',
    category: 'data',
    setup: [
      { id: 'connectionString', label: 'Connection string', type: 'secret', required: true },
    ],
    skills: ['schema-inspection', 'safe-query', 'data-analysis'],
    mcpServers: [{ name: 'test-data-mcp', command: 'npx', args: ['-y', 'server-pg'] }],
  },
];

// ----------------------------------------------------------------------------
// Test state
// ----------------------------------------------------------------------------

const state = vi.hoisted(() => ({
  tempRoot: '',
  fixtureRoots: [] as string[],
}));

// Build fixtures once for all tests
beforeAll(() => {
  state.tempRoot = mkdtempSync(join(tmpdir(), 'duya-catalog-test-'));
  state.fixtureRoots = FIXTURE_PLUGINS.map((p) => buildFixturePlugin(state.tempRoot, p));
});

afterAll(() => {
  if (state.tempRoot) rmSync(state.tempRoot, { recursive: true, force: true });
});

// ----------------------------------------------------------------------------
// deriveCapabilityCounts — on-disk derivation
// ----------------------------------------------------------------------------

const RESEARCH_MANIFEST = {
  id: 'com.duya.test-research',
  name: 'test-research',
  version: '0.1.0',
  capabilities: {
    skills: ['paper-analysis', 'citation-format'],
    mcpServers: [{ name: 'test-research-mcp', command: 'node', args: ['server.js'] }],
  },
};

describe('deriveCapabilityCounts — derive from disk', () => {
  it('exposes a deriveCapabilityCounts helper', async () => {
    const mod = await import('./capability-counts.js');
    expect(typeof mod.deriveCapabilityCounts).toBe('function');
  });

  it('derives skills + mcpServers + workflows from the on-disk directory', async () => {
    const { deriveCapabilityCounts } = await import('./capability-counts.js');
    const counts = deriveCapabilityCounts(
      RESEARCH_MANIFEST as unknown as Parameters<typeof deriveCapabilityCounts>[0],
      state.fixtureRoots[0],
    );
    expect(counts).toEqual({
      skills: 2,
      mcpServers: 1,
      cli: 0,
      ui: 0,
      hooks: 0,
      workflows: 1,
    });
  });

  it('falls back to manifest-only counts when no pluginDir is provided', async () => {
    const { deriveCapabilityCounts } = await import('./capability-counts.js');
    const counts = deriveCapabilityCounts(
      RESEARCH_MANIFEST as unknown as Parameters<typeof deriveCapabilityCounts>[0],
    );
    expect(counts).toEqual({
      skills: 2,
      mcpServers: 1,
      cli: 0,
      ui: 0,
      hooks: 0,
      workflows: 0,
    });
  });
});

// ----------------------------------------------------------------------------
// getPluginCatalog — disk-reading scanner (marketplace source)
// ----------------------------------------------------------------------------

describe('getPluginCatalog — smoke', () => {
  it('returns a catalog without duplicate ids', async () => {
    const { getPluginCatalog } = await import('./catalog.js');
    const catalog = await getPluginCatalog();
    expect(Array.isArray(catalog)).toBe(true);
    const ids = catalog.map((e) => e.id);
    const unique = new Set(ids);
    expect(unique.size).toBe(ids.length);
  });
});

// ----------------------------------------------------------------------------
// Plan 529 fix regression guard: the directory-level dedup must run once
// per marketplace, not once per plugin. The original placement inside the
// per-plugin loop reported pluginCount 1 for every marketplace and dropped
// every sibling plugin.
// ----------------------------------------------------------------------------

describe('getMarketplaceStatuses — multi-plugin marketplace', () => {
  function buildMarketplace(id: string, pluginNames: string[]): string {
    const mk = mkdtempSync(join(tmpdir(), `duya-mp-${id}-`));
    writeFileSync(
      join(mk, 'marketplace.json'),
      JSON.stringify({
        name: id,
        plugins: pluginNames.map((name) => ({
          name,
          source: { source: 'local', path: `./plugins/${name}` },
        })),
      }),
    );
    for (const name of pluginNames) {
      const pdir = join(mk, 'plugins', name, '.duya-plugin');
      mkdirSync(pdir, { recursive: true });
      writeFileSync(
        join(pdir, 'plugin.json'),
        JSON.stringify({ name, version: '1.0.0', description: `${name} fixture` }),
      );
    }
    return mk;
  }

  it('counts every plugin in a marketplace, not just the first', async () => {
    const { getMarketplaceStatuses } = await import('./catalog.js');
    // Distinct plugin names per marketplace so the cross-marketplace id
    // dedup is orthogonal to what this test measures.
    const m1 = buildMarketplace('m1', ['alpha-one', 'beta-one', 'gamma-one']);
    const m2 = buildMarketplace('m2', ['alpha-two', 'beta-two']);
    configMocks.marketplaces = {
      m1: { source: 'local', path: m1 },
      m2: { source: 'local', path: m2 },
    };

    try {
      const statuses = getMarketplaceStatuses();
      const byName = Object.fromEntries(statuses.map((s) => [s.marketplace, s]));
      expect(byName.m1?.pluginCount).toBe(3);
      expect(byName.m2?.pluginCount).toBe(2);
      expect(byName.m1?.error).toBeUndefined();
      expect(byName.m2?.error).toBeUndefined();
    } finally {
      configMocks.marketplaces = {};
      rmSync(m1, { recursive: true, force: true });
      rmSync(m2, { recursive: true, force: true });
    }
  });
});
