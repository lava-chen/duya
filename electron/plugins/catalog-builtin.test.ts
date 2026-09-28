// electron/plugins/catalog-builtin.test.ts
// Plan 455 follow-up — builtin cache catalog entries. Verifies that plugins
// shipped in `~/.duya/plugins/cache/builtin/<id>/<version>/` produce catalog
// entries with a resolvable manifest, so registry entries under the `builtin`
// marketplace can hydrate (composer @ list, Extensions, health).

import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import { mkdirSync, writeFileSync, rmSync, mkdtempSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

vi.mock('electron', () => ({
  app: {
    isPackaged: false,
    getPath: () => '/tmp/duya-test',
    getAppPath: () => process.cwd(),
  },
}));

const state = vi.hoisted(() => ({ root: '' as string }));

function buildBuiltinFixture(
  id: string,
  version: string,
  name: string,
  opts: { withAppConnection?: boolean } = {},
): void {
  const pluginDir = join(state.root, id, version);
  mkdirSync(join(pluginDir, '.duya-plugin'), { recursive: true });
  writeFileSync(
    join(pluginDir, '.duya-plugin', 'plugin.json'),
    JSON.stringify(
      {
        name,
        version,
        description: `${name} builtin plugin`,
        author: { name: 'DUYA Team' },
        license: 'MIT',
        interface: { displayName: name, category: 'productivity' },
      },
      null,
      2,
    ),
  );
  // A skill so capabilityCounts is non-zero on disk.
  mkdirSync(join(pluginDir, 'skills', 'setup'), { recursive: true });
  writeFileSync(join(pluginDir, 'skills', 'setup', 'SKILL.md'), `# ${name} setup\n`);
  mkdirSync(join(pluginDir, 'permissions'), { recursive: true });
  writeFileSync(
    join(pluginDir, 'permissions', 'policy.json'),
    JSON.stringify({ defaultMode: 'workspace', permissions: [] }, null, 2),
  );
  // A required app connection → the install dialog must gate on OAuth
  // (authPolicy derives from the declaration for builtin entries).
  if (opts.withAppConnection) {
    mkdirSync(join(pluginDir, 'apps'), { recursive: true });
    writeFileSync(
      join(pluginDir, 'apps', 'connections.json'),
      JSON.stringify(
        [{ id: name, provider: name, scopes: [], toolsets: [], required: true }],
        null,
        2,
      ),
    );
  }
}

describe('getBuiltinCatalogEntries — builtin cache scan', () => {
  beforeAll(() => {
    state.root = mkdtempSync(join(tmpdir(), 'duya-builtin-test-'));
    buildBuiltinFixture('github', '0.1.0', 'github', { withAppConnection: true });
    buildBuiltinFixture('documents', '0.1.0', 'documents');
    // A second version of the same plugin — scanner must pick one deterministically.
    buildBuiltinFixture('github', '0.2.0', 'github', { withAppConnection: true });
  });

  afterAll(() => {
    if (state.root) rmSync(state.root, { recursive: true, force: true });
  });

  it('surfaces builtin cache plugins with a resolvable manifest', async () => {
    const { getBuiltinCatalogEntries } = await import('./catalog.js');
    const entries = getBuiltinCatalogEntries(state.root);
    const github = entries.find((e) => e.id === 'com.duya.github');
    const documents = entries.find((e) => e.id === 'com.duya.documents');

    expect(github).toBeDefined();
    expect(github!.source).toBe('builtin-directory');
    expect(github!.manifest).toBeDefined();
    expect(github!.manifest!.name).toBe('github');
    // Skill dir on disk → capability counts pick it up.
    expect(github!.capabilityCounts.skills).toBeGreaterThanOrEqual(1);
    // Highest version wins.
    expect(github!.version).toBe('0.2.0');
    // The entry carries its on-disk copy so install copies the full dir
    // (assets/skills) instead of falling back to a manifest-only install.
    expect(github!.marketplacePluginDir).toBe(join(state.root, 'github', '0.2.0'));
    // Required app connection → install dialog runs the OAuth connect step.
    expect(github!.authPolicy).toBe('on_install');
    // No app declaration → no install-time auth gate.
    expect(documents!.authPolicy).toBeUndefined();

    expect(documents).toBeDefined();
    expect(documents!.manifest).toBeDefined();
    expect(documents!.version).toBe('0.1.0');
  });

  it('returns [] for a missing cache root', async () => {
    const { getBuiltinCatalogEntries } = await import('./catalog.js');
    const entries = getBuiltinCatalogEntries(join(state.root, 'does-not-exist'));
    expect(entries).toEqual([]);
  });
});
