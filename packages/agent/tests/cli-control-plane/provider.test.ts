/**
 * packages/agent/tests/cli-control-plane/provider.test.ts
 *
 * Phase 4 integration tests: duya provider list / duya provider info.
 *
 * The harness starts the real Electron CLI API server. The config
 * manager returns ApiProvider[] from the settings.json. The CLI
 * must produce redacted DTOs (no API keys in any output).
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

import { startHarness, type Harness, type SeedSession } from './harness.js';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const projectRoot = join(__dirname, '..', '..', '..', '..');

const NODE_BIN = process.execPath;

interface ProviderListDTO {
  id: string;
  name: string;
  providerType: string;
  isActive: boolean;
  hasKey: boolean;
  model?: string;
  baseUrl?: string;
  notes?: string;
  sortOrder?: number;
}

interface ProviderInfoDTO extends ProviderListDTO {
  headers: Record<string, string>;
  extraEnvKeys: string[];
}

interface ProviderResult {
  status: number;
  stdout: string;
  stderr: string;
  json?: { providers?: ProviderListDTO[]; provider?: ProviderInfoDTO };
}

function runProvider(args: string[], env: string): ProviderResult {
  const cliBundle = join(projectRoot, 'packages', 'cli', 'bundle', 'cli.cjs');
  const result = spawnSync(NODE_BIN, [cliBundle, 'provider', ...args], {
    cwd: projectRoot,
    env: { ...process.env, ...parseEnv(env) },
    encoding: 'utf-8',
    timeout: 30_000,
  });
  const stdout = result.stdout ?? '';
  const stderr = result.stderr ?? '';
  let json: ProviderResult['json'];
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

describe('duya provider (Phase 4 control plane)', () => {
  let h: Harness | null = null;

  beforeAll(async () => {
    const seed: SeedSession[] = [
      { id: 'sess-provider-test', title: 'Provider Test', mode: 'code', messageCount: 0 },
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
  it('duya provider list (text) returns exit 0', () => {
    const r = runProvider(['list'], env());
    if (r.status !== 0) {
      throw new Error(`exit=${r.status}\nstdout=${r.stdout}\nstderr=${r.stderr}`);
    }
    expect(r.status).toBe(0);
  });

  // ── list: JSON output ─────────────────────────────────────────────
  it('duya provider list --format json returns providers array', () => {
    const r = runProvider(['list', '--format', 'json'], env());
    if (r.status !== 0) {
      throw new Error(`exit=${r.status}\nstdout=${r.stdout}\nstderr=${r.stderr}`);
    }
    expect(r.json).toBeDefined();
    expect(Array.isArray(r.json!.providers)).toBe(true);
  });

  // ── DTO contract: no API keys, no secrets ──────────────────────────
  it('list DTO has the frozen fields and no API key leakage', () => {
    const r = runProvider(['list', '--format', 'json'], env());
    if (r.status !== 0) {
      throw new Error(`exit=${r.status}\nstdout=${r.stdout}\nstderr=${r.stderr}`);
    }
    for (const p of r.json!.providers!) {
      // Frozen DTO fields: id / name / providerType / isActive / hasKey
      // (model / baseUrl / notes / sortOrder optional)
      const allowedKeys = ['id', 'name', 'providerType', 'isActive', 'hasKey', 'model', 'baseUrl', 'notes', 'sortOrder'];
      const keys = Object.keys(p);
      for (const k of keys) {
        expect(allowedKeys).toContain(k);
      }
      // No apiKey field
      expect(p).not.toHaveProperty('apiKey');
      expect(p).not.toHaveProperty('extraEnv');
      // No raw key leak in stdout
      expect(r.stdout).not.toMatch(/sk-[a-z0-9]/i);
      expect(r.stdout).not.toMatch(/api[_-]?key/i);
    }
  });

  // ── providerType enum ─────────────────────────────────────────────
  it('providerType values are within the v0 enum', () => {
    const r = runProvider(['list', '--format', 'json'], env());
    if (r.status !== 0) {
      throw new Error(`exit=${r.status}\nstdout=${r.stdout}\nstderr=${r.stderr}`);
    }
    const valid = ['anthropic', 'openai', 'ollama', 'openai-compatible', 'openrouter', 'bedrock', 'vertex', 'gemini-image', 'google'];
    for (const p of r.json!.providers!) {
      expect(valid).toContain(p.providerType);
    }
  });

  // ── isActive: at most one provider should be active ───────────────
  it('at most one provider has isActive: true', () => {
    const r = runProvider(['list', '--format', 'json'], env());
    if (r.status !== 0) {
      throw new Error(`exit=${r.status}\nstdout=${r.stdout}\nstderr=${r.stderr}`);
    }
    const active = r.json!.providers!.filter((p) => p.isActive);
    expect(active.length).toBeLessThanOrEqual(1);
  });

  // ── info: 404 for unknown id ────────────────────────────────────────
  it('duya provider info <unknown-id> returns non-zero with not-found message', () => {
    const r = runProvider(['info', 'does-not-exist-12345'], env());
    expect(r.status).not.toBe(0);
    expect(r.stdout + r.stderr).toMatch(/not found|provider_not_found|404/i);
  });

  // ── info: DTO has frozen fields, no secrets ────────────────────────
  it('info DTO has the frozen fields and no env-value leakage', () => {
    const list = runProvider(['list', '--format', 'json'], env());
    if (list.status !== 0) {
      throw new Error(`list exit=${list.status}\nstdout=${list.stdout}\nstderr=${list.stderr}`);
    }
    const available = list.json!.providers!;
    if (available.length === 0) {
      // No providers seeded — skip
      return;
    }
    const target = available[0];
    const r = runProvider(['info', target.id, '--format', 'json'], env());
    if (r.status !== 0) {
      throw new Error(`info exit=${r.status}\nstdout=${r.stdout}\nstderr=${r.stderr}`);
    }
    const info = r.json!.provider!;
    const allowed = ['baseUrl', 'hasKey', 'headers', 'id', 'isActive', 'model', 'name', 'notes', 'providerType', 'sortOrder', 'extraEnvKeys'].sort();
    expect(Object.keys(info).sort()).toEqual(allowed);
    // No raw env values
    expect(r.stdout).not.toMatch(/sk-[a-z0-9]/i);
    expect(r.stdout).not.toMatch(/api[_-]?key/i);
  });

  // ── desktop not running: clear error ──────────────────────────────
  it('duya provider list reports non-zero when desktop is not running', () => {
    const r = runProvider(['list'], `DUYA_CLI_USER_DATA_DIR=${h!.userData}-nonexistent`);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/DUYA is not running|not running|connect/i);
  });
});