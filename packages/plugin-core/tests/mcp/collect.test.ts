// packages/plugin-core/tests/mcp/collect.test.ts
// Unit tests for the environment-agnostic MCP candidate collector.
import { describe, it, expect } from 'vitest';
import {
  buildMCPCandidates,
  buildBundledLiteratureCandidate,
  readLegacyFileMcpServers,
  type MCPCollectorInput,
} from '../../src/mcp/collect';

const baseInput: MCPCollectorInput = {
  installedPlugins: [],
  legacyFileItems: [],
  agentSettingsMcpServers: [],
  settingsKvMcpServers: [],
  environment: {},
  cwd: '/cwd',
};

describe('buildMCPCandidates', () => {
  it('always emits the bundled literature candidate', () => {
    const r = buildMCPCandidates(baseInput);
    const bundled = r.candidates.find((c) => c.source === 'bundled');
    expect(bundled).toBeDefined();
    expect(bundled!.rawConfig.args[0]).toContain('literature-mcp-server.js');
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

  it('filters out disabled settings entries', () => {
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

  it('feeds the legacyFile / agentSettings / settingsKv settings sources', () => {
    const r = buildMCPCandidates({
      ...baseInput,
      legacyFileItems: [{ name: 'legacy', command: 'node' }],
      agentSettingsMcpServers: [{ name: 'agent', command: 'node' }],
      settingsKvMcpServers: [{ name: 'kv', command: 'node' }],
    });
    const subOrigins = r.candidates
      .filter((c) => c.source === 'settings')
      .map((c) => c.sourceSubOrigin)
      .sort();
    expect(subOrigins).toEqual(['agentSettings', 'legacyFile', 'settingsKv']);
  });
});

describe('buildBundledLiteratureCandidate', () => {
  it('always returns a candidate even when the bundle does not exist', () => {
    const r = buildBundledLiteratureCandidate('/cwd', {});
    expect(r.source).toBe('bundled');
    expect(r.rawConfig.name).toBe('literature');
    expect(r.rawConfig.args[0]).toContain('literature-mcp-server.js');
    expect(r.rawConfig.env?.ELECTRON_RUN_AS_NODE).toBe('1');
  });

  it('uses the packaged resources path when packaged', () => {
    const r = buildBundledLiteratureCandidate('/cwd', {}, true, '/resources');
    expect(r.rawConfig.args[0]).toContain('resources');
    expect(r.rawConfig.args[0]).toContain('agent-bundle');
  });

  it('uses the dev bundle path when not packaged', () => {
    const r = buildBundledLiteratureCandidate('/repo', {}, false, '/resources');
    expect(r.rawConfig.args[0]).toContain('repo');
    expect(r.rawConfig.args[0]).toContain('packages');
    expect(r.rawConfig.args[0]).toContain('bundle');
  });
});

describe('readLegacyFileMcpServers', () => {
  it('returns empty for null path', async () => {
    const r = await readLegacyFileMcpServers(null);
    expect(r.items).toEqual([]);
    expect(r.issues).toEqual([]);
  });

  it('returns empty for a missing file (ENOENT)', async () => {
    const r = await readLegacyFileMcpServers('/no/such/file.json');
    expect(r.items).toEqual([]);
    expect(r.issues).toEqual([]);
  });
});