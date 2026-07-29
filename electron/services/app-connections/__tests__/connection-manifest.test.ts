/**
 * connection-manifest.test.ts — Plan 312 Phase 2.
 *
 * Covers the lenient parser:
 *   - missing file → empty + source 'missing'
 *   - malformed JSON → empty + source 'error' + warning
 *   - valid array → declarations parsed, scopes/toolsets coerced
 *   - unknown provider → entry dropped with warning
 *   - missing required fields → entry dropped
 *   - non-array root (single object) → coerced to array
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';

vi.mock('../../../logging/logger', () => ({
  getLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
  LogComponent: {
    AppConnectionManifest: 'AppConnectionManifest',
  },
}));

import { parseConnectionsJson, readPluginAppConnections } from '../connection-manifest';

describe('parseConnectionsJson', () => {
  it('parses a valid array of declarations', () => {
    const result = parseConnectionsJson(JSON.stringify([
      {
        id: 'google-workspace',
        provider: 'google',
        scopes: ['drive.read', 'gmail.send'],
        toolsets: ['drive', 'gmail'],
        required: true,
      },
      {
        id: 'slack-workspace',
        provider: 'slack',
        scopes: ['search:read'],
      },
    ]));

    expect(result.source).toBe('file');
    expect(result.warnings).toEqual([]);
    expect(result.declarations).toHaveLength(2);
    expect(result.declarations[0]).toMatchObject({
      id: 'google-workspace',
      provider: 'google',
      scopes: ['drive.read', 'gmail.send'],
      toolsets: ['drive', 'gmail'],
      required: true,
    });
    // required defaults to true when omitted
    expect(result.declarations[1]!.required).toBe(true);
    // toolsets default to []
    expect(result.declarations[1]!.toolsets).toEqual([]);
  });

  it('rejects malformed JSON', () => {
    const result = parseConnectionsJson('{ not valid json');
    expect(result.source).toBe('error');
    expect(result.declarations).toEqual([]);
    expect(result.warnings[0]).toMatch(/not valid JSON/);
  });

  it('drops entries with unsupported provider', () => {
    const result = parseConnectionsJson(JSON.stringify([
      { id: 'ok', provider: 'google' },
      { id: 'bad', provider: 'twitter' },
    ]));
    expect(result.declarations).toHaveLength(1);
    expect(result.declarations[0]!.id).toBe('ok');
    expect(result.warnings.some((w) => w.includes('twitter'))).toBe(true);
  });

  it('drops entries with missing id', () => {
    const result = parseConnectionsJson(JSON.stringify([
      { provider: 'google' },
    ]));
    expect(result.declarations).toEqual([]);
    expect(result.warnings.some((w) => w.includes('"id"'))).toBe(true);
  });

  it('coerces non-array scopes to empty array + warning', () => {
    const result = parseConnectionsJson(JSON.stringify([
      { id: 'a', provider: 'google', scopes: 'not-an-array' },
    ]));
    expect(result.declarations[0]!.scopes).toEqual([]);
    expect(result.warnings.some((w) => w.includes('"scopes"'))).toBe(true);
  });

  it('coerces a single-object root into an array', () => {
    const result = parseConnectionsJson(JSON.stringify({ id: 'solo', provider: 'slack' }));
    expect(result.declarations).toHaveLength(1);
    expect(result.declarations[0]!.id).toBe('solo');
  });

  it('rejects non-object root (e.g. number)', () => {
    const result = parseConnectionsJson('42');
    expect(result.source).toBe('error');
    expect(result.declarations).toEqual([]);
  });

  it('accepts null/undefined root as empty', () => {
    expect(parseConnectionsJson('null').declarations).toEqual([]);
    // undefined is not valid JSON; parseConnectionsJson('undefined') would throw
  });
});

describe('readPluginAppConnections', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'duya-conn-manifest-'));
  });

  afterEach(() => {
    if (tempDir && fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('returns source=missing when file does not exist', () => {
    const result = readPluginAppConnections(tempDir);
    expect(result.source).toBe('missing');
    expect(result.declarations).toEqual([]);
  });

  it('reads + parses a valid file', () => {
    const appsDir = path.join(tempDir, 'apps');
    fs.mkdirSync(appsDir, { recursive: true });
    fs.writeFileSync(
      path.join(appsDir, 'connections.json'),
      JSON.stringify([{ id: 'g', provider: 'google', scopes: ['drive.read'] }]),
    );
    const result = readPluginAppConnections(tempDir);
    expect(result.source).toBe('file');
    expect(result.declarations).toHaveLength(1);
    expect(result.declarations[0]!.id).toBe('g');
  });

  it('returns source=error on bad JSON', () => {
    const appsDir = path.join(tempDir, 'apps');
    fs.mkdirSync(appsDir, { recursive: true });
    fs.writeFileSync(path.join(appsDir, 'connections.json'), '{ broken');
    const result = readPluginAppConnections(tempDir);
    expect(result.source).toBe('error');
    expect(result.declarations).toEqual([]);
  });
});
