/**
 * electron-binary.test.ts — regression tests for the Electron binary resolver.
 *
 * The defect these pin: the `build` CI job failed on all three OSes at
 * `preelectron:build` with "[abi] electron binary not found". The old resolver
 * read only `node_modules/electron/dist/` plus `path.txt`, but electron@44.2.0
 * ships no install script at all, so after a clean `npm ci` neither exists on
 * any platform. The resolver now asks the package itself (`require('electron')`),
 * which is both the supported answer and the step that produces the binary.
 *
 * The first test is the one that actually encodes the regression: a package
 * that is installed but not yet unpacked must RESOLVE (by materialising the
 * binary), not report "not found". Under the old code that case returned null
 * and the build exited 1.
 */
import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  MISSING_BINARY,
  MISSING_PACKAGE,
  resolveElectronBinary,
} from './electron-binary.mjs';

const created: string[] = [];

function makePackageDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'electron-pkg-'));
  created.push(dir);
  fs.writeFileSync(path.join(dir, 'package.json'), '{"name":"electron","version":"44.2.0"}\n', 'utf8');
  return dir;
}

/**
 * Stand-in for electron's `index.js`: returns the binary if it is on disk,
 * otherwise "downloads" it (writes `dist/` + `path.txt`) and returns that.
 * `name` is the platform-specific executable `path.txt` should record.
 */
function lazyInstallRequire(dir: string, name: string) {
  return (id: string): unknown => {
    if (id !== 'electron') throw new Error(`unexpected require(${id})`);
    const dist = path.join(dir, 'dist');
    const existing = path.join(dist, name);
    if (fs.existsSync(existing)) return existing;
    fs.mkdirSync(dist, { recursive: true });
    fs.writeFileSync(existing, 'binary', 'utf8');
    fs.writeFileSync(path.join(dir, 'path.txt'), name, 'utf8');
    return existing;
  };
}

afterEach(() => {
  while (created.length > 0) {
    const dir = created.pop();
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('resolveElectronBinary', () => {
  it('resolves a package that is installed but not yet unpacked', () => {
    // THE REGRESSION. Fresh `npm ci` state: package present, no dist/, no
    // path.txt. Before the fix this was reported as "binary not found" and
    // failed `electron:build` on all three runners.
    const dir = makePackageDir();
    expect(fs.existsSync(path.join(dir, 'dist'))).toBe(false);
    expect(fs.existsSync(path.join(dir, 'path.txt'))).toBe(false);

    const resolved = resolveElectronBinary({
      packageDir: dir,
      requireFn: lazyInstallRequire(dir, 'electron'),
      platform: 'linux',
    });

    expect(resolved.ok).toBe(true);
    if (!resolved.ok) throw new Error('expected the binary to resolve');
    expect(resolved.source).toBe('require');
    expect(resolved.binary).toBe(path.join(dir, 'dist', 'electron'));
  });

  it('resolves an already-unpacked package without re-resolving through require', () => {
    const dir = makePackageDir();
    const bin = path.join(dir, 'dist', 'electron');
    fs.mkdirSync(path.join(dir, 'dist'), { recursive: true });
    fs.writeFileSync(bin, 'binary', 'utf8');
    fs.writeFileSync(path.join(dir, 'path.txt'), 'electron', 'utf8');

    const resolved = resolveElectronBinary({
      packageDir: dir,
      // A require that throws proves the on-disk probe carried the result.
      requireFn: () => {
        throw new Error('should not be reached for an unpacked package');
      },
      platform: 'linux',
    });

    expect(resolved.ok).toBe(true);
    if (!resolved.ok) throw new Error('expected the binary to resolve');
    expect(resolved.source).toBe('path.txt');
    expect(resolved.binary).toBe(bin);
  });

  it('falls back to path.txt when require returns a non-path', () => {
    // `require('electron')` inside an Electron MAIN process exports the
    // module API object, not a path. The files on disk are the only answer.
    const dir = makePackageDir();
    const bin = path.join(dir, 'dist', 'electron');
    fs.mkdirSync(path.join(dir, 'dist'), { recursive: true });
    fs.writeFileSync(bin, 'binary', 'utf8');
    fs.writeFileSync(path.join(dir, 'path.txt'), 'electron', 'utf8');

    const resolved = resolveElectronBinary({
      packageDir: dir,
      requireFn: () => ({ app: {} }),
      platform: 'linux',
    });

    expect(resolved.ok).toBe(true);
    if (!resolved.ok) throw new Error('expected the binary to resolve');
    expect(resolved.source).toBe('path.txt');
    expect(resolved.binary).toBe(bin);
  });

  it('keeps the win32 .exe fallback for a bare path.txt pointer', () => {
    // path.txt records the bare name; spawnSync on win32 needs the suffix.
    const dir = makePackageDir();
    const bin = path.join(dir, 'dist', 'electron.exe');
    fs.mkdirSync(path.join(dir, 'dist'), { recursive: true });
    fs.writeFileSync(bin, 'binary', 'utf8');
    fs.writeFileSync(path.join(dir, 'path.txt'), 'electron', 'utf8');

    const resolved = resolveElectronBinary({
      packageDir: dir,
      requireFn: () => {
        throw new Error('offline');
      },
      platform: 'win32',
    });

    expect(resolved.ok).toBe(true);
    if (!resolved.ok) throw new Error('expected the binary to resolve');
    expect(resolved.binary).toBe(bin);
  });

  it('reports a missing package distinctly from a missing binary', () => {
    const resolved = resolveElectronBinary({ packageDir: null });
    expect(resolved.ok).toBe(false);
    if (resolved.ok) throw new Error('expected no resolution');
    expect(resolved.reason).toBe(MISSING_PACKAGE);
    expect(resolved.detail).toMatch(/not installed/);
  });

  it('surfaces the install failure instead of fabricating a path', () => {
    // The download failed. This must NOT resolve — an unverified target has
    // to stay visibly unverified so the caller can fail the build.
    const dir = makePackageDir();
    const resolved = resolveElectronBinary({
      packageDir: dir,
      requireFn: () => {
        throw new Error('getaddrinfo ENOTFOUND github.com');
      },
      platform: 'linux',
    });

    expect(resolved.ok).toBe(false);
    if (resolved.ok) throw new Error('expected no resolution');
    expect(resolved.reason).toBe(MISSING_BINARY);
    expect(resolved.detail).toMatch(/ENOTFOUND/);
  });
});
