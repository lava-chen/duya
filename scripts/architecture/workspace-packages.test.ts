import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { loadWorkspacePackages } from './workspace-packages.mjs';

let fixtureRoot = '';

afterEach(() => {
  if (!fixtureRoot) return;
  fs.rmSync(fixtureRoot, { recursive: true, force: true });
  fixtureRoot = '';
});

describe('workspace package registry', () => {
  it('indexes packages by the name declared in their manifests', () => {
    fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'duya-workspace-packages-'));
    fs.mkdirSync(path.join(fixtureRoot, 'packages', 'manifest-name'), { recursive: true });
    fs.mkdirSync(path.join(fixtureRoot, 'packages', 'without-manifest'), { recursive: true });
    const manifest = {
      name: '@duya/registry-fixture',
      exports: { '.': './dist/index.js' },
    };
    fs.writeFileSync(
      path.join(fixtureRoot, 'packages', 'manifest-name', 'package.json'),
      JSON.stringify(manifest),
      'utf8',
    );

    const registry = loadWorkspacePackages(fixtureRoot);

    expect(registry.get('@duya/registry-fixture')).toEqual({
      dir: 'packages/manifest-name',
      manifest,
    });
    expect(registry.size).toBe(1);
  });
});
