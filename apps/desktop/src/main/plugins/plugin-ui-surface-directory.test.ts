import { describe, expect, it } from 'vitest';
import { buildPluginUiSurfaceDirectory } from './plugin-ui-surface-directory';

const surface = (id: string, uri = `ui://example/${id}`) => ({
  id,
  title: { en: id, zh: id },
  icon: 'panel',
  server: 'app',
  resourceUri: uri,
  availability: 'always' as const,
});

describe('buildPluginUiSurfaceDirectory', () => {
  it('projects only enabled plugin surfaces with their app and plugin identities', () => {
    const result = buildPluginUiSurfaceDirectory([
      {
        id: 'plugin-b',
        name: 'Plugin B',
        enabled: true,
        apps: [{ appId: 'viewer', ui: { surfaces: [surface('z-view'), surface('a-view')] } }],
      },
      {
        id: 'plugin-a',
        name: 'Plugin A',
        enabled: false,
        apps: [{ appId: 'viewer', ui: { surfaces: [surface('hidden')] } }],
      },
    ]);

    expect(result.surfaces.map(({ id, pluginId, appId }) => ({ id, pluginId, appId }))).toEqual([
      { id: 'a-view', pluginId: 'plugin-b', appId: 'viewer' },
      { id: 'z-view', pluginId: 'plugin-b', appId: 'viewer' },
    ]);
    expect(result.conflicts).toEqual([]);
  });

  it('excludes a surface id claimed by multiple installed plugins', () => {
    const result = buildPluginUiSurfaceDirectory([
      {
        id: 'plugin-a',
        name: 'Plugin A',
        enabled: true,
        apps: [{ appId: 'editor', ui: { surfaces: [surface('shared')] } }],
      },
      {
        id: 'plugin-b',
        name: 'Plugin B',
        enabled: false,
        apps: [{ appId: 'viewer', ui: { surfaces: [surface('shared')] } }],
      },
      {
        id: 'plugin-c',
        name: 'Plugin C',
        enabled: true,
        apps: [{ appId: 'dashboard', ui: { surfaces: [surface('other')] } }],
      },
    ]);

    expect(result.surfaces.map(({ id }) => id)).toEqual(['other']);
    expect(result.conflicts).toEqual([
      {
        id: 'shared',
        owners: [
          { pluginId: 'plugin-a', pluginName: 'Plugin A', appId: 'editor' },
          { pluginId: 'plugin-b', pluginName: 'Plugin B', appId: 'viewer' },
        ],
      },
    ]);
  });
});
