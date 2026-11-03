import { describe, expect, it } from 'vitest';
import {
  PluginAppDefinitionsSchema,
  PluginUiSurfaceSchema,
  pluginAppDefinitionsSchemaForMcpServers,
  pluginAppCapabilityMappingExpands,
  pluginAppCapabilityTools,
} from '../../src/apps/declarations';

describe('PluginAppDefinitionsSchema', () => {
  const validApp = {
    appId: 'dashboard',
    entry: 'apps/dashboard/index.html',
    requiredCapabilities: ['mcp:dashboard.read'],
    stateSchemaVersion: 1,
  };
  const validSurface = {
    id: 'overview',
    title: { en: 'Overview', zh: '概览' },
    icon: 'chart-bar',
    server: 'dashboard',
    resourceUri: 'ui://dashboard/overview',
    availability: 'always' as const,
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

  it('accepts resource-only Apps while retaining static entry compatibility', () => {
    const parsed = PluginAppDefinitionsSchema.parse([
      {
        appId: 'resource-dashboard',
        ui: { surfaces: [validSurface] },
        requiredCapabilities: [],
        stateSchemaVersion: 1,
      },
      validApp,
    ]);

    expect(parsed[0]?.entry).toBeUndefined();
    expect(parsed[0]?.ui?.surfaces).toEqual([validSurface]);
    expect(parsed[1]?.entry).toBe(validApp.entry);
  });

  it('requires each App to declare a static entry, a surface, or a placement', () => {
    expect(() =>
      PluginAppDefinitionsSchema.parse([
        { appId: 'empty', requiredCapabilities: [], stateSchemaVersion: 1 },
      ]),
    ).toThrow(/static entry, a UI surface, or a placement/i);
  });

  it('accepts a placement-only UI block', () => {
    // A placement that opens the package entry needs no MCP surface at all:
    // that is the shape of a purely local App that wants a sidebar icon.
    const parsed = PluginAppDefinitionsSchema.parse([{
      appId: 'pinned',
      entry: 'apps/pinned/index.html',
      ui: { placements: [{ slot: 'sidebar.item', scope: 'session' }] },
      requiredCapabilities: [],
      stateSchemaVersion: 1,
    }]);

    expect(parsed[0]?.ui?.surfaces).toBeUndefined();
    expect(parsed[0]?.ui?.placements).toEqual([{ slot: 'sidebar.item', scope: 'session' }]);
  });

  it('rejects an unknown slot rather than accepting a dead entry', () => {
    // The slot set is a promise that something renders there. An unknown slot
    // must fail at install time, not silently never appear.
    expect(() =>
      PluginAppDefinitionsSchema.parse([{
        appId: 'future',
        entry: 'apps/future/index.html',
        ui: { placements: [{ slot: 'project.tab', scope: 'session' }] },
        requiredCapabilities: [],
        stateSchemaVersion: 1,
      }]),
    ).toThrow(/slot/i);
  });

  it('rejects a placement without a surface when the App has no entry', () => {
    expect(() =>
      PluginAppDefinitionsSchema.parse([{
        appId: 'dangling',
        ui: { placements: [{ slot: 'sidebar.item', scope: 'global' }] },
        requiredCapabilities: [],
        stateSchemaVersion: 1,
      }]),
    ).toThrow(/static entry/i);
  });

  it('rejects a placement that names a surface the App does not declare', () => {
    expect(() =>
      PluginAppDefinitionsSchema.parse([{
        appId: 'typo',
        entry: 'apps/typo/index.html',
        ui: {
          surfaces: [validSurface],
          placements: [{ slot: 'sidebar.item', scope: 'session', surface: 'overveiw' }],
        },
        requiredCapabilities: [],
        stateSchemaVersion: 1,
      }]),
    ).toThrow(/unknown surface/i);
  });

  it('accepts a placement that names one of the App surfaces', () => {
    const parsed = PluginAppDefinitionsSchema.parse([{
      appId: 'placed',
      ui: {
        surfaces: [validSurface],
        placements: [{ slot: 'session.panel', scope: 'global', surface: 'overview' }],
      },
      requiredCapabilities: [],
      stateSchemaVersion: 1,
    }]);

    expect(parsed[0]?.ui?.placements?.[0]?.surface).toBe('overview');
  });

  it('rejects an empty ui block', () => {
    expect(() =>
      PluginAppDefinitionsSchema.parse([{
        appId: 'empty-ui',
        entry: 'apps/empty-ui/index.html',
        ui: {},
        requiredCapabilities: [],
        stateSchemaVersion: 1,
      }]),
    ).toThrow(/surfaces or placements/i);
  });

  it('rejects unknown fields on a placement', () => {
    expect(() =>
      PluginAppDefinitionsSchema.parse([{
        appId: 'loose',
        entry: 'apps/loose/index.html',
        ui: { placements: [{ slot: 'sidebar.item', scope: 'session', order: 1 }] },
        requiredCapabilities: [],
        stateSchemaVersion: 1,
      }]),
    ).toThrow(/order/i);
  });

  it('validates surface fields and requires a ui:// resource URI', () => {
    expect(PluginUiSurfaceSchema.parse(validSurface)).toEqual(validSurface);
    for (const resourceUri of ['https://example.com/view', 'ui://', 'ui:// bad/path']) {
      expect(() => PluginUiSurfaceSchema.parse({ ...validSurface, resourceUri })).toThrow(/resourceUri/i);
    }
    expect(() =>
      PluginUiSurfaceSchema.parse({ ...validSurface, title: { en: 'Overview' } }),
    ).toThrow(/title/i);
  });

  it('rejects duplicate surface IDs anywhere in one plugin', () => {
    expect(() =>
      PluginAppDefinitionsSchema.parse([
        { ...validApp, ui: { surfaces: [validSurface] } },
        {
          ...validApp,
          appId: 'reports',
          ui: { surfaces: [{ ...validSurface, server: 'reports' }] },
        },
      ]),
    ).toThrow(/duplicate UI surface id/i);
  });

  it('binds surface server references to the plugin MCP server list', () => {
    const definitions = [
      { ...validApp, ui: { surfaces: [validSurface] } },
    ];
    expect(() => pluginAppDefinitionsSchemaForMcpServers(['dashboard']).parse(definitions)).not.toThrow();
    expect(() => pluginAppDefinitionsSchemaForMcpServers(['reports']).parse(definitions)).toThrow(
      /server dashboard is not declared.*mcpServers/i,
    );
  });

  describe('capability tool mappings', () => {
    it('accepts a mapping that names only requested capabilities', () => {
      const parsed = PluginAppDefinitionsSchema.parse([
        {
          ...validApp,
          capabilityTools: [
            { capability: 'mcp:dashboard.read', tools: [{ serverName: 'dashboard', toolName: 'read' }] },
          ],
        },
      ]);

      expect(parsed[0]?.capabilityTools?.[0]?.tools).toEqual([
        { serverName: 'dashboard', toolName: 'read' },
      ]);
    });

    it('rejects a mapping for a capability the App never requested', () => {
      expect(() =>
        PluginAppDefinitionsSchema.parse([
          {
            ...validApp,
            capabilityTools: [
              { capability: 'mcp:other.write', tools: [{ serverName: 'other', toolName: 'write' }] },
            ],
          },
        ]),
      ).toThrow(/not requested/i);
    });

    it('rejects a duplicated capability mapping', () => {
      expect(() =>
        PluginAppDefinitionsSchema.parse([
          {
            ...validApp,
            capabilityTools: [
              { capability: 'mcp:dashboard.read', tools: [] },
              { capability: 'mcp:dashboard.read', tools: [] },
            ],
          },
        ]),
      ).toThrow(/duplicate capability mapping/i);
    });

    it('rejects one tool claimed by two capabilities', () => {
      expect(() =>
        PluginAppDefinitionsSchema.parse([
          {
            ...validApp,
            requiredCapabilities: ['mcp:dashboard.read', 'mcp:dashboard.write'],
            capabilityTools: [
              { capability: 'mcp:dashboard.read', tools: [{ serverName: 'dashboard', toolName: 'read' }] },
              { capability: 'mcp:dashboard.write', tools: [{ serverName: 'dashboard', toolName: 'read' }] },
            ],
          },
        ]),
      ).toThrow(/mapped by both/i);
    });

    it('reads the mapped tools in a stable order', () => {
      const app = {
        ...validApp,
        capabilityTools: [
          {
            capability: 'mcp:dashboard.read',
            tools: [
              { serverName: 'dashboard', toolName: 'write' },
              { serverName: 'dashboard', toolName: 'read' },
            ],
          },
        ],
      };

      expect(pluginAppCapabilityTools(app, 'mcp:dashboard.read')).toEqual([
        { serverName: 'dashboard', toolName: 'read' },
        { serverName: 'dashboard', toolName: 'write' },
      ]);
      expect(pluginAppCapabilityTools(app, 'mcp:absent')).toBeNull();
    });

    it('reports a widened mapping but not a narrowed one', () => {
      const app = {
        ...validApp,
        capabilityTools: [
          {
            capability: 'mcp:dashboard.read',
            tools: [
              { serverName: 'dashboard', toolName: 'read' },
              { serverName: 'dashboard', toolName: 'export' },
            ],
          },
        ],
      };

      expect(
        pluginAppCapabilityMappingExpands(app, 'mcp:dashboard.read', [
          { serverName: 'dashboard', toolName: 'read' },
        ]),
      ).toBe(true);
      expect(
        pluginAppCapabilityMappingExpands(app, 'mcp:dashboard.read', [
          { serverName: 'dashboard', toolName: 'read' },
          { serverName: 'dashboard', toolName: 'export' },
        ]),
      ).toBe(false);
      expect(
        pluginAppCapabilityMappingExpands(app, 'mcp:dashboard.read', [
          { serverName: 'dashboard', toolName: 'read' },
          { serverName: 'dashboard', toolName: 'export' },
          { serverName: 'dashboard', toolName: 'archive' },
        ]),
      ).toBe(false);
    });
  });
});
