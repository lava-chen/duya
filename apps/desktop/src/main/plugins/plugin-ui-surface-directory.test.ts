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

  it('projects placement entries from enabled plugins only', () => {
    const result = buildPluginUiSurfaceDirectory([
      {
        id: 'plugin-a',
        name: 'Plugin A',
        enabled: true,
        apps: [{
          appId: 'board',
          ui: {
            surfaces: [surface('board-view')],
            placements: [{ slot: 'sidebar.item' as const, scope: 'session' as const, surface: 'board-view' }],
          },
        }],
      },
      {
        id: 'plugin-b',
        name: 'Plugin B',
        enabled: false,
        apps: [{
          appId: 'hidden',
          ui: { placements: [{ slot: 'sidebar.item' as const, scope: 'global' as const }] },
        }],
      },
    ]);

    expect(result.placements).toEqual([{
      pluginId: 'plugin-a',
      pluginName: 'Plugin A',
      appId: 'board',
      slot: 'sidebar.item',
      scope: 'session',
      surfaceId: 'board-view',
      server: 'app',
      availability: 'always',
      title: { en: 'board-view', zh: 'board-view' },
      icon: 'panel',
    }]);
  });

  it('gives an entry-only placement the App id as its title and a default icon', () => {
    const result = buildPluginUiSurfaceDirectory([{
      id: 'plugin-a',
      name: 'Plugin A',
      enabled: true,
      apps: [{
        appId: 'scratchpad',
        runtime: 'standalone' as const,
        ui: { placements: [{ slot: 'session.panel' as const, scope: 'global' as const }] },
      }],
    }]);

    expect(result.placements[0]).toMatchObject({
      appId: 'scratchpad',
      title: { en: 'scratchpad', zh: 'scratchpad' },
      icon: 'plug',
      availability: 'always',
    });
    expect(result.placements[0]?.surfaceId).toBeUndefined();
    expect(result.placements[0]?.server).toBeUndefined();
  });

  it('drops a placement that names a surface the App does not declare', () => {
    // The schema rejects this at install time; the directory still has to be
    // total, because a registry written by an older build can reach it.
    const result = buildPluginUiSurfaceDirectory([{
      id: 'plugin-a',
      name: 'Plugin A',
      enabled: true,
      apps: [{
        appId: 'board',
        ui: {
          surfaces: [surface('board-view')],
          placements: [{ slot: 'sidebar.item' as const, scope: 'session' as const, surface: 'gone' }],
        },
      }],
    }]);

    expect(result.placements).toEqual([]);
  });

  it('orders placements by slot, then by owner', () => {
    const result = buildPluginUiSurfaceDirectory([
      {
        id: 'plugin-b',
        name: 'B',
        enabled: true,
        apps: [{ appId: 'b', ui: { placements: [{ slot: 'session.panel' as const, scope: 'global' as const }] } }],
      },
      {
        id: 'plugin-a',
        name: 'A',
        enabled: true,
        apps: [
          { appId: 'z', ui: { placements: [{ slot: 'sidebar.item' as const, scope: 'global' as const }] } },
          { appId: 'a', ui: { placements: [{ slot: 'sidebar.item' as const, scope: 'global' as const }] } },
        ],
      },
    ]);

    expect(result.placements.map((entry) => `${entry.slot}:${entry.pluginId}:${entry.appId}`)).toEqual([
      'sidebar.item:plugin-a:a',
      'sidebar.item:plugin-a:z',
      'session.panel:plugin-b:b',
    ]);
  });
});
