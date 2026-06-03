// packages/agent/tests/mcp/resolve-bundled.test.ts
// Unit tests for `resolveBundledMCPServerConfigs()` re-exported from
// `plugin-mcp-runtime.ts`.
//
// Phase 1C amend: the function used to live in `agent-process-entry.ts`
// and was deleted when the init path switched to
// `loadAndResolveMCPServers()`. The reload path, which still uses the
// legacy `discover*` functions, silently lost the bundled fallback as
// a result. We restore the function in `plugin-mcp-runtime.ts` with
// byte-equivalent behavior. These tests pin that equivalence so any
// future drift is caught.
//
// We do NOT touch `process.resourcesPath` — that would require
// mutating a global on the Node process. Instead we exercise the two
// observable branches of the function:
//   1. Bundle script exists at the expected path -> returns one config
//      with `name: 'literature'`, `process.execPath` as command, the
//      bundle path as args[0], and the env wiring.
//   2. Bundle script missing at the expected path -> returns an empty
//      array (warns via console.warn).
//
// The packaged-vs-dev `isPackaged` branch is exercised implicitly: the
// default `process.resourcesPath` is empty in the test runner, so the
// function takes the dev branch (`cwd/packages/agent/bundle/...`).
// That is the only branch the test harness can realistically reach
// without mutating globals.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  resolveBundledMCPServerConfigs,
} from '../../src/process/plugin-mcp-runtime.js';

describe('resolveBundledMCPServerConfigs — bundle file present', () => {
  let tmp: string;
  let prevCwd: string;
  let bundleDir: string;
  let bundlePath: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'duya-bundled-'));
    prevCwd = process.cwd();
    // Replicate the dev layout the function looks for:
    //   `<cwd>/packages/agent/bundle/literature-mcp-server.js`
    bundleDir = join(tmp, 'packages', 'agent', 'bundle');
    mkdirSync(bundleDir, { recursive: true });
    bundlePath = join(bundleDir, 'literature-mcp-server.js');
    writeFileSync(bundlePath, '// real bundle stub');
    process.chdir(tmp);
  });

  afterEach(() => {
    process.chdir(prevCwd);
    rmSync(tmp, { recursive: true, force: true });
  });

  it('returns one MCPServerConfig with name=literature and the bundle path as args[0]', () => {
    const configs = resolveBundledMCPServerConfigs();
    expect(configs).toHaveLength(1);
    expect(configs[0].name).toBe('literature');
    expect(configs[0].command).toBe(process.execPath);
    expect(configs[0].args[0]).toBe(bundlePath);
  });

  it('wires the `--db-path` flag with the DUYA_CUSTOM_DB_PATH env var (or empty)', () => {
    const prev = process.env.DUYA_CUSTOM_DB_PATH;
    try {
      process.env.DUYA_CUSTOM_DB_PATH = '/tmp/custom.db';
      const configs = resolveBundledMCPServerConfigs();
      // The flag is added by the function; the value is the env var.
      // args[0] is the bundle path; args[1] is '--db-path'; args[2] is
      // the value.
      expect(configs[0].args[1]).toBe('--db-path');
      expect(configs[0].args[2]).toBe('/tmp/custom.db');
    } finally {
      if (prev === undefined) {
        delete process.env.DUYA_CUSTOM_DB_PATH;
      } else {
        process.env.DUYA_CUSTOM_DB_PATH = prev;
      }
    }
  });

  it('wires DUYA_BETTER_SQLITE3_PATH from the current process env', () => {
    const prev = process.env.DUYA_BETTER_SQLITE3_PATH;
    try {
      process.env.DUYA_BETTER_SQLITE3_PATH = '/tmp/better.db';
      const configs = resolveBundledMCPServerConfigs();
      expect(configs[0].env?.DUYA_BETTER_SQLITE3_PATH).toBe('/tmp/better.db');
    } finally {
      if (prev === undefined) {
        delete process.env.DUYA_BETTER_SQLITE3_PATH;
      } else {
        process.env.DUYA_BETTER_SQLITE3_PATH = prev;
      }
    }
  });
});

describe('resolveBundledMCPServerConfigs — bundle file missing', () => {
  let tmp: string;
  let prevCwd: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'duya-bundled-empty-'));
    prevCwd = process.cwd();
    // We chdir into an empty tmp dir; the function will look for
    // `<cwd>/packages/agent/bundle/literature-mcp-server.js` and not
    // find it.
    process.chdir(tmp);
  });

  afterEach(() => {
    process.chdir(prevCwd);
    rmSync(tmp, { recursive: true, force: true });
  });

  it('returns an empty array when the bundle script is not at the expected path', () => {
    // Silence the expected warn so the test output stays clean.
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const configs = resolveBundledMCPServerConfigs();
      expect(configs).toEqual([]);
      // The function should have warned at least once with the path.
      const warned = warnSpy.mock.calls.some((c) =>
        String(c[0] ?? '').includes('Literature MCP server bundle not found'),
      );
      expect(warned).toBe(true);
    } finally {
      warnSpy.mockRestore();
    }
  });
});
