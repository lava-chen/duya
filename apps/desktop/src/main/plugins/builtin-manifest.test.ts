// apps/desktop/src/main/plugins/builtin-manifest.test.ts
// Builtin plugin distribution — manifest parsing rules.
//
// The manifest is written by hand in the marketplace repo and shipped inside
// the installer, so every rule here is a rule the runtime has to survive: a
// broken manifest must degrade, never crash the app.

import { describe, it, expect } from 'vitest';
import { parseBuiltinManifest, isContainedPath } from './builtin-manifest';

function manifestWith(plugins: unknown): string {
  return JSON.stringify({ version: 1, plugins });
}

describe('parseBuiltinManifest', () => {
  it('accepts a well-formed manifest', () => {
    const result = parseBuiltinManifest(
      manifestWith([
        {
          name: 'computer-use',
          path: './plugins/computer-use',
          description: 'Control the desktop.',
          requiredPaths: ['.duya-plugin/plugin.json'],
          defaultEnabled: false,
        },
      ]),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.manifest.version).toBe(1);
    expect(result.manifest.plugins).toHaveLength(1);
    expect(result.manifest.plugins[0]).toMatchObject({
      name: 'computer-use',
      path: './plugins/computer-use',
      requiredPaths: ['.duya-plugin/plugin.json'],
      defaultEnabled: false,
    });
  });

  it('tolerates a UTF-8 BOM left by a Windows editor', () => {
    const result = parseBuiltinManifest(`﻿${manifestWith([])}`);
    expect(result.ok).toBe(true);
  });

  it('rejects a broken manifest instead of throwing', () => {
    expect(parseBuiltinManifest('{ not json').ok).toBe(false);
    expect(parseBuiltinManifest('[]').ok).toBe(false);
    expect(parseBuiltinManifest(JSON.stringify({ plugins: [] })).ok).toBe(false);
    expect(parseBuiltinManifest(JSON.stringify({ version: 0, plugins: [] })).ok).toBe(false);
    expect(parseBuiltinManifest(JSON.stringify({ version: 1 })).ok).toBe(false);
    expect(parseBuiltinManifest(manifestWith([{ path: './x' }])).ok).toBe(false);
    expect(parseBuiltinManifest(manifestWith([{ name: 'x' }])).ok).toBe(false);
  });

  it('rejects a plugin name that is not a plain directory name', () => {
    expect(parseBuiltinManifest(manifestWith([{ name: '../escape', path: './x' }])).ok).toBe(false);
    expect(parseBuiltinManifest(manifestWith([{ name: 'a/b', path: './x' }])).ok).toBe(false);
    expect(parseBuiltinManifest(manifestWith([{ name: '.hidden', path: './x' }])).ok).toBe(false);
  });

  it('rejects duplicate plugin names', () => {
    const result = parseBuiltinManifest(
      manifestWith([
        { name: 'x', path: './plugins/x' },
        { name: 'x', path: './plugins/y' },
      ]),
    );
    expect(result.ok).toBe(false);
  });

  it('rejects a wrong type for defaultEnabled', () => {
    const result = parseBuiltinManifest(
      manifestWith([{ name: 'x', path: './plugins/x', defaultEnabled: 'yes' }]),
    );
    expect(result.ok).toBe(false);
  });
});

describe('isContainedPath', () => {
  it('accepts a path inside the root', () => {
    expect(isContainedPath('/repo', './plugins/computer-use')).toBe(true);
    expect(isContainedPath('/repo', 'plugins/computer-use')).toBe(true);
  });

  it('refuses a path that escapes the root', () => {
    expect(isContainedPath('/repo', '../escape')).toBe(false);
    expect(isContainedPath('/repo', './a/../../escape')).toBe(false);
    expect(isContainedPath('/repo', '/etc/passwd')).toBe(false);
    expect(isContainedPath('/repo', '')).toBe(false);
  });
});
