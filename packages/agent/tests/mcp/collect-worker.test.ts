// packages/agent/tests/mcp/collect-worker.test.ts
// Unit tests for the worker-side MCP candidate collector.
//
// Tests target the pure transform `buildWorkerMCPCandidates` directly
// so the IPC layer does not need to be mocked. The async wrapper
// `collectWorkerMCPCandidates` is exercised separately with a minimal
// mock of the db-client shape.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  buildBundledLiteratureBundlePath,
  buildBundledLiteratureCandidate,
  buildCandidatesFromPluginEntry,
  buildCandidatesFromSettingsEntries,
  buildWorkerMCPCandidates,
  readLegacyFileMcpServers,
  collectWorkerMCPCandidates,
  type CollectorPluginEntry,
  type WorkerCollectorInput,
} from '../../src/mcp/collect-worker.js';
import type { MCPConfigItem } from '../../src/mcp/config.js';

const baseEnv: Record<string, string> = {};

const emptyWorkerInput: WorkerCollectorInput = {
  installedPlugins: [],
  agentSettingsMcpServers: [],
  settingsKvMcpServers: [],
  legacyFileMcpServers: undefined,
  environment: {},
  cwd: '/nonexistent/cwd',
};

// ============================================================================
// Per-source pure helpers
// ============================================================================

describe('buildBundledLiteratureBundlePath', () => {
  it('returns packaged path when packaged with resourcesPath', () => {
    const p = buildBundledLiteratureBundlePath('/cwd', true, '/resources');
    expect(p).toContain('resources');
    expect(p).toContain('agent-bundle');
    expect(p).toContain('literature-mcp-server.js');
  });

  it('returns dev path when not packaged', () => {
    const p = buildBundledLiteratureBundlePath('/cwd', false, undefined);
    expect(p).toContain('cwd');
    expect(p).toContain('packages');
    expect(p).toContain('agent');
    expect(p).toContain('bundle');
    expect(p).toContain('literature-mcp-server.js');
  });
});

describe('buildBundledLiteratureCandidate', () => {
  it('ALWAYS returns a candidate, even when the bundled script does not exist', () => {
    const result = buildBundledLiteratureCandidate(
      '/nonexistent/path/for/tests',
      baseEnv,
    );
    expect(result.source).toBe('bundled');
    expect(result.rawConfig.name).toBe('literature');
    expect(result.rawConfig.args[0]).toContain('literature-mcp-server.js');
  });
});

describe('buildCandidatesFromPluginEntry', () => {
  it('returns an empty array for a disabled plugin', () => {
    const entry: CollectorPluginEntry = {
      id: 'p', name: 'P', enabled: false, installPath: '/p',
      manifest: { capabilities: { mcpServers: [{ name: 'x', command: 'node', args: [] }] } },
    };
    expect(buildCandidatesFromPluginEntry(entry)).toEqual([]);
  });

  it('returns an empty array when manifest is missing', () => {
    const entry: CollectorPluginEntry = {
      id: 'p', name: 'P', enabled: true, installPath: '/p',
    };
    expect(buildCandidatesFromPluginEntry(entry)).toEqual([]);
  });

  it('builds a candidate with pluginId, pluginName, pluginRoot, pluginDataPath', () => {
    const entry: CollectorPluginEntry = {
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
    const entry: CollectorPluginEntry = {
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
    const result = buildCandidatesFromSettingsEntries('agentSettings', items);
    expect(result).toHaveLength(1);
    expect(result[0].rawConfig.allowedAgentIds).toEqual(['agent-a', 'agent-b']);
  });

  it('skips entries with enabled === false', () => {
    const items: MCPConfigItem[] = [
      { name: 'a', command: 'node', args: [], enabled: true },
      { name: 'b', command: 'node', args: [], enabled: false },
    ];
    const result = buildCandidatesFromSettingsEntries('agentSettings', items);
    expect(result).toHaveLength(1);
    expect(result[0].rawConfig.name).toBe('a');
  });

  it('preserves the sourceSubOrigin on every candidate', () => {
    const items: MCPConfigItem[] = [
      { name: 'a', command: 'node', args: [] },
    ];
    const agent = buildCandidatesFromSettingsEntries('agentSettings', items);
    const kv = buildCandidatesFromSettingsEntries('settingsKv', items);
    const legacy = buildCandidatesFromSettingsEntries('legacyFile', items);
    expect(agent.every((c) => c.sourceSubOrigin === 'agentSettings')).toBe(true);
    expect(kv.every((c) => c.sourceSubOrigin === 'settingsKv')).toBe(true);
    expect(legacy.every((c) => c.sourceSubOrigin === 'legacyFile')).toBe(true);
  });
});

// ============================================================================
// Legacy reader (typed issues, Phase 1B contract)
// ============================================================================

describe('readLegacyFileMcpServers — file existence', () => {
  it('returns no items and no issues when settingsPath is null', async () => {
    const r = await readLegacyFileMcpServers(null);
    expect(r.items).toEqual([]);
    expect(r.issues).toEqual([]);
  });

  it('returns no items and no issues when the file does not exist (ENOENT)', async () => {
    const r = await readLegacyFileMcpServers('/no/such/file.json');
    expect(r.items).toEqual([]);
    expect(r.issues).toEqual([]);
  });
});

describe('readLegacyFileMcpServers — malformed JSON', () => {
  it('emits a phase: discovery mcp-settings-invalid issue when the file is not valid JSON', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'duya-worker-legacy-'));
    try {
      const p = join(dir, 'settings.json');
      writeFileSync(p, 'this is not json');
      const r = await readLegacyFileMcpServers(p);
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
    const dir = mkdtempSync(join(tmpdir(), 'duya-worker-legacy-'));
    try {
      const p = join(dir, 'settings.json');
      writeFileSync(p, JSON.stringify(['not', 'an', 'object']));
      const r = await readLegacyFileMcpServers(p);
      expect(r.items).toEqual([]);
      expect(r.issues).toHaveLength(1);
      const err = r.issues[0].error as { type: string };
      expect(err.type).toBe('mcp-settings-invalid');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('emits a mcp-settings-invalid issue when mcpServers is present but not an array', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'duya-worker-legacy-'));
    try {
      const p = join(dir, 'settings.json');
      writeFileSync(p, JSON.stringify({ mcpServers: 'oops' }));
      const r = await readLegacyFileMcpServers(p);
      expect(r.items).toEqual([]);
      expect(r.issues).toHaveLength(1);
      const err = r.issues[0].error as { type: string };
      expect(err.type).toBe('mcp-settings-invalid');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('returns no items and no issues when mcpServers is absent (not a failure)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'duya-worker-legacy-'));
    try {
      const p = join(dir, 'settings.json');
      writeFileSync(p, JSON.stringify({ unrelated: true }));
      const r = await readLegacyFileMcpServers(p);
      expect(r.items).toEqual([]);
      expect(r.issues).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('readLegacyFileMcpServers — per-entry validation', () => {
  it('returns the mcpServers array when the file is well-formed', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'duya-worker-legacy-'));
    try {
      const p = join(dir, 'settings.json');
      writeFileSync(
        p,
        JSON.stringify({
          mcpServers: [
            { name: 'worker-legacy-lit', command: 'node', args: [] },
            { name: 'worker-legacy-search', command: 'node', args: ['./server.js'] },
          ],
        }),
      );
      const r = await readLegacyFileMcpServers(p);
      expect(r.items).toHaveLength(2);
      expect(r.issues).toEqual([]);
      expect(r.items[0].name).toBe('worker-legacy-lit');
      expect(r.items[1].name).toBe('worker-legacy-search');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('emits per-entry issues for invalid entries WITHOUT dropping valid ones', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'duya-worker-legacy-'));
    try {
      const p = join(dir, 'settings.json');
      writeFileSync(
        p,
        JSON.stringify({
          mcpServers: [
            { name: 'good', command: 'node', args: [] },
            { name: '', command: 'node' },                 // empty name
            { name: 'no-cmd' },                            // no command
            { name: 'good-2', command: 'node', args: [] },
          ],
        }),
      );
      const r = await readLegacyFileMcpServers(p);
      expect(r.items.map((i) => i.name)).toEqual(['good', 'good-2']);
      expect(r.issues).toHaveLength(2);
      expect(r.issues[0].error.type).toBe('mcp-settings-invalid');
      expect(r.issues[0].phase).toBe('discovery');
      expect(r.issues[1].error.type).toBe('mcp-settings-invalid');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('emits a per-entry issue when the entry is not an object', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'duya-worker-legacy-'));
    try {
      const p = join(dir, 'settings.json');
      writeFileSync(p, JSON.stringify({ mcpServers: ['not an object'] }));
      const r = await readLegacyFileMcpServers(p);
      expect(r.items).toEqual([]);
      expect(r.issues).toHaveLength(1);
      expect(r.issues[0].error.type).toBe('mcp-settings-invalid');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ============================================================================
// Pure transform: 5-source coverage (new contract: MCPCollectionResult)
// ============================================================================

describe('buildWorkerMCPCandidates (pure) — 5 sources', () => {
  it('returns MCPCollectionResult with bundled always present', () => {
    const r = buildWorkerMCPCandidates({
      ...emptyWorkerInput,
      cwd: '/nonexistent/cwd',
    });
    expect(r.candidates.find((c) => c.source === 'bundled')).toBeDefined();
    expect(r.issues).toEqual([]);
  });

  it('emits ALL 5 sources: bundled + plugin + legacyFile + agentSettings + settingsKv', () => {
    const r = buildWorkerMCPCandidates({
      ...emptyWorkerInput,
      installedPlugins: [
        {
          id: 'p1', name: 'P1', enabled: true, installPath: '/p1',
          manifest: { capabilities: { mcpServers: [{ name: 'plugin-mcp', command: 'node', args: [] }] } },
        },
      ],
      legacyFileMcpServers: [{ name: 'legacy-mcp', command: 'node', args: [] }],
      agentSettingsMcpServers: [{ name: 'agent-mcp', command: 'node', args: [] }],
      settingsKvMcpServers: [{ name: 'kv-mcp', command: 'node', args: [] }],
    });
    const sources = new Set(r.candidates.map((c) => c.source));
    expect(sources.has('bundled')).toBe(true);
    expect(sources.has('plugin')).toBe(true);
    expect(sources.has('settings')).toBe(true);
    const settingsSubOrigins = new Set(
      r.candidates
        .filter((c) => c.source === 'settings')
        .map((c) => c.sourceSubOrigin),
    );
    expect(settingsSubOrigins.has('legacyFile')).toBe(true);
    expect(settingsSubOrigins.has('agentSettings')).toBe(true);
    expect(settingsSubOrigins.has('settingsKv')).toBe(true);
  });

  it('keeps all three settings sub-origins distinct (no within-source dedup at collector level)', () => {
    const items: MCPConfigItem[] = [
      { name: 'literature', command: 'node', args: [] },
    ];
    const r = buildWorkerMCPCandidates({
      ...emptyWorkerInput,
      agentSettingsMcpServers: items,
      settingsKvMcpServers: items,
      legacyFileMcpServers: items,
    });
    const settingsSubOrigins = r.candidates
      .filter((c) => c.source === 'settings')
      .map((c) => c.sourceSubOrigin)
      .sort();
    expect(settingsSubOrigins).toEqual(['agentSettings', 'legacyFile', 'settingsKv']);
  });

  it('skips a disabled plugin but keeps its settings siblings', () => {
    const r = buildWorkerMCPCandidates({
      ...emptyWorkerInput,
      installedPlugins: [
        {
          id: 'p1', name: 'P1', enabled: false, installPath: '/p1',
          manifest: { capabilities: { mcpServers: [{ name: 's1', command: 'node', args: [] }] } },
        },
      ],
      agentSettingsMcpServers: [{ name: 's2', command: 'node', args: [] }],
    });
    const sources = r.candidates.map((c) => c.source).sort();
    expect(sources).toEqual(['bundled', 'settings']);
  });

  it('bundled literature and official plugin literature both surface (coexistence; engine applies fallback)', () => {
    const r = buildWorkerMCPCandidates({
      ...emptyWorkerInput,
      installedPlugins: [
        {
          id: 'com.duya.literature', name: 'Literature Plugin',
          enabled: true, installPath: '/plugins/lit', dataPath: '/data/lit',
          manifest: { capabilities: { mcpServers: [{ name: 'literature', command: 'node', args: [] }] } },
        },
      ],
    });
    const plugin = r.candidates.find((c) => c.source === 'plugin' && c.rawConfig.name === 'literature');
    const bundled = r.candidates.find((c) => c.source === 'bundled' && c.rawConfig.name === 'literature');
    expect(plugin).toBeDefined();
    expect(bundled).toBeDefined();
  });
});

// ============================================================================
// Async wrapper: collectWorkerMCPCandidates (with IPC mock)
// ============================================================================

vi.mock('../../src/ipc/db-client.js', () => ({
  pluginDb: {
    registryList: vi.fn(),
  },
  configDb: {
    agentGetSettings: vi.fn(),
  },
  settingDb: {
    getJson: vi.fn(),
  },
}));

import * as dbClient from '../../src/ipc/db-client.js';

describe('collectWorkerMCPCandidates (IPC wrapper)', () => {
  beforeEach(() => {
    vi.mocked(dbClient.pluginDb.registryList).mockReset();
    vi.mocked(dbClient.configDb.agentGetSettings).mockReset();
    vi.mocked(dbClient.settingDb.getJson).mockReset();
  });

  it('returns MCPCollectionResult with bundled even when all IPC calls fail', async () => {
    vi.mocked(dbClient.pluginDb.registryList).mockRejectedValue(new Error('ipc-down'));
    vi.mocked(dbClient.configDb.agentGetSettings).mockRejectedValue(new Error('ipc-down'));
    vi.mocked(dbClient.settingDb.getJson).mockRejectedValue(new Error('ipc-down'));
    const r = await collectWorkerMCPCandidates();
    expect(r.candidates.filter((c) => c.source === 'bundled')).toHaveLength(1);
    expect(r.issues).toEqual([]);
  });

  it('produces plugin + settings + bundled candidates on a successful IPC round', async () => {
    vi.mocked(dbClient.pluginDb.registryList).mockResolvedValue([
      {
        id: 'p1', name: 'P1', enabled: true, installPath: '/p1', dataPath: '/d1',
        manifest: { capabilities: { mcpServers: [{ name: 'lit', command: 'node', args: [] }] } },
      },
    ] as never);
    vi.mocked(dbClient.configDb.agentGetSettings).mockResolvedValue({
      mcpServers: [{ name: 'lit', command: 'node', args: [] }],
    } as never);
    vi.mocked(dbClient.settingDb.getJson).mockResolvedValue([
      { name: 'kv-lit', command: 'node', args: [] },
    ] as never);
    const r = await collectWorkerMCPCandidates();
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
});
