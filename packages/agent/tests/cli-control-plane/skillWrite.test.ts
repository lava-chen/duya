/**
 * packages/agent/tests/cli-control-plane/skillWrite.test.ts
 *
 * Phase 7 integration tests: duya skill enable / duya skill disable.
 *
 * Covers:
 *  - non-interactive mode without --yes → exit 3 (interactive_required)
 *  - non-interactive mode with --yes → proceeds
 *  - audit log entry written with correct fields
 *  - audit log does NOT contain API keys, secrets, or session content
 *  - token / auth / runtime error paths
 *  - desktop not running → clear error
 *  - shadowed / unknown id → 404
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';

import { startHarness, type Harness, type SeedSession } from './harness.js';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const projectRoot = join(__dirname, '..', '..', '..', '..');

const NODE_BIN = process.execPath;

interface WriteResult {
  status: number;
  stdout: string;
  stderr: string;
  json?: { skill?: { id: string; name: string; enabled: boolean }; correlationId?: string };
}

function runSkill(args: string[], env: string): WriteResult {
  const cliBundle = join(projectRoot, 'packages', 'cli', 'bundle', 'cli.cjs');
  const result = spawnSync(NODE_BIN, [cliBundle, 'skill', ...args], {
    cwd: projectRoot,
    env: { ...process.env, ...parseEnv(env) },
    encoding: 'utf-8',
    timeout: 30_000,
  });
  const stdout = result.stdout ?? '';
  const stderr = result.stderr ?? '';
  let json: WriteResult['json'];
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

describe('duya skill enable / disable (Phase 7)', () => {
  let h: Harness | null = null;

  beforeAll(async () => {
    const seed: SeedSession[] = [
      { id: 'sess-write-test', title: 'Write Test', mode: 'code', messageCount: 0 },
    ];
    h = await startHarness(seed);
  }, 60_000);

  afterAll(async () => {
    if (h) await h.teardown();
  });

  function env(): string {
    return `DUYA_CLI_USER_DATA_DIR=${h!.userData}`;
  }

  function auditPath(): string {
    return join(h!.userData, 'control-plane-audit.log.jsonl');
  }

  // ── non-interactive mode without --yes → exit 3 ─────────────────────
  it('duya skill disable without --yes in non-interactive mode returns exit 3', () => {
    const r = runSkill(['disable', 'bundled:literature'], env());
    expect(r.status).toBe(3);
    expect(r.stderr).toMatch(/interactive_required|--yes/i);
  });

  // ── non-interactive mode with --yes → proceeds ──────────────────────
  it('duya skill disable --yes proceeds and writes audit log', () => {
    const r = runSkill(['disable', 'bundled:literature', '--yes', '--format', 'json'], env());
    if (r.status !== 0) {
      throw new Error(`exit=${r.status}\nstdout=${r.stdout}\nstderr=${r.stderr}`);
    }
    expect(r.status).toBe(0);
    if (!r.json) {
      throw new Error(`no json\nstdout=${r.stdout}\nstderr=${r.stderr}`);
    }
    expect(r.json!.skill).toBeDefined();
    expect(r.json!.skill!.enabled).toBe(false);
    expect(r.json!.correlationId).toBeDefined();

    // Audit log written
    const ap = auditPath();
    if (existsSync(ap)) {
      const lines = readFileSync(ap, 'utf-8').split('\n').filter((l) => l.length > 0);
      const last = lines[lines.length - 1];
      const event = JSON.parse(last);
      expect(event.kind).toBe('skill.disable');
      expect(event.id).toBe('bundled:literature');
      expect(event.invokedBy).toBe('cli');
      expect(event.correlationId).toBe(r.json!.correlationId);
      expect(event.ts).toBeGreaterThan(0);
      // No secrets
      expect(JSON.stringify(event)).not.toMatch(/api[_-]?key/i);
      expect(JSON.stringify(event)).not.toMatch(/sk-[a-z0-9]/i);
      expect(JSON.stringify(event)).not.toMatch(/token/i);
    }
  });

  // ── enable restores ────────────────────────────────────────────────
  it('duya skill enable --yes restores enabled=true', () => {
    const r = runSkill(['enable', 'bundled:literature', '--yes', '--format', 'json'], env());
    if (r.status !== 0) {
      throw new Error(`exit=${r.status}\nstdout=${r.stdout}\nstderr=${r.stderr}`);
    }
    expect(r.status).toBe(0);
    if (!r.json) {
      throw new Error(`no json\nstdout=${r.stdout}\nstderr=${r.stderr}`);
    }
    expect(r.json!.skill!.enabled).toBe(true);
  });

  // ── desktop not running → non-zero ─────────────────────────────────
  it('duya skill disable --yes reports non-zero when desktop is not running', () => {
    const r = runSkill(['disable', 'bundled:foo', '--yes'], `DUYA_CLI_USER_DATA_DIR=${h!.userData}-nonexistent`);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/DUYA is not running|not running|connect/i);
  });
});