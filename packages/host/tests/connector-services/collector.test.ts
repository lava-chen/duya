import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  collectWorkerMCPCandidates,
  fetchPluginSetupValuesForMcp,
  type MCPCollectorDatabasePort,
  type MCPCollectorLogger,
} from '../../src/connector-services/collector.js';
import type { MCPCollectorSettingsItem } from '@duya/plugin-core/mcp/collect';

function createPorts() {
  const database: MCPCollectorDatabasePort = {
    registryList: vi.fn(async () => []),
    setupListAll: vi.fn(async () => ({})),
  };
  const readUserMcpToml = vi.fn<() => Promise<MCPCollectorSettingsItem[]>>(async () => []);
  const logger: MCPCollectorLogger = {
    info: vi.fn(),
    warn: vi.fn(),
  };
  return { database, readUserMcpToml, logger };
}

describe('collectWorkerMCPCandidates', () => {
  let ports: ReturnType<typeof createPorts>;

  beforeEach(() => {
    ports = createPorts();
  });

  it('combines plugin registry and user config sources with provenance', async () => {
    vi.mocked(ports.database.registryList).mockResolvedValue([
      {
        id: 'p1',
        name: 'P1',
        enabled: true,
        installPath: '/plugins/p1',
        manifest: {
          capabilities: {
            mcpServers: [{ name: 'lit', command: 'node', args: ['./server.js'] }],
          },
        },
      },
    ]);
    ports.readUserMcpToml.mockResolvedValue([
      { name: 'codegraph', command: 'codegraph', args: ['serve'], enabled: true },
    ]);

    const result = await collectWorkerMCPCandidates(ports);

    expect(result.candidates.map((candidate) => candidate.source).sort()).toEqual([
      'plugin',
      'settings',
    ]);
    expect(result.candidates.find((candidate) => candidate.source === 'plugin')).toMatchObject({
      pluginId: 'p1',
      rawConfig: { name: 'lit', command: 'node' },
    });
    expect(result.candidates.find((candidate) => candidate.source === 'settings')).toMatchObject({
      sourceSubOrigin: 'tomlFile',
      rawConfig: { name: 'codegraph', command: 'codegraph' },
    });
    expect(result.issues).toEqual([]);
  });

  it('keeps user candidates when the plugin registry lookup fails', async () => {
    vi.mocked(ports.database.registryList).mockRejectedValue(new Error('ipc-down'));
    ports.readUserMcpToml.mockResolvedValue([
      { name: 'codegraph', command: 'codegraph', enabled: true },
    ]);

    const result = await collectWorkerMCPCandidates(ports);

    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0].source).toBe('settings');
    expect(result.issues).toEqual([]);
    expect(ports.logger.warn).toHaveBeenCalledWith(
      '[MCP] plugin registry lookup failed during discovery',
      { error: 'ipc-down' },
      'MCP',
    );
  });

  it('surfaces invalid user configuration as a typed discovery issue', async () => {
    ports.readUserMcpToml.mockRejectedValue(new Error('bad toml'));

    const result = await collectWorkerMCPCandidates(ports);

    expect(result.candidates).toEqual([]);
    expect(result.issues).toMatchObject([
      {
        phase: 'discovery',
        source: { source: 'settings', sourceSubOrigin: 'tomlFile' },
        error: { type: 'mcp-settings-invalid' },
      },
    ]);
  });
});

describe('fetchPluginSetupValuesForMcp', () => {
  it('returns setup data for manifest interpolation', async () => {
    const database: MCPCollectorDatabasePort = {
      registryList: vi.fn(async () => []),
      setupListAll: vi.fn(async () => ({ p1: { API_KEY: 'secret' } })),
    };

    await expect(fetchPluginSetupValuesForMcp(database)).resolves.toEqual({
      p1: { API_KEY: 'secret' },
    });
  });

  it('fails closed to an empty setup map and logs lookup errors', async () => {
    const database: MCPCollectorDatabasePort = {
      registryList: vi.fn(async () => []),
      setupListAll: vi.fn(async () => {
        throw new Error('ipc-down');
      }),
    };
    const logger: MCPCollectorLogger = { info: vi.fn(), warn: vi.fn() };

    await expect(fetchPluginSetupValuesForMcp(database, logger)).resolves.toEqual({});
    expect(logger.warn).toHaveBeenCalledWith(
      '[MCP] plugin setup lookup failed during discovery',
      { error: 'ipc-down' },
      'MCP',
    );
  });
});
