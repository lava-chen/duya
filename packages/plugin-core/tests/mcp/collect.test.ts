// packages/plugin-core/tests/mcp/collect.test.ts
// Unit tests for the environment-agnostic MCP candidate collector.
import { describe, it, expect } from 'vitest';
import {
  buildMCPCandidates,
  type MCPCollectorInput,
} from '../../src/mcp/collect';

const baseInput: MCPCollectorInput = {
  installedPlugins: [],
};

describe('buildMCPCandidates', () => {
  it('produces no candidates from an empty input', () => {
    const r = buildMCPCandidates(baseInput);
    expect(r.candidates).toEqual([]);
    expect(r.issues).toEqual([]);
  });

  it('emits plugin candidates only for enabled plugins with mcpServers', () => {
    const r = buildMCPCandidates({
      ...baseInput,
      installedPlugins: [
        {
          id: 'p1', name: 'P1', enabled: true, installPath: '/p1',
          manifest: { capabilities: { mcpServers: [{ name: 'm1', command: 'node' }] } },
        },
        { id: 'p2', name: 'P2', enabled: false, installPath: '/p2' },
      ],
    });
    const plugins = r.candidates.filter((c) => c.source === 'plugin');
    expect(plugins).toHaveLength(1);
    expect(plugins[0].pluginId).toBe('p1');
  });

  it('filters out disabled settings entries from mcp.toml', () => {
    const r = buildMCPCandidates({
      ...baseInput,
      userTomlItems: [
        { name: 'on', command: 'node', enabled: true },
        { name: 'off', command: 'node', enabled: false },
      ],
    });
    const settings = r.candidates.filter((c) => c.source === 'settings');
    expect(settings.map((c) => c.rawConfig.name)).toEqual(['on']);
  });
});