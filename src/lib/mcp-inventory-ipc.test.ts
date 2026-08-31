import { describe, expect, it } from 'vitest';
import { adaptMCPInventorySnapshot } from './mcp-inventory-ipc';
import type { CapabilityManagementSnapshot } from './capability-management-types';

function makeSnapshot(capabilities: CapabilityManagementSnapshot['capabilities']): CapabilityManagementSnapshot {
  return {
    plugins: [],
    capabilities,
    generatedAt: 1,
    sources: {
      plugins: 'electron/plugins/PluginManager',
      skills: 'packages/agent/src/skills',
      mcp: 'electron/agents/mcp/collect-main',
      ui: 'plugin-manifest',
      hooks: 'plugin-manifest',
      cli: 'plugin-manifest',
    },
    unsupported: [],
  };
}

describe('adaptMCPInventorySnapshot', () => {
  it('deduplicates repeated declarations from the same plugin server', () => {
    const snapshot = makeSnapshot([
      { displayKey: 'first', kind: 'mcp', name: 'notion', origin: 'plugin', providerPluginId: 'plugin.notion', ownEnabled: true, providerEnabled: true, effectiveEnabled: true },
      { displayKey: 'duplicate', kind: 'mcp', name: 'notion', origin: 'plugin', providerPluginId: 'plugin.notion', ownEnabled: true, providerEnabled: true, effectiveEnabled: true },
    ]);

    const adapted = adaptMCPInventorySnapshot(snapshot);

    expect(adapted?.pluginDeclaredServers).toHaveLength(1);
    expect(adapted?.effectiveServers).toHaveLength(1);
    expect(adapted?.summary.pluginDeclaredCount).toBe(1);
  });

  it('passes live connectionStatus + tools through to effectiveServers', () => {
    const snapshot = makeSnapshot([
      {
        displayKey: 'fs',
        kind: 'mcp',
        name: 'fs',
        origin: 'settings',
        ownEnabled: true,
        providerEnabled: true,
        effectiveEnabled: true,
        mcp: {
          connectionStatus: 'connected',
          toolCount: 2,
          tools: [
            { name: 'list_directory', description: 'List a directory', annotations: { readOnly: true } },
            { name: 'delete_file', description: 'Delete a file', annotations: { destructive: true, openWorld: true } },
          ],
        },
      },
    ]);

    const adapted = adaptMCPInventorySnapshot(snapshot);
    const eff = adapted?.effectiveServers[0];
    expect(eff?.connectionStatus).toBe('connected');
    expect(eff?.connected).toBe(true);
    expect(eff?.tools).toHaveLength(2);
    expect(eff?.tools?.[0]).toEqual({
      name: 'list_directory',
      description: 'List a directory',
      annotations: { readOnly: true },
    });
    expect(eff?.tools?.[1].annotations?.destructive).toBe(true);
  });

  it('omits tools when the capability carries none', () => {
    const snapshot = makeSnapshot([
      {
        displayKey: 'notion',
        kind: 'mcp',
        name: 'notion',
        origin: 'plugin',
        providerPluginId: 'plugin.notion',
        ownEnabled: true,
        providerEnabled: true,
        effectiveEnabled: true,
        mcp: { connectionStatus: 'error' },
      },
    ]);

    const adapted = adaptMCPInventorySnapshot(snapshot);
    const eff = adapted?.effectiveServers[0];
    expect(eff?.connectionStatus).toBe('error');
    expect(eff?.connected).toBe(false);
    expect(eff?.tools).toBeUndefined();
  });

  it('drops malformed tool entries (missing name) and non-object annotations', () => {
    const snapshot = makeSnapshot([
      {
        displayKey: 's',
        kind: 'mcp',
        name: 's',
        origin: 'settings',
        ownEnabled: true,
        providerEnabled: true,
        effectiveEnabled: true,
        mcp: {
          connectionStatus: 'connected',
          tools: [
            { name: 'ok', description: 'fine' },
            { description: 'no name' },
            'junk',
            null,
          ] as unknown[] as never,
        },
      },
    ]);

    const adapted = adaptMCPInventorySnapshot(snapshot);
    expect(adapted?.effectiveServers[0]?.tools).toEqual([
      { name: 'ok', description: 'fine' },
    ]);
  });
});
