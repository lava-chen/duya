// packages/agent/tests/plugins/BundledPluginRegistry.test.ts
// Plan 101 — Phase 0: baseline tests pinning the post-Phase-1/2/4
// contract for the plugin runtime.
//
// Tests are pure: no global state mutation across tests, no shared
// file fixtures. We use the existing `packages/agent/src/plugins/builtin/literature`
// directory as the real on-disk fixture (it has `plugin.md` and
// `skills/paper-analysis/SKILL.md` + `skills/citation-format/SKILL.md`).

import { describe, it, expect, beforeEach } from 'vitest';
import { existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import {
  registerFromDirectory,
  clearBuiltinDescriptorsCache,
  type BundledAgentPlugin,
} from '../../src/plugins/BundledPluginRegistry.js';
import { listBuiltinPlugins, clearBuiltinCache } from '../../src/plugins/builtin/_registry.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, '..', '..', '..', '..');
const LITERATURE_DIR = join(REPO_ROOT, 'packages', 'agent', 'src', 'plugins', 'builtin', 'literature');

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

    expect(descriptor).toBeDefined();
    expect(descriptor.manifest.id).toBeTruthy();
    expect(descriptor.manifest.name).toBeTruthy();
    expect(typeof descriptor.createTools).toBe('function');

    // The literature fixture has 2 skill directories (paper-analysis + citation-format).
    expect(descriptor.capabilities.skills.length).toBe(2);
  });
});
