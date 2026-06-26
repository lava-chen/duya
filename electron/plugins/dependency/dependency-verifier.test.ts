import { describe, it, expect } from 'vitest';
import {
  verifyAndDemote,
  checkUninstallDependents,
  detectCircularDependency,
  getAllDependenciesForPlugin,
} from './dependency-verifier';
import type { InstalledPluginsFileV2, PluginDependency } from '../types';

function makeInstalled(
  plugins: Record<string, { version: string }>
): InstalledPluginsFileV2 {
  const result: InstalledPluginsFileV2 = {
    version: 2,
    plugins: {},
  };
  for (const [name, info] of Object.entries(plugins)) {
    result.plugins[name] = {
      marketplace: 'builtin',
      version: info.version,
      scope: 'builtin',
      installPath: `/cache/builtin/${name}/${info.version}`,
      capabilities: [],
      autoUpdate: false,
    };
  }
  return result;
}

describe('verifyAndDemote', () => {
  it('returns satisfied when all dependencies are met', () => {
    const installed = makeInstalled({
      depA: { version: '1.0.0' },
      depB: { version: '2.0.0' },
    });

    const deps: PluginDependency[] = [
      { name: 'depA', version: '>=1.0.0' },
      { name: 'depB', version: '2.0.0' },
    ];

    const result = verifyAndDemote('test-plugin', deps, installed);
    expect(result.satisfied).toBe(true);
    expect(result.missing).toHaveLength(0);
    expect(result.downgraded).toHaveLength(0);
  });

  it('returns missing when dependency is not installed', () => {
    const installed = makeInstalled({});

    const deps: PluginDependency[] = [
      { name: 'depA', version: '1.0.0' },
    ];

    const result = verifyAndDemote('test-plugin', deps, installed);
    expect(result.satisfied).toBe(false);
    expect(result.missing).toHaveLength(1);
    expect(result.missing[0].name).toBe('depA');
  });

  it('returns downgraded when version does not satisfy', () => {
    const installed = makeInstalled({
      depA: { version: '1.0.0' },
    });

    const deps: PluginDependency[] = [
      { name: 'depA', version: '^2.0.0' },
    ];

    const result = verifyAndDemote('test-plugin', deps, installed);
    expect(result.satisfied).toBe(false);
    expect(result.downgraded).toHaveLength(1);
    expect(result.downgraded[0]).toContain('depA');
  });

  it('handles wildcard version requirement', () => {
    const installed = makeInstalled({
      depA: { version: '1.0.0' },
    });

    const deps: PluginDependency[] = [
      { name: 'depA', version: '*' },
    ];

    const result = verifyAndDemote('test-plugin', deps, installed);
    expect(result.satisfied).toBe(true);
  });

  it('handles empty deps', () => {
    const installed = makeInstalled({});
    const result = verifyAndDemote('test-plugin', [], installed);
    expect(result.satisfied).toBe(true);
    expect(result.missing).toHaveLength(0);
    expect(result.downgraded).toHaveLength(0);
  });
});

describe('checkUninstallDependents', () => {
  it('returns empty when no dependents', () => {
    const installed = makeInstalled({});
    const result = checkUninstallDependents('plugin-A', installed);
    expect(result).toHaveLength(0);
  });
});

describe('detectCircularDependency', () => {
  it('returns null for non-circular dependencies', () => {
    const installed = makeInstalled({});
    const deps: PluginDependency[] = [
      { name: 'depA', version: '1.0.0' },
    ];
    const result = detectCircularDependency('plugin-test', deps, installed);
    expect(result).toBeNull();
  });
});