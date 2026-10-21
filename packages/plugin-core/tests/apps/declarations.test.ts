import { describe, expect, it } from 'vitest';
import { PluginAppDefinitionsSchema } from '../../src/apps/declarations';

describe('PluginAppDefinitionsSchema', () => {
  const validApp = {
    appId: 'dashboard',
    entry: 'apps/dashboard/index.html',
    requiredCapabilities: ['mcp:dashboard.read'],
    stateSchemaVersion: 1,
  };

  it('accepts multiple unique app definitions and empty capability requests', () => {
    const parsed = PluginAppDefinitionsSchema.parse([
      validApp,
      {
        appId: 'reports',
        entry: 'apps/reports/index.html',
        requiredCapabilities: [],
        stateSchemaVersion: 2,
      },
    ]);

    expect(parsed).toHaveLength(2);
    expect(parsed[1]?.requiredCapabilities).toEqual([]);
  });

  it('rejects duplicate IDs, malformed identifiers, capability strings, and versions', () => {
    expect(() => PluginAppDefinitionsSchema.parse([validApp, validApp])).toThrow(/duplicate/i);
    expect(() =>
      PluginAppDefinitionsSchema.parse([{ ...validApp, appId: 'Bad ID' }]),
    ).toThrow(/appId/i);
    expect(() =>
      PluginAppDefinitionsSchema.parse([{ ...validApp, requiredCapabilities: ['bad id'] }]),
    ).toThrow(/requiredCapabilities/i);
    expect(() =>
      PluginAppDefinitionsSchema.parse([{ ...validApp, stateSchemaVersion: 0 }]),
    ).toThrow(/stateSchemaVersion/i);
  });

  it('rejects non-package-relative POSIX entries', () => {
    for (const entry of [
      '',
      '/apps/dashboard/index.html',
      'C:/apps/dashboard/index.html',
      '\\\\server\\share\\index.html',
      'https://example.com/app',
      'apps\\dashboard\\index.html',
      'apps//dashboard/index.html',
      './apps/dashboard/index.html',
      'apps/../outside.html',
      'apps/\u0000/index.html',
    ]) {
      expect(() =>
        PluginAppDefinitionsSchema.parse([{ ...validApp, entry }]),
      ).toThrow(/entry/i);
    }
  });
});
