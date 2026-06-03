/**
 * packages/agent/tests/cli-control-plane/installCli.test.ts
 *
 * Phase install-cli: integration tests for `duya install-cli` /
 * `duya uninstall-cli`.
 *
 * The harness starts the real Electron CLI API server. The main
 * process resolves the bundled `cli.cjs` (dev fallback: repo's
 * `packages/agent/bundle/cli.cjs`) and writes the wrapper to
 * `~/.local/bin/duya` (POSIX) or `%LOCALAPPDATA%\duya\bin\duya.cmd`
 * (Windows). PATH is updated on Windows via `setx`.
 *
 * Tests are written to be POSIX-safe by default. Windows-specific
 * PATH mutation is exercised by the installer's own logic; the
 * CLI test surface only verifies the wrapper file was created and
 * the message is correct.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { homedir, platform } from 'node:os';

import { startHarness, type Harness, type SeedSession } from './harness.js';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const projectRoot = join(__dirname, '..', '..', '..', '..');

const NODE_BIN = process.execPath;

interface InstallResult {
  ok: boolean;
  platform: string;
  paths: {
    binDir: string;
    wrapper: string;
    bundle: string;
    userDataDir: string;
  };
  message: string;
}

interface RunResult {
  status: number;
  stdout: string;
  stderr: string;
  json?: InstallResult;
}

function runCli(args: string[], env: string): RunResult {
  const cliBundle = join(projectRoot, 'packages', 'agent', 'bundle', 'cli.cjs');
  const result = spawnSync(NODE_BIN, [cliBundle, ...args], {
    cwd: projectRoot,
    env: { ...process.env, ...parseEnv(env) },
    encoding: 'utf-8',
    timeout: 30_000,
  });
  const stdout = result.stdout ?? '';
  const stderr = result.stderr ?? '';
  let json: RunResult['json'];
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

describe('duya install-cli (cross-platform CLI install)', () => {
  let h: Harness | null = null;

  beforeAll(async () => {
    const seed: SeedSession[] = [
      { id: 'sess-install-cli', title: 'Install CLI', mode: 'code', messageCount: 0 },
    ];
    h = await startHarness(seed);
  }, 60_000);

  afterAll(async () => {
    if (h) await h.teardown();
  });

  function env(): string {
    return `DUYA_CLI_USER_DATA_DIR=${h!.userData}`;
  }

  // ── install ────────────────────────────────────────────────────────
  it('duya install-cli (json) writes the wrapper script', () => {
    const r = runCli(['install-cli', '--format', 'json'], env());
    if (r.status !== 0) {
      throw new Error(`exit=${r.status}\nstdout=${r.stdout}\nstderr=${r.stderr}`);
    }
    expect(r.json).toBeDefined();
    expect(r.json!.ok).toBe(true);
    expect(['win32', 'darwin', 'linux']).toContain(r.json!.platform);
    expect(r.json!.paths.wrapper).toBeTruthy();
    expect(existsSync(r.json!.paths.wrapper)).toBe(true);
  });

  // ── wrapper script is executable on POSIX ──────────────────────────
  it('wrapper script is executable on POSIX', () => {
    if (platform() === 'win32') {
      // Windows .cmd files don't have POSIX exec bits
      return;
    }
    const r = runCli(['install-cli', '--format', 'json'], env());
    if (r.status !== 0) {
      throw new Error(`install-cli failed: ${r.status}`);
    }
    const st = statSync(r.json!.paths.wrapper);
    // Owner-execute bit must be set
    expect((st.mode & 0o100) !== 0).toBe(true);
  });

  // ── wrapper invokes the bundled cli.cjs ──────────────────────────
  it('wrapper script content references the bundled cli.cjs', () => {
    const r = runCli(['install-cli', '--format', 'json'], env());
    if (r.status !== 0) {
      throw new Error(`install-cli failed`);
    }
    const content = readFileSync(r.json!.paths.wrapper, 'utf-8');
    expect(content).toMatch(/cli\.cjs/);
    expect(content).toMatch(/DUYA_CLI_USER_DATA_DIR/);
  });

  // ── idempotent: re-install does not fail ──────────────────────────
  it('duya install-cli is idempotent (re-running succeeds)', () => {
    const r1 = runCli(['install-cli', '--format', 'json'], env());
    if (r1.status !== 0) {
      throw new Error(`first install failed`);
    }
    const r2 = runCli(['install-cli', '--format', 'json'], env());
    if (r2.status !== 0) {
      throw new Error(`second install failed: ${r2.status}\nstdout=${r2.stdout}\nstderr=${r2.stderr}`);
    }
    expect(r2.json!.ok).toBe(true);
  });

  // ── text output ────────────────────────────────────────────────────
  it('duya install-cli (text) returns human-readable output', () => {
    const r = runCli(['install-cli'], env());
    if (r.status !== 0) {
      throw new Error(`exit=${r.status}\nstdout=${r.stdout}\nstderr=${r.stderr}`);
    }
    expect(r.stdout).toMatch(/Installed|Wrapper|platform/i);
  });

  // ── uninstall ──────────────────────────────────────────────────────
  it('duya uninstall-cli removes the wrapper', () => {
    // First ensure installed
    runCli(['install-cli'], env());
    const r = runCli(['uninstall-cli', '--format', 'json'], env());
    if (r.status !== 0) {
      throw new Error(`exit=${r.status}\nstdout=${r.stdout}\nstderr=${r.stderr}`);
    }
    expect(r.json).toBeDefined();
    expect(r.json!.ok).toBe(true);
    expect(existsSync(r.json!.paths.wrapper)).toBe(false);
  });

  // ── uninstall is idempotent ────────────────────────────────────────
  it('duya uninstall-cli is idempotent (missing wrapper is not an error)', () => {
    const r = runCli(['uninstall-cli', '--format', 'json'], env());
    if (r.status !== 0) {
      throw new Error(`exit=${r.status}\nstdout=${r.stdout}\nstderr=${r.stderr}`);
    }
    expect(r.json!.ok).toBe(true);
  });

  // ── desktop not running: clear error ──────────────────────────────
  it('duya install-cli reports non-zero when desktop is not running', () => {
    const r = runCli(['install-cli'], `DUYA_CLI_USER_DATA_DIR=${h!.userData}-nonexistent`);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/DUYA is not running|not running|connect/i);
  });

  // ── safety: bundle path is absolute ──────────────────────────────
  it('bundle path in the install result is absolute', () => {
    const r = runCli(['install-cli', '--format', 'json'], env());
    if (r.status !== 0) {
      throw new Error(`install-cli failed`);
    }
    const bundle = r.json!.paths.bundle;
    if (bundle) {
      // POSIX starts with /; Windows starts with a drive letter
      if (platform() !== 'win32') {
        expect(bundle.startsWith('/')).toBe(true);
      } else {
        expect(bundle).toMatch(/^[A-Z]:\\/);
      }
    }
  });
});