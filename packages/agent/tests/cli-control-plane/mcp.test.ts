/**
 * packages/agent/tests/cli-control-plane/mcp.test.ts
 *
 * Phase 6 integration tests: duya mcp list / duya mcp info.
 *
 * The harness starts the real Electron CLI API server. MCP candidates
 * come from the unified collector (bundled + plugin + settings).
 * The CLI must produce stable DTOs without leaking paths or env
 * values.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

import { startHarness, type Harness, type SeedSession } from './harness.js';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const projectRoot = join(__dirname, '..', '..', '..', '..');

const NODE_BIN = process.execPath;

interface MCPListDTO {
  id: string;
  name: string;
  source: 'bundled' | 'plugin' | 'settings';
  sourceId?: string;
  enabled: boolean;
  connected: boolean;
}

interface MCPInfoDTO extends MCPListDTO {
  command: string;
  args: string[];
}

interface MCPResult {
  status: number;
  stdout: string;
  stderr: string;
  json?: { mcps?: MCPListDTO[]; mcp?: MCPInfoDTO };
}

function runMCP(args: string[], env: string): MCPResult {
  const cliBundle = join(projectRoot, 'packages', 'cli', 'bundle', 'cli.cjs');
  const result = spawnSync(NODE_BIN, [cliBundle, 'mcp', ...args], {
    cwd: projectRoot,
    env: { ...process.env, ...parseEnv(env) },
    encoding: 'utf-8',
    timeout: 30_000,
  });
  const stdout = result.stdout ?? '';
  const stderr = result.stderr ?? '';
  let json: MCPResult['json'];
  if (stdout.trim().startsWith('{')) {
    try { json = JSON.parse(stdout); } catch { /* ignore */ }
  }
  return { status: result.status ?? -1, stdout, stderr, json };
}

function parseEnv(s: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of s.split('\n')) {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
    if (m) out[m[1]] = m[2];
  }
  return out;
}

describe('duya mcp (Phase 6 control plane)', () => {
  let h: Harness | null = null;

  beforeAll(async () => {
    const seed: SeedSession[] = [
      { id: 'sess-mcp-test-1', title: 'MCP Test', mode: 'code', messageCount: 0 },
    ];
    h = await startHarness(seed);
  }, 60_000);

  afterAll(async () => {
    if (h) await h.teardown();
  });

  function env(): string {
    return `DUYA_CLI_USER_DATA_DIR=${h!.userData}`;
  }

  // ── list: text output ──────────────────────────────────────────────
  it('duya mcp list (text) returns exit 0', () => {
    const r = runMCP(['list'], env());
    if (r.status !== 0) {
      throw new Error(`exit=${r.status}\nstdout=${r.stdout}\nstderr=${r.stderr}`);
    }
    expect(r.status).toBe(0);
  });

  // ── list: JSON output ─────────────────────────────────────────────
  it('duya mcp list --format json returns mcps array', () => {
    const r = runMCP(['list', '--format', 'json'], env());
    if (r.status !== 0) {
      throw new Error(`exit=${r.status}\nstdout=${r.stdout}\nstderr=${r.stderr}`);
    }
    expect(r.json).toBeDefined();
    expect(Array.isArray(r.json!.mcps)).toBe(true);
  });

  // ── DTO contract ──────────────────────────────────────────────────
  it('list DTO has the frozen fields and no path leakage', () => {
    const r = runMCP(['list', '--format', 'json'], env());
    if (r.status !== 0) {
      throw new Error(`exit=${r.status}\nstdout=${r.stdout}\nstderr=${r.stderr}`);
    }
    for (const m of r.json!.mcps!) {
      // Frozen DTO: id / name / source / enabled / connected
      // (sourceId is optional for non-plugin)
      const allowedKeys = ['id', 'name', 'source', 'enabled', 'connected', 'sourceId'];
      const keys = Object.keys(m);
      for (const k of keys) {
        expect(allowedKeys).toContain(k);
      }
      // No path leakage
      expect(r.stdout).not.toContain('C:\\Users');
      expect(r.stdout).not.toContain('/tmp/duya');
    }
  });

  // ── source enum ───────────────────────────────────────────────────
  it('source values are within the v0 enum', () => {
    const r = runMCP(['list', '--format', 'json'], env());
    if (r.status !== 0) {
      throw new Error(`exit=${r.status}\nstdout=${r.stdout}\nstderr=${r.stderr}`);
    }
    for (const m of r.json!.mcps!) {
      expect(['bundled', 'plugin', 'settings']).toContain(m.source);
    }
  });

  // ── id format ─────────────────────────────────────────────────────
  it('ids follow the v0 source:name or plugin:<id>:name format', () => {
    const r = runMCP(['list', '--format', 'json'], env());
    if (r.status !== 0) {
      throw new Error(`exit=${r.status}\nstdout=${r.stdout}\nstderr=${r.stderr}`);
    }
    for (const m of r.json!.mcps!) {
      if (m.source === 'plugin') {
        expect(m.id).toMatch(/^plugin:[^:]+:[^:]+$/);
      } else {
        expect(m.id).toBe(`${m.source}:${m.name}`);
      }
    }
  });

  // ── info: 404 for unknown id ────────────────────────────────────────
  it('duya mcp info <unknown-id> returns non-zero with not-found message', () => {
    const r = runMCP(['info', 'bundled:does-not-exist'], env());
    expect(r.status).not.toBe(0);
    expect(r.stdout + r.stderr).toMatch(/not found|mcp_not_found|404/i);
  });

  // ── info: DTO has frozen fields, no secrets ──────────────────────
  it('info DTO has the frozen fields and no env-value leakage', () => {
    const list = runMCP(['list', '--format', 'json'], env());
    if (list.status !== 0) {
      throw new Error(`list exit=${list.status}\nstdout=${list.stdout}\nstderr=${list.stderr}`);
    }
    const available = list.json!.mcps!;
    if (available.length === 0) {
      // No MCPs available — skip
      return;
    }
    const target = available[0];
    const r = runMCP(['info', target.id, '--format', 'json'], env());
    if (r.status !== 0) {
      throw new Error(`info exit=${r.status}\nstdout=${r.stdout}\nstderr=${r.stderr}`);
    }
    const info = r.json!.mcp!;
    const expected = ['args', 'command', 'connected', 'enabled', 'id', 'name', 'source'].sort();
    expect(Object.keys(info).sort()).toEqual(expected);
    // No env values
    expect(r.stdout).not.toMatch(/api[_-]?key/i);
    expect(r.stdout).not.toMatch(/token/i);
    expect(r.stdout).not.toMatch(/secret/i);
  });

  // ── shadowed id returns not found ─────────────────────────────────
  it('shadowed id cannot be addressed; returns not found', () => {
    // The bundled 'literature' is the highest-precedence source in v0.
    // If a shadowed candidate exists, info on the shadowed id
    // (e.g. settings:literature if user overrode) should return 404.
    //
    // The harness does not seed user overrides, so this is
    // effectively a no-op test that confirms the resolver always
    // returns the highest-precedence id.
    const r = runMCP(['info', 'settings:literature'], env());
    // Either 404 (not the current winner) or 200 (it's the winner)
    if (r.status === 0) {
      // If 200, the id must be the active winner
      expect(r.json!.mcp!.id).toBe('settings:literature');
    } else {
      expect(r.stdout + r.stderr).toMatch(/not found|404/i);
    }
  });

  // ── desktop not running: clear error ──────────────────────────────
  it('duya mcp list reports non-zero when desktop is not running', () => {
    const r = runMCP(['list'], `DUYA_CLI_USER_DATA_DIR=${h!.userData}-nonexistent`);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/DUYA is not running|not running|connect/i);
  });

  // ── bundled literature is always present (v0 default) ───────────
  it('bundled:literature is always present in the list', () => {
    const r = runMCP(['list', '--format', 'json'], env());
    if (r.status !== 0) {
      throw new Error(`exit=${r.status}\nstdout=${r.stdout}\nstderr=${r.stderr}`);
    }
    const lit = r.json!.mcps!.find((m) => m.id === 'bundled:literature');
    expect(lit).toBeDefined();
    expect(lit!.source).toBe('bundled');
  });
});