// electron/plugins/manifest.test.ts
// Plan: plugin-config-simplification — tests for the minimal
// `.duya-plugin/plugin.json` reader + legacy v1/v2 compat + lenient
// fallback.
//
// Covers `readPluginManifest` for:
// - Minimal `.duya-plugin/plugin.json` resolves capabilities from disk
// - v1/v2 root `plugin.json` parse unchanged (marketplace compat)
// - Unsupported schemaVersion is rejected
// - `readPluginManifestLenient` degrades gracefully (never throws)

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

// Mock electron so the manifest module can be imported in a plain
// vitest environment. `manifest.ts` does not import electron directly,
// but its sibling `catalog.ts` does — keeping the mock avoids accidental
// transitive failures.
vi.mock('electron', () => ({
  app: {
    isPackaged: false,
    getPath: () => '/tmp/duya-test',
  },
}));

import { readPluginManifest, readPluginManifestLenient } from './manifest.js';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'duya-manifest-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

// ----------------------------------------------------------------------------
// Minimal `.duya-plugin/plugin.json` — the new builtin shape
// ----------------------------------------------------------------------------

describe('readPluginManifest — minimal .duya-plugin/plugin.json', () => {
  it('parses identity fields and derives id from name', () => {
    mkdirSync(join(dir, '.duya-plugin'));
    writeFileSync(
      join(dir, '.duya-plugin', 'plugin.json'),
      JSON.stringify({
        name: 'my-plugin',
        version: '1.0.0',
        description: 'A minimal plugin.',
        author: { name: 'DUYA Team' },
      }),
    );

    const manifest = readPluginManifest(dir);
    expect(manifest.schemaVersion).toBe('duya.plugin.v2');
    expect(manifest.id).toBe('com.duya.my-plugin');
    expect(manifest.name).toBe('my-plugin');
    expect(manifest.version).toBe('1.0.0');
    expect(manifest.author.name).toBe('DUYA Team');
    // No capability files on disk → empty capabilities + empty components.
    expect(manifest.capabilities.skills).toBeUndefined();
    expect(manifest.components?.skills).toEqual([]);
  });

  it('resolves skills + mcpServers + workflows from disk', () => {
    mkdirSync(join(dir, '.duya-plugin'));
    writeFileSync(
      join(dir, '.duya-plugin', 'plugin.json'),
      JSON.stringify({
        name: 'full-plugin',
        version: '0.2.0',
        description: 'A plugin with disk capabilities.',
      }),
    );
    // skills/<name>/SKILL.md
    mkdirSync(join(dir, 'skills', 'alpha'), { recursive: true });
    writeFileSync(join(dir, 'skills', 'alpha', 'SKILL.md'), '# Alpha\n');
    mkdirSync(join(dir, 'skills', 'beta'), { recursive: true });
    writeFileSync(join(dir, 'skills', 'beta', 'SKILL.md'), '# Beta\n');
    // mcp/servers.json
    mkdirSync(join(dir, 'mcp'), { recursive: true });
    writeFileSync(
      join(dir, 'mcp', 'servers.json'),
      JSON.stringify({
        servers: [{ name: 'my-mcp', command: 'node', args: ['server.js'] }],
      }),
    );
    // permissions/policy.json
    mkdirSync(join(dir, 'permissions'), { recursive: true });
    writeFileSync(
      join(dir, 'permissions', 'policy.json'),
      JSON.stringify({
        defaultMode: 'read',
        permissions: [{ name: 'workspace.read' }],
      }),
    );

    const manifest = readPluginManifest(dir);
    expect(manifest.capabilities.skills).toEqual(['alpha', 'beta']);
    expect(manifest.capabilities.mcpServers).toEqual([
      { name: 'my-mcp', command: 'node', args: ['server.js'] },
    ]);
    expect(manifest.components?.skills).toEqual(['alpha', 'beta']);
    expect(manifest.components?.mcpServers).toEqual(['my-mcp']);
    expect(manifest.permissionPolicy?.defaultMode).toBe('read');
    expect(manifest.permissions).toEqual([{ name: 'workspace.read', scope: undefined, domains: undefined }]);
  });

  it('parses optional interface + setup fields', () => {
    mkdirSync(join(dir, '.duya-plugin'));
    writeFileSync(
      join(dir, '.duya-plugin', 'plugin.json'),
      JSON.stringify({
        name: 'market-plugin',
        version: '1.0.0',
        description: 'Has market UI metadata.',
        author: { name: 'DUYA Team' },
        homepage: 'https://example.com',
        license: 'MIT',
        keywords: ['example', 'test'],
        interface: {
          displayName: 'Market Plugin',
          longDescription: 'A longer description for the market.',
          category: 'development',
          brandColor: '#ff0000',
        },
        setup: [
          { id: 'token', label: 'API Token', type: 'secret', required: true },
        ],
      }),
    );

    const manifest = readPluginManifest(dir);
    expect(manifest.homepage).toBe('https://example.com');
    expect(manifest.license).toBe('MIT');
    expect(manifest.keywords).toEqual(['example', 'test']);
    expect(manifest.interface?.displayName).toBe('Market Plugin');
    expect(manifest.interface?.category).toBe('development');
    expect(manifest.interface?.brandColor).toBe('#ff0000');
    expect(manifest.setup).toEqual([
      { id: 'token', label: 'API Token', type: 'secret', required: true, connectionId: undefined },
    ]);
  });
});

// ----------------------------------------------------------------------------
// v1 compatibility — existing v1 manifests must parse with zero changes
// ----------------------------------------------------------------------------

describe('readPluginManifest — v1 compatibility', () => {
  it('parses a well-formed v1 manifest', () => {
    writeFileSync(
      join(dir, 'plugin.json'),
      JSON.stringify({
        schemaVersion: 'duya.plugin.v1',
        id: 'com.duya.example',
        name: 'Example',
        version: '1.0.0',
        description: 'An example v1 plugin.',
        author: { name: 'DUYA Team' },
        capabilities: {
          skills: ['alpha', 'beta'],
          mcpServers: [{ name: 'example-mcp', command: 'node' }],
        },
        permissions: [{ name: 'workspace.read' }],
        engines: { duya: '>=0.1.0' },
      }),
    );

    const manifest = readPluginManifest(dir);
    expect(manifest.schemaVersion).toBe('duya.plugin.v1');
    expect(manifest.id).toBe('com.duya.example');
    expect(manifest.capabilities.skills).toEqual(['alpha', 'beta']);
    expect(manifest.capabilities.mcpServers).toEqual([
      { name: 'example-mcp', command: 'node', args: undefined },
    ]);
    // v1 manifests do not carry components / permissionPolicy / publisher.
    expect(manifest.components).toBeUndefined();
    expect(manifest.permissionPolicy).toBeUndefined();
    expect(manifest.publisher).toBeUndefined();
  });

  it('rejects v1 manifest missing capabilities', () => {
    writeFileSync(
      join(dir, 'plugin.json'),
      JSON.stringify({
        schemaVersion: 'duya.plugin.v1',
        id: 'com.duya.no-caps',
        name: 'NoCaps',
        version: '1.0.0',
        description: 'Missing capabilities.',
        author: { name: 'DUYA Team' },
        permissions: [],
        engines: { duya: '>=0.1.0' },
      }),
    );
    expect(() => readPluginManifest(dir)).toThrow('capabilities');
  });
});

// ----------------------------------------------------------------------------
// v2 parsing — components / permissionPolicy / publisher
// ----------------------------------------------------------------------------

describe('readPluginManifest — v2 parsing', () => {
  it('parses a v2 manifest with components, permissionPolicy, and publisher', () => {
    writeFileSync(
      join(dir, 'plugin.json'),
      JSON.stringify({
        schemaVersion: 'duya.plugin.v2',
        id: 'com.duya.v2-plugin',
        name: 'V2 Plugin',
        version: '2.0.0',
        description: 'A v2 plugin with workflows.',
        author: { name: 'DUYA Team' },
        capabilities: {
          mcpServers: [{ name: 'lit', command: 'node' }],
        },
        components: {
          mcpServers: ['lit'],
          skills: ['paper-analysis'],
          workflows: ['literature-review'],
          appConnections: [],
        },
        permissionPolicy: {
          defaultMode: 'write',
          writeActionsRequireApproval: true,
          destructiveActionsRequireApproval: true,
        },
        publisher: {
          name: 'DUYA',
          url: 'https://duya.dev',
          verified: true,
        },
        permissions: [{ name: 'workspace.read' }],
        engines: { duya: '>=0.1.0' },
      }),
    );

    const manifest = readPluginManifest(dir);
    expect(manifest.schemaVersion).toBe('duya.plugin.v2');
    expect(manifest.components).toEqual({
      mcpServers: ['lit'],
      skills: ['paper-analysis'],
      workflows: ['literature-review'],
      appConnections: [],
    });
    expect(manifest.permissionPolicy).toEqual({
      defaultMode: 'write',
      writeActionsRequireApproval: true,
      destructiveActionsRequireApproval: true,
    });
    expect(manifest.publisher).toEqual({
      name: 'DUYA',
      url: 'https://duya.dev',
      verified: true,
    });
  });

  it('parses a v2 manifest that omits capabilities in favour of components', () => {
    writeFileSync(
      join(dir, 'plugin.json'),
      JSON.stringify({
        schemaVersion: 'duya.plugin.v2',
        id: 'com.duya.v2-components-only',
        name: 'ComponentsOnly',
        version: '2.0.0',
        description: 'A v2 plugin using only components.',
        author: { name: 'DUYA Team' },
        components: {
          mcpServers: [],
          skills: [],
          workflows: ['review'],
          appConnections: [],
        },
        permissions: [],
        engines: { duya: '>=0.1.0' },
      }),
    );

    const manifest = readPluginManifest(dir);
    expect(manifest.schemaVersion).toBe('duya.plugin.v2');
    // capabilities is synthesised as an empty object — downstream code
    // can read manifest.capabilities.* without a separate undefined check.
    expect(manifest.capabilities).toBeDefined();
    expect(manifest.capabilities.skills).toBeUndefined();
    expect(manifest.components?.workflows).toEqual(['review']);
  });

  it('parses a v2 manifest without components (components is optional in the type)', () => {
    writeFileSync(
      join(dir, 'plugin.json'),
      JSON.stringify({
        schemaVersion: 'duya.plugin.v2',
        id: 'com.duya.v2-minimal',
        name: 'MinimalV2',
        version: '2.0.0',
        description: 'Minimal v2.',
        author: { name: 'DUYA Team' },
        permissions: [],
        engines: { duya: '>=0.1.0' },
      }),
    );

    const manifest = readPluginManifest(dir);
    expect(manifest.schemaVersion).toBe('duya.plugin.v2');
    expect(manifest.components).toBeUndefined();
    expect(manifest.permissionPolicy).toBeUndefined();
  });
});

// ----------------------------------------------------------------------------
// Schema version rejection
// ----------------------------------------------------------------------------

describe('readPluginManifest — unsupported schemaVersion', () => {
  it('rejects an unknown schemaVersion', () => {
    writeFileSync(
      join(dir, 'plugin.json'),
      JSON.stringify({
        schemaVersion: 'duya.plugin.v3',
        id: 'com.duya.future',
        name: 'Future',
        version: '3.0.0',
        description: 'From the future.',
        author: { name: 'DUYA Team' },
        permissions: [],
        engines: { duya: '>=0.1.0' },
      }),
    );
    expect(() => readPluginManifest(dir)).toThrow('Unsupported schemaVersion');
  });
});

// ----------------------------------------------------------------------------
// readPluginManifestLenient — graceful degradation (never throws)
// ----------------------------------------------------------------------------

describe('readPluginManifestLenient — graceful fallback', () => {
  it('reads a minimal .duya-plugin/plugin.json and returns a full manifest', () => {
    mkdirSync(join(dir, '.duya-plugin'));
    writeFileSync(
      join(dir, '.duya-plugin', 'plugin.json'),
      JSON.stringify({
        name: 'lenient-plugin',
        version: '0.1.0',
        description: 'Lenient test.',
      }),
    );

    const result = readPluginManifestLenient(dir);
    expect(result.source).toBe('plugin.json');
    expect(result.warnings).toEqual([]);
    expect(result.manifest.schemaVersion).toBe('duya.plugin.v2');
    expect(result.manifest.name).toBe('lenient-plugin');
    // agentContext falls back to description when interface.longDescription is absent.
    expect(result.agentContext).toBe('Lenient test.');
  });

  it('falls back to legacy plugin.json when .duya-plugin/ is absent', () => {
    writeFileSync(
      join(dir, 'plugin.json'),
      JSON.stringify({
        schemaVersion: 'duya.plugin.v2',
        id: 'com.duya.json-only',
        name: 'JsonOnly',
        version: '2.0.0',
        description: 'JSON only plugin.',
        author: { name: 'DUYA Team' },
        components: { mcpServers: [], skills: [], workflows: [], appConnections: [] },
        permissions: [],
        engines: { duya: '>=0.1.0' },
      }),
    );

    const result = readPluginManifestLenient(dir);
    expect(result.source).toBe('plugin.json');
    expect(result.manifest.schemaVersion).toBe('duya.plugin.v2');
    expect(result.manifest.components?.workflows).toEqual([]);
  });

  it('returns warnings when plugin.json is malformed', () => {
    writeFileSync(join(dir, 'plugin.json'), '{ not valid json }');

    const result = readPluginManifestLenient(dir);
    expect(result.source).toBe('plugin.json');
    expect(result.warnings.length).toBeGreaterThan(0);
    expect(result.manifest).toEqual({});
  });

  it('returns warnings (does not throw) when neither manifest exists', () => {
    const result = readPluginManifestLenient(dir);
    expect(result.source).toBe('plugin.json');
    expect(result.warnings.length).toBeGreaterThan(0);
    expect(result.manifest).toEqual({});
    expect(result.agentContext).toBe('');
  });
});
