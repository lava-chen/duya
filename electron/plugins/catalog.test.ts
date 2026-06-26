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
    });
  });
});

