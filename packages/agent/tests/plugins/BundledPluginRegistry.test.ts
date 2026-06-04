// packages/agent/tests/plugins/BundledPluginRegistry.test.ts
// Plan 101 — Phase 0: failing baseline tests pinning the post-Phase-1/2/4
// contract for the plugin runtime.
//
// Tests will fail against the current code because:
// - `registerBuiltinPlugin` / `getBuiltinPluginDefinition` / `listBuiltinPluginDefinitions`
//   do not exist yet (will be added in Phase 1).
// - `registerFromDirectory(dir)` does not exist yet (will be added in Phase 1).
// - `BundledAgentPlugin` does not yet have a `capabilities` field on the descriptor
//   shape returned by `registerFromDirectory` (will be added in Phase 1).
//
// All tests are pure: no global state mutation across tests, no shared
// file fixtures. We use the existing `packages/agent/src/plugins/builtin/literature`
// directory as the real on-disk fixture (it has `plugin.md` and
// `skills/paper-analysis.md` + `skills/citation-format.md`).

import { describe, it, expect, beforeEach } from 'vitest';
import { existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import {
  registerBuiltinPlugin,
  getBuiltinPluginDefinition,
  listBuiltinPluginDefinitions,
  registerFromDirectory,
  clearBuiltinDescriptorsCache,
  type BundledAgentPlugin,
  type BuiltinPluginDefinition,
} from '../../src/plugins/BundledPluginRegistry.js';
import { listBuiltinPlugins, clearBuiltinCache } from '../../src/plugins/builtin/_registry.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, '..', '..', '..', '..');
const LITERATURE_DIR = join(REPO_ROOT, 'packages', 'agent', 'src', 'plugins', 'builtin', 'literature');

describe('BundledPluginRegistry — builtins (Track B code-level API)', () => {
  beforeEach(() => {
    // Reset both caches between tests for isolation.
    clearBuiltinDescriptorsCache();
    clearBuiltinCache();
  });

  it('exposes the builtins under packages/agent/src/plugins/builtin/', () => {
    const builtins = listBuiltinPlugins();
    // The repo currently ships `literature` under builtin/.
    expect(builtins.find((b) => b.name === 'literature')).toBeDefined();
  });

  it('registerBuiltinPlugin round-trips a definition through getBuiltinPluginDefinition', () => {
    const def: BuiltinPluginDefinition = {
      name: 'unit-test-plugin',
      description: 'a test plugin',
      version: '0.0.1',
      defaultEnabled: true,
      isAvailable: () => true,
      skills: [],
      mcpServers: [],
      hooks: undefined,
    };
    registerBuiltinPlugin(def);

    const got = getBuiltinPluginDefinition('unit-test-plugin');
    expect(got).toBeDefined();
    expect(got?.description).toBe('a test plugin');
    expect(got?.isAvailable?.()).toBe(true);

    // Listing should now include the registered plugin.
    const all = listBuiltinPluginDefinitions();
    expect(all.find((d) => d.name === 'unit-test-plugin')).toBeDefined();
  });
});

describe('BundledPluginRegistry — registerFromDirectory (Track A)', () => {
  beforeEach(() => {
    clearBuiltinDescriptorsCache();
    clearBuiltinCache();
  });

  it('requires the directory to exist on disk', () => {
    expect(existsSync(LITERATURE_DIR)).toBe(true);
  });

  it('returns a non-empty BundledAgentPlugin descriptor for the literature directory', () => {
    const descriptor: BundledAgentPlugin = registerFromDirectory(LITERATURE_DIR);

    // Descriptor must carry enough information for the registry to:
    //  - show it in the UI (name)
    //  - register its capabilities
    expect(descriptor).toBeDefined();
    expect(descriptor.manifest.id).toBeTruthy();
    expect(descriptor.manifest.name).toBeTruthy();
    expect(typeof descriptor.createTools).toBe('function');

    // The literature fixture has 2 skill files (paper-analysis + citation-format).
    // We document the directory convention; this count must match the on-disk
    // fixture so any future drift breaks the test loudly.
    expect(descriptor.capabilities.skills.length).toBe(2);
  });
});
