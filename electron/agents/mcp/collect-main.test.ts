// electron/agents/mcp/collect-main.test.ts
// Unit tests for the main-process MCP candidate collector.
//
// The IPC / accessors (PluginManager, ConfigManager, better-sqlite3,
// readPluginManifest) are mocked so the tests run in isolation. The
// pure transforms now live in @duya/plugin-core/src/mcp/collect.ts and
// are exercised here against the shared engine (`buildMCPCandidates`
// and friends). The main-process-specific async wrapper
// `collectMainMCPCandidates` is tested directly.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

// Mock the main-process accessors BEFORE importing the collector.
vi.mock('../../plugins/PluginManager.js', () => ({
  getPluginManager: vi.fn(),
}));
vi.mock('../../config/manager.js', () => ({
  getConfigManager: vi.fn(),
}));
vi.mock('../../db/connection.js', () => ({
  getDatabase: vi.fn(),
}));
vi.mock('../../plugins/manifest.js', () => ({
  readPluginManifest: vi.fn((pluginRoot: string) => {
    const servers: Array<{ name: string; command: string; args?: string[]; env?: Record<string, string> }> = [];
    if (pluginRoot === '/plugins/lit') {
      servers.push({ name: 'literature', command: 'node', args: [] });
    }
    if (pluginRoot === '/p1') {
      servers.push({ name: 'lit', command: 'node', args: [] });
    }
    return {
      schemaVersion: 'duya.plugin.v1',
      id: 'mock',
      name: 'Mock',
      version: '0.0.0',
      description: 'mock',
      author: { name: 'mock' },
      entry: 'index.js',
      capabilities: {
        skills: [],
        mcpServers: servers,
        cli: [],
        ui: [],
        hooks: [],
      },
      permissions: [],
      engines: { duya: '*' },
    };
  }),
}));
vi.mock('../../logging/logger.js', () => ({
  getLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

import { getPluginManager } from '../../plugins/PluginManager.js';
import { getConfigManager } from '../../config/manager.js';
import { getDatabase } from '../../db/connection.js';
import {
  buildMCPCandidates,
  buildCandidatesFromPluginEntry,
  buildCandidatesFromSettingsEntries,
  type MCPCollectorPluginEntry,
  type MCPCollectorSettingsItem,
  type MCPCollectorInput,
} from '@duya/plugin-core/src/mcp/collect.js';
import {
  collectMainMCPCandidates,
} from './collect-main.js';

const mockedGetPluginManager = vi.mocked(getPluginManager);
const mockedGetConfigManager = vi.mocked(getConfigManager);
const mockedGetDatabase = vi.mocked(getDatabase);

const emptyInput: MCPCollectorInput = {
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
    const items: MCPCollectorSettingsItem[] = [
      { name: 'search', command: 'node', args: [], allowedAgentIds: ['agent-a'] },
    ];
    const result = buildCandidatesFromSettingsEntries('tomlFile', items);
    expect(result).toHaveLength(1);
    expect(result[0].rawConfig.allowedAgentIds).toEqual(['agent-a']);
  });

  it('tags each candidate with the tomlFile sourceSubOrigin', () => {
    const items: MCPCollectorSettingsItem[] = [
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
    const r = buildMCPCandidates(emptyInput);
    expect(r.candidates).toEqual([]);
    expect(r.issues).toEqual([]);
  });

  it('emits plugin + one user TOML source', () => {
    const r = buildMCPCandidates({
      ...emptyInput,
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
      r.candidates.filter((c) => c.source === 'settings').map((c) => c.sourceSubOrigin),
    );
    expect(settingsSubOrigins).toEqual(new Set(['tomlFile']));
  });
});

// ============================================================================
// Async wrapper
// ============================================================================

describe('collectMainMCPCandidates (accessor wrapper)', () => {
  beforeEach(() => {
    mockedGetPluginManager.mockReset();
    mockedGetConfigManager.mockReset();
    mockedGetDatabase.mockReset();
  });

  it('returns an empty MCPCollectionResult when all accessors fail', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'duya-main-mcp-'));
    try {
      const prev = process.env.DUYA_APP_DATA_PATH;
      process.env.DUYA_APP_DATA_PATH = dir;
      try {
        mockedGetPluginManager.mockImplementation((() => { throw new Error('plugin-mgr-down'); }) as never);
        const r = await collectMainMCPCandidates();
        expect(r.candidates).toEqual([]);
        expect(r.issues).toEqual([]);
      } finally {
        if (prev === undefined) {
          delete process.env.DUYA_APP_DATA_PATH;
        } else {
          process.env.DUYA_APP_DATA_PATH = prev;
        }
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('does not re-import user MCPs from deprecated stores', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'duya-main-mcp-'));
    try {
      const prev = process.env.DUYA_APP_DATA_PATH;
      process.env.DUYA_APP_DATA_PATH = dir;
      try {
        mockedGetPluginManager.mockReturnValue({
          listInstalled: () => [
            {
              id: 'p1', name: 'P1', enabled: true, installPath: '/p1', dataPath: '/d1',
              manifest: { capabilities: { mcpServers: [{ name: 'lit', command: 'node', args: [] }] } },
            },
          ],
        } as unknown as ReturnType<typeof getPluginManager>);
        const r = await collectMainMCPCandidates();
        const sources = new Set(r.candidates.map((c) => c.source));
        expect(sources.has('plugin')).toBe(true);
        expect(sources.has('settings')).toBe(false);
      } finally {
        if (prev === undefined) {
          delete process.env.DUYA_APP_DATA_PATH;
        } else {
          process.env.DUYA_APP_DATA_PATH = prev;
        }
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('reads mcp.toml when DUYA_APP_DATA_PATH is set', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'duya-main-mcp-'));
    try {
      const settingsPath = join(dir, 'mcp.toml');
      writeFileSync(
        settingsPath,
        '[mcp_servers.factory-from-disk]\ncommand = "node"\nenabled = true\n',
      );
      const prev = process.env.DUYA_APP_DATA_PATH;
      process.env.DUYA_APP_DATA_PATH = dir;
      try {
        mockedGetPluginManager.mockReturnValue({ listInstalled: () => [] } as unknown as ReturnType<typeof getPluginManager>);
        const r = await collectMainMCPCandidates();
        const fromToml = r.candidates.find(
          (c) => c.source === 'settings' && c.sourceSubOrigin === 'tomlFile',
        );
        expect(fromToml).toBeDefined();
        expect(fromToml!.rawConfig.name).toBe('factory-from-disk');
      } finally {
        if (prev === undefined) {
          delete process.env.DUYA_APP_DATA_PATH;
        } else {
          process.env.DUYA_APP_DATA_PATH = prev;
        }
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('emits a mcp-settings-invalid issue when mcp.toml is malformed', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'duya-main-mcp-'));
    try {
      const settingsPath = join(dir, 'mcp.toml');
      writeFileSync(settingsPath, 'this is not toml = [');
      const prev = process.env.DUYA_APP_DATA_PATH;
      process.env.DUYA_APP_DATA_PATH = dir;
      try {
        mockedGetPluginManager.mockReturnValue({ listInstalled: () => [] } as unknown as ReturnType<typeof getPluginManager>);
        const r = await collectMainMCPCandidates();
        const settingsInvalid = r.issues.filter((i) => i.error.type === 'mcp-settings-invalid');
        expect(settingsInvalid.length).toBeGreaterThan(0);
        expect(settingsInvalid[0].phase).toBe('discovery');
      } finally {
        if (prev === undefined) {
          delete process.env.DUYA_APP_DATA_PATH;
        } else {
          process.env.DUYA_APP_DATA_PATH = prev;
        }
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});