// electron/plugins/catalog.test.ts
// Plan: plugin-config-simplification — tests for the disk-reading catalog.
//
// Self-contained tests using temp fixture plugins. No dependency on the
// real builtin plugin source tree (plugins were moved to duya-marketplace).

import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync } from 'fs';
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

// Mock builtin-sync to return the fixture roots
vi.mock('./cache/builtin-sync', () => ({
  listBuiltinCacheRoots: () => state.fixtureRoots,
  getBuiltinCacheRoot: () => state.tempRoot,
  syncBuiltinPlugins: () => state.fixtureRoots,
  listBuiltinCachePlugins: () => state.fixtureRoots.map((root) => ({
    id: `com.duya.${FIXTURE_PLUGINS.find((p) => root.endsWith(p.name))?.name ?? 'unknown'}`,
    name: FIXTURE_PLUGINS.find((p) => root.endsWith(p.name))?.name ?? 'unknown',
    root,
  })),
}));

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
// getPluginCatalog — disk-reading scanner
// ----------------------------------------------------------------------------

describe('getPluginCatalog — builtin entries from disk', () => {
  beforeAll(() => {
    expect(state.fixtureRoots.length).toBeGreaterThanOrEqual(2);
  });

  it('includes all fixture builtin plugins', async () => {
    const { getPluginCatalog } = await import('./catalog.js');
    const catalog = getPluginCatalog();
    const builtinEntries = catalog.filter((e) => e.source === 'bundled' && e.kind !== 'skill');

    const ids = builtinEntries.map((e) => e.id).sort();
    expect(ids).toEqual(['com.duya.test-data', 'com.duya.test-research']);
  });

  it('every builtin entry is official-trust with builtinCacheDir', async () => {
    const { getPluginCatalog } = await import('./catalog.js');
    const catalog = getPluginCatalog();
    const builtinEntries = catalog.filter((e) => e.source === 'bundled' && e.kind !== 'skill');

    for (const entry of builtinEntries) {
      expect(entry.trustLevel).toBe('official');
      expect(entry.builtinCacheDir).toBeDefined();
      expect(existsSync(entry.builtinCacheDir!)).toBe(true);
    }
  });

  it('no duplicate ids in the catalog', async () => {
    const { getPluginCatalog } = await import('./catalog.js');
    const catalog = getPluginCatalog();
    const ids = catalog.map((e) => e.id);
    const unique = new Set(ids);
    expect(unique.size).toBe(ids.length);
  });

  it('derives category from interface.category for each builtin entry', async () => {
    const { getPluginCatalog } = await import('./catalog.js');
    const catalog = getPluginCatalog();
    const byId = new Map(catalog.map((e) => [e.id, e]));

    expect(byId.get('com.duya.test-research')?.category).toBe('research');
    expect(byId.get('com.duya.test-data')?.category).toBe('data');
  });

  it('derives capability counts from disk for each builtin entry', async () => {
    const { getPluginCatalog } = await import('./catalog.js');
    const catalog = getPluginCatalog();
    const byId = new Map(catalog.map((e) => [e.id, e]));

    const research = byId.get('com.duya.test-research');
    expect(research?.capabilityCounts).toEqual({
      skills: 2, mcpServers: 1, cli: 0, ui: 0, hooks: 0, workflows: 1,
    });

    const data = byId.get('com.duya.test-data');
    expect(data?.capabilityCounts).toEqual({
      skills: 3, mcpServers: 1, cli: 0, ui: 0, hooks: 0, workflows: 0,
    });
  });

  it('resolves setup fields from the minimal plugin.json', async () => {
    const { getPluginCatalog } = await import('./catalog.js');
    const catalog = getPluginCatalog();
    const byId = new Map(catalog.map((e) => [e.id, e]));

    const data = byId.get('com.duya.test-data');
    expect(data?.manifest.setup).toEqual([
      expect.objectContaining({
        id: 'connectionString',
        type: 'secret',
        required: true,
      }),
    ]);

    const research = byId.get('com.duya.test-research');
    expect(research?.manifest.setup).toBeUndefined();
  });

  it('resolves MCP server config from mcp/servers.json', async () => {
    const { getPluginCatalog } = await import('./catalog.js');
    const catalog = getPluginCatalog();
    const byId = new Map(catalog.map((e) => [e.id, e]));

    const research = byId.get('com.duya.test-research');
    const server = research?.manifest.capabilities.mcpServers?.[0];
    expect(server?.name).toBe('test-research-mcp');
    expect(server?.command).toBe('node');
  });
});
