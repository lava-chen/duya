// electron/plugins/manifest.test.ts
// Plan 311 — Phase 4: v2 manifest parsing & v1 compatibility tests.
//
// Covers `readPluginManifest` for:
// - v1 manifests parse unchanged (zero migration)
// - v2 manifests parse `components` / `permissionPolicy` / `publisher`
// - v2 manifests can omit `capabilities` in favour of `components`
// - Unsupported schemaVersion is rejected
// - `readPluginManifestLenient` degrades gracefully on malformed JSON

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'fs';
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

  it('parses a v2 manifest with a partial permissionPolicy', () => {
    writeFileSync(
      join(dir, 'plugin.json'),
      JSON.stringify({
        schemaVersion: 'duya.plugin.v2',
        id: 'com.duya.v2-partial-policy',
        name: 'PartialPolicy',
        version: '2.0.0',
        description: 'Partial policy.',
        author: { name: 'DUYA Team' },
        components: { mcpServers: [], skills: [], workflows: [], appConnections: [] },
        permissionPolicy: {
          writeActionsRequireApproval: true,
        },
        permissions: [],
        engines: { duya: '>=0.1.0' },
      }),
    );

    const manifest = readPluginManifest(dir);
    expect(manifest.permissionPolicy?.writeActionsRequireApproval).toBe(true);
    expect(manifest.permissionPolicy?.defaultMode).toBeUndefined();
    expect(manifest.permissionPolicy?.destructiveActionsRequireApproval).toBeUndefined();
  });

  it('rejects an invalid permissionPolicy.defaultMode', () => {
    writeFileSync(
      join(dir, 'plugin.json'),
      JSON.stringify({
        schemaVersion: 'duya.plugin.v2',
        id: 'com.duya.v2-bad-mode',
        name: 'BadMode',
        version: '2.0.0',
        description: 'Bad mode.',
        author: { name: 'DUYA Team' },
        components: { mcpServers: [], skills: [], workflows: [], appConnections: [] },
        permissionPolicy: {
          defaultMode: 'admin',
        },
        permissions: [],
        engines: { duya: '>=0.1.0' },
      }),
    );

    // The parser does not throw — it silently drops the invalid value.
    // This is consistent with the lenient v2 parsing philosophy.
    const manifest = readPluginManifest(dir);
    expect(manifest.permissionPolicy?.defaultMode).toBeUndefined();
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
// readPluginManifestLenient — graceful degradation
// ----------------------------------------------------------------------------

describe('readPluginManifestLenient — v1/v2 fallback', () => {
  it('reads a plugin.md and returns a v1-shaped partial manifest', () => {
    writeFileSync(
      join(dir, 'plugin.md'),
      '---\nname: my-plugin\ndescription: A plugin from markdown.\n---\n\nThis is the agent context body.\n',
    );

    const result = readPluginManifestLenient(dir);
    expect(result.source).toBe('plugin.md');
    expect(result.manifest.schemaVersion).toBe('duya.plugin.v1');
    expect(result.manifest.name).toBe('my-plugin');
    expect(result.agentContext).toBe('This is the agent context body.');
  });

  it('falls back to plugin.json when plugin.md is absent', () => {
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

  it('throws when neither plugin.md nor plugin.json exists', () => {
    expect(() => readPluginManifestLenient(dir)).toThrow();
  });
});
