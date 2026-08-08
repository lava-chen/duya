// packages/agent/tests/mcp/collect-worker.test.ts
// Unit tests for the worker-side MCP candidate collector.
//
// The pure transforms now live in @duya/plugin-core/src/mcp/collect.ts
// and are exercised here against the shared engine (`buildMCPCandidates`
// and friends). The async wrapper `collectWorkerMCPCandidates` is
// exercised separately with a minimal mock of the db-client shape.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  buildCandidatesFromPluginEntry,
  buildCandidatesFromSettingsEntries,
  buildMCPCandidates,
  type MCPCollectorPluginEntry,
  type MCPCollectorInput,
} from '@duya/plugin-core/src/mcp/collect.js';
import { collectWorkerMCPCandidates } from '../../src/mcp/collect-worker.js';
import type { MCPConfigItem } from '../../src/mcp/config.js';

const emptyWorkerInput: MCPCollectorInput = {
  installedPlugins: [],
};

// ============================================================================
// Per-source pure helpers (shared engine)
// ============================================================================

describe('buildCandidatesFromPluginEntry', () => {
  it('returns an empty array for a disabled plugin', () => {
    const entry: MCPCollectorPluginEntry = {
      id: 'p', name: 'P', enabled: false, installPath: '/p',
      manifest: { capabilities: { mcpServers: [{ name: 'x', command: 'node', args: [] }] } },
    };
    expect(buildCandidatesFromPluginEntry(entry)).toEqual([]);
  });

  it('returns an empty array when manifest is missing', () => {
    const entry: MCPCollectorPluginEntry = {
      id: 'p', name: 'P', enabled: true, installPath: '/p',
    };
    expect(buildCandidatesFromPluginEntry(entry)).toEqual([]);
  });

  it('builds a candidate with pluginId, pluginName, pluginRoot, pluginDataPath', () => {
    const entry: MCPCollectorPluginEntry = {
      id: 'com.duya.literature',
      name: 'Literature Plugin',
      enabled: true,
      installPath: '/plugins/lit',
      dataPath: '/data/lit',
      manifest: {
        capabilities: {
          mcpServers: [
            { name: 'literature', command: 'node', args: ['./server.js'], env: { K: 'v' } },
          ],
        },
      },
    };
    const result = buildCandidatesFromPluginEntry(entry);
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({
      source: 'plugin',
      pluginId: 'com.duya.literature',
      pluginName: 'Literature Plugin',
      pluginRoot: '/plugins/lit',
      pluginDataPath: '/data/lit',
      rawConfig: {
        name: 'literature',
        command: 'node',
        args: ['./server.js'],
        env: { K: 'v' },
      },
    });
  });

  it('skips plugin MCP servers missing name or command', () => {
    const entry: MCPCollectorPluginEntry = {
      id: 'p', name: 'P', enabled: true, installPath: '/p',
      manifest: {
        capabilities: {
          mcpServers: [
            { name: '', command: 'node' },
            { name: 'x', command: '' },
            { name: 'good', command: 'node', args: [] },
          ],
        },
      },
    };
    const result = buildCandidatesFromPluginEntry(entry);
    expect(result).toHaveLength(1);
    expect(result[0].rawConfig.name).toBe('good');
  });
});

describe('buildCandidatesFromSettingsEntries', () => {
  it('preserves allowedAgentIds on the candidate', () => {
    const items: MCPConfigItem[] = [
      { name: 'search', command: 'node', args: [], allowedAgentIds: ['agent-a', 'agent-b'] },
    ];
    const result = buildCandidatesFromSettingsEntries('tomlFile', items);
    expect(result).toHaveLength(1);
    expect(result[0].rawConfig.allowedAgentIds).toEqual(['agent-a', 'agent-b']);
  });

  it('skips entries with enabled === false', () => {
    const items: MCPConfigItem[] = [
      { name: 'a', command: 'node', args: [], enabled: true },
      { name: 'b', command: 'node', args: [], enabled: false },
    ];
    const result = buildCandidatesFromSettingsEntries('tomlFile', items);
    expect(result).toHaveLength(1);
    expect(result[0].rawConfig.name).toBe('a');
  });

  it('tags each candidate with the tomlFile sourceSubOrigin', () => {
    const items: MCPConfigItem[] = [
      { name: 'a', command: 'node', args: [] },
    ];
    const result = buildCandidatesFromSettingsEntries('tomlFile', items);
    expect(result.every((c) => c.sourceSubOrigin === 'tomlFile')).toBe(true);
  });
});

// ============================================================================
// Pure transform: candidate assembly (shared engine)
// ============================================================================

describe('buildMCPCandidates (pure) — source coverage', () => {
  it('returns an empty candidate set from an empty input', () => {
    const r = buildMCPCandidates(emptyWorkerInput);
    expect(r.candidates).toEqual([]);
    expect(r.issues).toEqual([]);
  });

  it('emits plugin + one user TOML source', () => {
    const r = buildMCPCandidates({
      ...emptyWorkerInput,
      installedPlugins: [
        {
          id: 'p1', name: 'P1', enabled: true, installPath: '/p1',
          manifest: { capabilities: { mcpServers: [{ name: 'plugin-mcp', command: 'node', args: [] }] } },
        },
      ],
      userTomlItems: [{ name: 'factory-mcp', command: 'node', args: [], enabled: true }],
    });
    const sources = new Set(r.candidates.map((c) => c.source));
    expect(sources.has('plugin')).toBe(true);
    expect(sources.has('settings')).toBe(true);
    const settingsSubOrigins = new Set(
      r.candidates
        .filter((c) => c.source === 'settings')
        .map((c) => c.sourceSubOrigin),
    );
    expect(settingsSubOrigins).toEqual(new Set(['tomlFile']));
  });

  it('skips a disabled plugin but keeps its settings siblings', () => {
    const r = buildMCPCandidates({
      ...emptyWorkerInput,
      installedPlugins: [
        {
          id: 'p1', name: 'P1', enabled: false, installPath: '/p1',
          manifest: { capabilities: { mcpServers: [{ name: 's1', command: 'node', args: [] }] } },
        },
      ],
      userTomlItems: [{ name: 's2', command: 'node', args: [], enabled: true }],
    });
    const sources = r.candidates.map((c) => c.source).sort();
    expect(sources).toEqual(['settings']);
  });
});

// ============================================================================
// Async wrapper: collectWorkerMCPCandidates (with IPC mock)
// ============================================================================

vi.mock('../../src/ipc/db-client.js', () => ({
  pluginDb: {
    registryList: vi.fn(),
  },
}));

import * as dbClient from '../../src/ipc/db-client.js';

describe('collectWorkerMCPCandidates (IPC wrapper)', () => {
  beforeEach(() => {
    vi.mocked(dbClient.pluginDb.registryList).mockReset();
  });

  it('returns an empty MCPCollectionResult when all IPC calls fail', async () => {
    vi.mocked(dbClient.pluginDb.registryList).mockRejectedValue(new Error('ipc-down'));
    const r = await collectWorkerMCPCandidates();
    expect(r.candidates).toEqual([]);
    expect(r.issues).toEqual([]);
  });

  it('does not re-import user MCPs from deprecated IPC stores', async () => {
    vi.mocked(dbClient.pluginDb.registryList).mockResolvedValue([
      {
        id: 'p1', name: 'P1', enabled: true, installPath: '/p1', dataPath: '/d1',
        manifest: { capabilities: { mcpServers: [{ name: 'lit', command: 'node', args: [] }] } },
      },
    ] as never);
    const r = await collectWorkerMCPCandidates();
    const sources = new Set(r.candidates.map((c) => c.source));
    expect(sources.has('plugin')).toBe(true);
    expect(sources.has('settings')).toBe(false);
  });
});