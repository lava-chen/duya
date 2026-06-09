// electron/agents/mcp/collect-main.test.ts
// Unit tests for the main-process MCP candidate collector.
//
// The IPC / accessors (PluginManager, ConfigManager, better-sqlite3,
// readPluginManifest) are mocked so the tests run in isolation. The
// pure transform `buildMainMCPCandidates` is exercised directly with
// synthetic input — this is where the contract-level coverage lives.

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
  buildMainMCPCandidates,
  buildMainCandidatesFromPluginEntry,
  buildMainCandidatesFromSettingsEntries,
  buildMainBundledLiteratureCandidate,
  buildMainBundledLiteratureBundlePath,
  getMainLegacySettingsPath,
  readMainLegacyFileMcpServers,
  collectMainMCPCandidates,
  type MainCollectorPluginEntry,
  type MainCollectorSettingsItem,
  type MainCollectorInput,
} from './collect-main.js';

const mockedGetPluginManager = vi.mocked(getPluginManager);
const mockedGetConfigManager = vi.mocked(getConfigManager);
const mockedGetDatabase = vi.mocked(getDatabase);

const emptyInput: MainCollectorInput = {
  installedPlugins: [],
  legacyFileItems: [],
  agentSettingsMcpServers: [],
  settingsKvMcpServers: [],
  environment: {},
  cwd: '/nonexistent/cwd',
};

// ============================================================================
// Per-source pure helpers
// ============================================================================

describe('buildMainCandidatesFromPluginEntry', () => {
  it('returns an empty array for a disabled plugin', () => {
    const entry: MainCollectorPluginEntry = {
      id: 'p', name: 'P', enabled: false, installPath: '/p',
      manifest: { capabilities: { mcpServers: [{ name: 'x', command: 'node', args: [] }] } },
    };
    expect(buildMainCandidatesFromPluginEntry(entry)).toEqual([]);
  });

  it('builds a candidate with pluginId, pluginName, pluginRoot, pluginDataPath', () => {
    const entry: MainCollectorPluginEntry = {
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
    const result = buildMainCandidatesFromPluginEntry(entry);
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
    const entry: MainCollectorPluginEntry = {
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
    const result = buildMainCandidatesFromPluginEntry(entry);
    expect(result).toHaveLength(1);
    expect(result[0].rawConfig.name).toBe('good');
  });
});

describe('buildMainCandidatesFromSettingsEntries', () => {
  it('preserves allowedAgentIds on the candidate', () => {
    const items: MainCollectorSettingsItem[] = [
      { name: 'search', command: 'node', args: [], allowedAgentIds: ['agent-a'] },
    ];
    const result = buildMainCandidatesFromSettingsEntries('agentSettings', items);
    expect(result).toHaveLength(1);
    expect(result[0].rawConfig.allowedAgentIds).toEqual(['agent-a']);
  });

  it('preserves the sourceSubOrigin on every candidate', () => {
    const items: MainCollectorSettingsItem[] = [
      { name: 'a', command: 'node', args: [] },
    ];
    const agent = buildMainCandidatesFromSettingsEntries('agentSettings', items);
    const kv = buildMainCandidatesFromSettingsEntries('settingsKv', items);
    const legacy = buildMainCandidatesFromSettingsEntries('legacyFile', items);
    expect(agent.every((c) => c.sourceSubOrigin === 'agentSettings')).toBe(true);
    expect(kv.every((c) => c.sourceSubOrigin === 'settingsKv')).toBe(true);
    expect(legacy.every((c) => c.sourceSubOrigin === 'legacyFile')).toBe(true);
  });
});

describe('buildMainBundledLiteratureCandidate', () => {
  it('ALWAYS returns a candidate, even when the bundled script does not exist', () => {
    const result = buildMainBundledLiteratureCandidate(
      '/nonexistent/path/for/main/tests',
      {},
    );
    expect(result).not.toBeNull();
    expect(result!.source).toBe('bundled');
    expect(result!.rawConfig.name).toBe('literature');
    expect(result!.rawConfig.command).toBe(process.execPath);
    expect(result!.rawConfig.args?.[0]).toContain('literature-mcp-server.js');
    expect(result!.rawConfig.env?.ELECTRON_RUN_AS_NODE).toBe('1');
  });

  it('uses the packaged bundle path when isPackaged is true', () => {
    const result = buildMainBundledLiteratureCandidate(
      '/should/not/be/used', {}, true, '/resources',
    );
    expect(result.rawConfig.args?.[0]).toContain('resources');
    expect(result.rawConfig.args?.[0]).toContain('agent-bundle');
    expect(result.rawConfig.args?.[0]).toContain('literature-mcp-server.js');
    expect(result.rawConfig.args?.[0]).not.toContain('should');
  });

  it('uses the dev bundle path when isPackaged is false', () => {
    const result = buildMainBundledLiteratureCandidate(
      '/repo', {}, false, '/resources',
    );
    expect(result.rawConfig.args?.[0]).toContain('repo');
    expect(result.rawConfig.args?.[0]).toContain('packages');
    expect(result.rawConfig.args?.[0]).toContain('agent');
    expect(result.rawConfig.args?.[0]).toContain('bundle');
    expect(result.rawConfig.args?.[0]).toContain('literature-mcp-server.js');
  });
});

describe('buildMainBundledLiteratureBundlePath', () => {
  it('returns packaged path when packaged with resourcesPath', () => {
    const p = buildMainBundledLiteratureBundlePath('/cwd', true, '/resources');
    expect(p).toContain('resources');
    expect(p).toContain('agent-bundle');
    expect(p).toContain('literature-mcp-server.js');
    expect(p).not.toContain('cwd');
  });

  it('returns dev path when not packaged', () => {
    const p = buildMainBundledLiteratureBundlePath('/cwd', false, '/resources');
    expect(p).toContain('cwd');
    expect(p).toContain('packages');
    expect(p).toContain('agent');
    expect(p).toContain('bundle');
    expect(p).toContain('literature-mcp-server.js');
  });

  it('returns dev path when packaged but resourcesPath missing', () => {
    const p = buildMainBundledLiteratureBundlePath('/cwd', true, undefined);
    expect(p).toContain('cwd');
    expect(p).toContain('packages');
    expect(p).toContain('bundle');
    expect(p).toContain('literature-mcp-server.js');
  });
});

// ============================================================================
// getMainLegacySettingsPath — signature contract
// ============================================================================
//
// Signature: (duyaAppDataPath: string | undefined, env?: NodeJS.ProcessEnv) => string | null
// First arg is the absolute app-data directory (typically
// `app.getPath('userData')` in production; bootstrap mirrors it into
// process.env.DUYA_APP_DATA_PATH). env is the fallback source.

describe('getMainLegacySettingsPath', () => {
  it('returns null when no duyaAppDataPath and no DUYA_APP_DATA_PATH env', () => {
    expect(getMainLegacySettingsPath(undefined, {})).toBeNull();
  });

  it('uses the explicit duyaAppDataPath when provided', () => {
    const p = getMainLegacySettingsPath('/app/data', {});
    expect(p).toContain('app');
    expect(p).toContain('data');
    expect(p).toContain('settings.json');
  });

  it('falls back to DUYA_APP_DATA_PATH env when duyaAppDataPath is undefined', () => {
    const p = getMainLegacySettingsPath(undefined, { DUYA_APP_DATA_PATH: '/env/path' });
    expect(p).toContain('env');
    expect(p).toContain('path');
    expect(p).toContain('settings.json');
  });

  it('prefers duyaAppDataPath over env when both are present', () => {
    const p = getMainLegacySettingsPath('/primary', { DUYA_APP_DATA_PATH: '/env/path' });
    expect(p).toContain('primary');
    expect(p).not.toContain('env');
  });

  it('defaults env to process.env when not provided', () => {
    const prev = process.env.DUYA_APP_DATA_PATH;
    process.env.DUYA_APP_DATA_PATH = '/from-process-env';
    try {
      const p = getMainLegacySettingsPath(undefined);
      expect(p).toContain('from-process-env');
    } finally {
      if (prev === undefined) {
        delete process.env.DUYA_APP_DATA_PATH;
      } else {
        process.env.DUYA_APP_DATA_PATH = prev;
      }
    }
  });
});

// ============================================================================
// readMainLegacyFileMcpServers — typed issues
// ============================================================================

describe('readMainLegacyFileMcpServers — file existence', () => {
  it('returns no items and no issues when settingsPath is null', async () => {
    const r = await readMainLegacyFileMcpServers(null);
    expect(r.items).toEqual([]);
    expect(r.issues).toEqual([]);
  });

  it('returns no items and no issues when the file does not exist (ENOENT)', async () => {
    const r = await readMainLegacyFileMcpServers('/no/such/file.json');
    expect(r.items).toEqual([]);
    expect(r.issues).toEqual([]);
  });
});

describe('readMainLegacyFileMcpServers — malformed JSON', () => {
  it('emits a phase: discovery mcp-settings-invalid issue when the file is not valid JSON', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'duya-main-legacy-'));
    try {
      const p = join(dir, 'settings.json');
      writeFileSync(p, 'this is not json');
      const r = await readMainLegacyFileMcpServers(p);
      expect(r.items).toEqual([]);
      expect(r.issues).toHaveLength(1);
      const err = r.issues[0].error as { type: string; reason: string };
      expect(err.type).toBe('mcp-settings-invalid');
      expect(r.issues[0].phase).toBe('discovery');
      expect(err.reason).toMatch(/not valid JSON/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('emits a mcp-settings-invalid issue when the root is not an object', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'duya-main-legacy-'));
    try {
      const p = join(dir, 'settings.json');
      writeFileSync(p, JSON.stringify(['not', 'an', 'object']));
      const r = await readMainLegacyFileMcpServers(p);
      expect(r.items).toEqual([]);
      expect(r.issues).toHaveLength(1);
      expect(r.issues[0].error.type).toBe('mcp-settings-invalid');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('emits a mcp-settings-invalid issue when mcpServers is present but not an array', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'duya-main-legacy-'));
    try {
      const p = join(dir, 'settings.json');
      writeFileSync(p, JSON.stringify({ mcpServers: 'oops' }));
      const r = await readMainLegacyFileMcpServers(p);
      expect(r.items).toEqual([]);
      expect(r.issues).toHaveLength(1);
      expect(r.issues[0].error.type).toBe('mcp-settings-invalid');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('returns no items and no issues when mcpServers is absent (not a failure)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'duya-main-legacy-'));
    try {
      const p = join(dir, 'settings.json');
      writeFileSync(p, JSON.stringify({ unrelated: true }));
      const r = await readMainLegacyFileMcpServers(p);
      expect(r.items).toEqual([]);
      expect(r.issues).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('readMainLegacyFileMcpServers — per-entry validation', () => {
  it('returns the mcpServers array when the file is well-formed', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'duya-main-legacy-'));
    try {
      const p = join(dir, 'settings.json');
      writeFileSync(
        p,
        JSON.stringify({
          mcpServers: [
            { name: 'main-legacy-lit', command: 'node', args: [] },
            { name: 'main-legacy-search', command: 'node', args: ['./server.js'] },
          ],
        }),
      );
      const r = await readMainLegacyFileMcpServers(p);
      expect(r.items).toHaveLength(2);
      expect(r.issues).toEqual([]);
      expect(r.items[0].name).toBe('main-legacy-lit');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('emits per-entry issues for invalid entries WITHOUT dropping valid ones', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'duya-main-legacy-'));
    try {
      const p = join(dir, 'settings.json');
      writeFileSync(
        p,
        JSON.stringify({
          mcpServers: [
            { name: 'good', command: 'node', args: [] },
            { name: '', command: 'node' },
            { name: 'no-cmd' },
            { name: 'good-2', command: 'node', args: [] },
          ],
        }),
      );
      const r = await readMainLegacyFileMcpServers(p);
      expect(r.items.map((i) => i.name)).toEqual(['good', 'good-2']);
      expect(r.issues).toHaveLength(2);
      expect(r.issues[0].error.type).toBe('mcp-settings-invalid');
      expect(r.issues[0].phase).toBe('discovery');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ============================================================================
// Pure transform: 5-source coverage (new contract: MCPCollectionResult)
// ============================================================================

describe('buildMainMCPCandidates (pure) — 5 sources', () => {
  it('returns MCPCollectionResult with bundled always present', () => {
    const r = buildMainMCPCandidates({ ...emptyInput, cwd: '/nonexistent/cwd' });
    expect(r.candidates.find((c) => c.source === 'bundled')).toBeDefined();
    expect(r.issues).toEqual([]);
  });

  it('emits ALL 5 sources: bundled + plugin + legacyFile + agentSettings + settingsKv', () => {
    const r = buildMainMCPCandidates({
      ...emptyInput,
      installedPlugins: [
        {
          id: 'p1', name: 'P1', enabled: true, installPath: '/p1',
          manifest: { capabilities: { mcpServers: [{ name: 'plugin-mcp', command: 'node', args: [] }] } },
        },
      ],
      legacyFileItems: [{ name: 'legacy-mcp', command: 'node', args: [] }],
      agentSettingsMcpServers: [{ name: 'agent-mcp', command: 'node', args: [] }],
      settingsKvMcpServers: [{ name: 'kv-mcp', command: 'node', args: [] }],
    });
    const sources = new Set(r.candidates.map((c) => c.source));
    expect(sources.has('bundled')).toBe(true);
    expect(sources.has('plugin')).toBe(true);
    expect(sources.has('settings')).toBe(true);
    const settingsSubOrigins = new Set(
      r.candidates.filter((c) => c.source === 'settings').map((c) => c.sourceSubOrigin),
    );
    expect(settingsSubOrigins.has('legacyFile')).toBe(true);
    expect(settingsSubOrigins.has('agentSettings')).toBe(true);
    expect(settingsSubOrigins.has('settingsKv')).toBe(true);
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

  it('returns MCPCollectionResult with bundled even when all accessors fail', async () => {
    mockedGetPluginManager.mockImplementation((() => { throw new Error('plugin-mgr-down'); }) as never);
    mockedGetConfigManager.mockImplementation((() => { throw new Error('cm-down'); }) as never);
    mockedGetDatabase.mockImplementation((() => { throw new Error('db-down'); }) as never);
    const r = await collectMainMCPCandidates();
    expect(r.candidates.filter((c) => c.source === 'bundled')).toHaveLength(1);
    expect(r.issues).toEqual([]);
  });

  it('collects plugin + agentSettings + settingsKv on a successful round', async () => {
    mockedGetPluginManager.mockReturnValue({
      listInstalled: () => [
        {
          id: 'p1', name: 'P1', enabled: true, installPath: '/p1', dataPath: '/d1',
          manifest: { capabilities: { mcpServers: [{ name: 'lit', command: 'node', args: [] }] } },
        },
      ],
    } as unknown as ReturnType<typeof getPluginManager>);
    mockedGetConfigManager.mockReturnValue({
      getAgentSettings: () => ({ mcpServers: [{ name: 'agent-lit', command: 'node', args: [] }] }),
    } as unknown as ReturnType<typeof getConfigManager>);
    mockedGetDatabase.mockReturnValue({
      prepare: () => ({
        get: () => ({ value: JSON.stringify([{ name: 'kv-lit', command: 'node', args: [] }]) }),
      }),
    } as unknown as ReturnType<typeof getDatabase>);
    const r = await collectMainMCPCandidates();
    const sources = new Set(r.candidates.map((c) => c.source));
    expect(sources.has('plugin')).toBe(true);
    expect(sources.has('settings')).toBe(true);
    expect(sources.has('bundled')).toBe(true);
    const settingsSubOrigins = r.candidates
      .filter((c) => c.source === 'settings')
      .map((c) => c.sourceSubOrigin)
      .sort();
    expect(settingsSubOrigins).toContain('agentSettings');
    expect(settingsSubOrigins).toContain('settingsKv');
  });

  it('reads the legacy on-disk settings.json when DUYA_APP_DATA_PATH is set', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'duya-main-legacy-'));
    try {
      const settingsPath = join(dir, 'settings.json');
      writeFileSync(
        settingsPath,
        JSON.stringify({
          mcpServers: [
            { name: 'legacy-from-disk', command: 'node', args: [] },
          ],
        }),
      );
      const prev = process.env.DUYA_APP_DATA_PATH;
      process.env.DUYA_APP_DATA_PATH = dir;
      try {
        mockedGetPluginManager.mockReturnValue({ listInstalled: () => [] } as unknown as ReturnType<typeof getPluginManager>);
        mockedGetConfigManager.mockReturnValue({ getAgentSettings: () => ({}) } as unknown as ReturnType<typeof getConfigManager>);
        mockedGetDatabase.mockReturnValue({
          prepare: () => ({ get: () => undefined }),
        } as unknown as ReturnType<typeof getDatabase>);
        const r = await collectMainMCPCandidates();
        const legacy = r.candidates.find(
          (c) => c.source === 'settings' && c.sourceSubOrigin === 'legacyFile',
        );
        expect(legacy).toBeDefined();
        expect(legacy!.rawConfig.name).toBe('legacy-from-disk');
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

  it('emits a mcp-settings-invalid issue when the legacy file is malformed (no active session)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'duya-main-legacy-'));
    try {
      const settingsPath = join(dir, 'settings.json');
      writeFileSync(settingsPath, 'this is not json');
      const prev = process.env.DUYA_APP_DATA_PATH;
      process.env.DUYA_APP_DATA_PATH = dir;
      try {
        mockedGetPluginManager.mockReturnValue({ listInstalled: () => [] } as unknown as ReturnType<typeof getPluginManager>);
        mockedGetConfigManager.mockReturnValue({ getAgentSettings: () => ({}) } as unknown as ReturnType<typeof getConfigManager>);
        mockedGetDatabase.mockReturnValue({
          prepare: () => ({ get: () => undefined }),
        } as unknown as ReturnType<typeof getDatabase>);
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

  it('collects bundled literature AND official plugin literature (engine applies fallback)', async () => {
    mockedGetPluginManager.mockReturnValue({
      listInstalled: () => [
        {
          id: 'com.duya.literature', name: 'Literature Plugin',
          enabled: true, installPath: '/plugins/lit', dataPath: '/data/lit',
          manifest: { capabilities: { mcpServers: [{ name: 'literature', command: 'node', args: [] }] } },
        },
      ],
    } as unknown as ReturnType<typeof getPluginManager>);
    mockedGetConfigManager.mockReturnValue({ getAgentSettings: () => ({}) } as unknown as ReturnType<typeof getConfigManager>);
    mockedGetDatabase.mockReturnValue({
      prepare: () => ({ get: () => undefined }),
    } as unknown as ReturnType<typeof getDatabase>);
    const r = await collectMainMCPCandidates();
    const bundled = r.candidates.find((c) => c.source === 'bundled' && c.rawConfig.name === 'literature');
    const plugin = r.candidates.find((c) => c.source === 'plugin' && c.rawConfig.name === 'literature');
    expect(bundled).toBeDefined();
    expect(plugin).toBeDefined();
  });
});
