/**
 * ensure-sqlite-abi.test.ts — regression tests for the ABI marker cache.
 *
 * ## The defect these pin
 *
 * `scripts/ensure-sqlite-abi.mjs` skips its real probe (spawning the target
 * runtime and opening an in-memory database) when a marker file matches. The
 * marker was keyed on `mtime || 0` of `build/Release/better_sqlite3.node`, and
 * `fs.existsSync(...) ? mtimeMs : 0` makes "absent" indistinguishable from "an
 * epoch-mtime file". So a marker written while the binding was unloadable kept
 * matching on every later run, and each `pretest` / `preelectron:*` reported a
 * green ABI for a database that could not be opened.
 *
 * ## Why the fix is a fingerprint over every candidate, not one path
 *
 * better-sqlite3 >= 12 is an N-API addon. `lib/binding.js` resolves
 * `prebuilds/<platform>-<arch>.node` FIRST and only falls back to the node-gyp
 * outputs under `build/`, so on a stock install `build/Release/` does not exist
 * at all while the module loads fine. Keying only on that path fails in both
 * directions, and the two cases are asserted separately below:
 *
 *   - "absent means broken" → false RED on a healthy install (test 2);
 *   - "absent means unchanged" → false GREEN on a broken install (test 1).
 */
import { afterEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const created: string[] = [];

interface Fixture {
  root: string;
  script: string;
  markerPath: string;
  prebuild: string;
}

/**
 * Stand-in for `better-sqlite3`. It mirrors the real loader's requirement —
 * a `.node` artifact has to exist somewhere it would look — so a fixture with
 * no artifacts genuinely fails to load, and a fixture with a prebuild
 * genuinely succeeds even though `build/Release/` is empty.
 */
function stubSource(): string {
  return `
const fs = require('fs');
const path = require('path');
const cands = [];
const pd = path.join(__dirname, 'prebuilds');
if (fs.existsSync(pd)) for (const f of fs.readdirSync(pd)) if (f.endsWith('.node')) cands.push(path.join(pd, f));
cands.push(path.join(__dirname, 'build', 'Release', 'better_sqlite3.node'));
cands.push(path.join(__dirname, 'build', 'Debug', 'better_sqlite3.node'));
const found = cands.find((p) => fs.existsSync(p));
if (!found) throw new Error('Could not locate the bindings file. Tried: ' + cands.join(', '));
module.exports = class Database {
  constructor() {}
  exec() {}
  prepare() { return { get: () => ({}) }; }
};
`;
}

function makeFixture(opts: { prebuild?: boolean; nodeGyp?: boolean } = {}): Fixture {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'abi-fixture-'));
  created.push(root);
  fs.mkdirSync(path.join(root, 'scripts'), { recursive: true });
  fs.copyFileSync(path.join(scriptDir, 'ensure-sqlite-abi.mjs'), path.join(root, 'scripts', 'ensure-sqlite-abi.mjs'));
  fs.copyFileSync(path.join(scriptDir, 'electron-binary.mjs'), path.join(root, 'scripts', 'electron-binary.mjs'));

  const pkgDir = path.join(root, 'node_modules', 'better-sqlite3');
  fs.mkdirSync(pkgDir, { recursive: true });
  fs.writeFileSync(
    path.join(pkgDir, 'package.json'),
    JSON.stringify({ name: 'better-sqlite3', version: '13.0.3', main: 'index.js' }),
    'utf8',
  );
  fs.writeFileSync(path.join(pkgDir, 'index.js'), stubSource(), 'utf8');

  const prebuild = path.join(pkgDir, 'prebuilds', `${process.platform}-${process.arch}.node`);
  if (opts.prebuild) {
    fs.mkdirSync(path.dirname(prebuild), { recursive: true });
    fs.writeFileSync(prebuild, 'prebuilt-binding', 'utf8');
  }
  if (opts.nodeGyp) {
    const out = path.join(pkgDir, 'build', 'Release', 'better_sqlite3.node');
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, 'node-gyp-binding', 'utf8');
  }

  return {
    root,
    script: path.join(root, 'scripts', 'ensure-sqlite-abi.mjs'),
    markerPath: path.join(root, 'node_modules', '.better-sqlite3-abi.json'),
    prebuild,
  };
}

function run(fixture: Fixture, target: string) {
  return spawnSync(process.execPath, [fixture.script, target], {
    cwd: fixture.root,
    encoding: 'utf8',
    timeout: 60_000,
  });
}

function readMarker(fixture: Fixture): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(fixture.markerPath, 'utf8')) as Record<string, unknown>;
}

afterEach(() => {
  while (created.length > 0) {
    const dir = created.pop();
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('ensure-sqlite-abi marker cache', () => {
  it('re-probes when a binding artifact disappears instead of trusting a stale marker', () => {
    const fixture = makeFixture({ prebuild: true });

    const first = run(fixture, 'node');
    expect(first.status, first.stderr).toBe(0);

    // The install loses its only loadable binding. `build/Release/` was never
    // populated, so a marker keyed on that path alone still matches.
    fs.rmSync(fixture.prebuild);

    const second = run(fixture, 'node');
    // A green here is the regression: the script exits 0 without ever opening a
    // database, so every `pretest` green-lights a broken install.
    expect(second.status).not.toBe(0);
    expect(second.stderr).toContain('better-sqlite3 does not load under node');
  });

  it('keeps reporting ready for a healthy N-API install that has no build/Release', () => {
    const fixture = makeFixture({ prebuild: true });
    expect(fs.existsSync(path.join(fixture.root, 'node_modules', 'better-sqlite3', 'build', 'Release'))).toBe(false);

    // First run probes and caches; second run must still short-circuit to 0.
    // A guard that treats "no build/Release" as broken turns this red, which is
    // exactly the wrong direction to be wrong in.
    expect(run(fixture, 'node').status).toBe(0);
    expect(run(fixture, 'node').status).toBe(0);
  });

  it('re-probes when the marker was written for a different target runtime', () => {
    const fixture = makeFixture({ prebuild: true });
    expect(run(fixture, 'node').status).toBe(0);

    // Forge a marker for the other runtime. Every other key still matches, so a
    // cache that ignored `target` would short-circuit here and leave the stale
    // electron marker in place.
    const marker = readMarker(fixture);
    marker.target = 'electron';
    fs.writeFileSync(fixture.markerPath, JSON.stringify(marker), 'utf8');

    expect(run(fixture, 'node').status).toBe(0);
    expect(readMarker(fixture).target).toBe('node');
  });

  it('records every candidate binding in the marker, not just one path', () => {
    const fixture = makeFixture({ prebuild: true });
    expect(run(fixture, 'node').status).toBe(0);

    const marker = readMarker(fixture);
    // Under the old key this field did not exist at all, which is what let a
    // missing binding keep matching.
    expect(typeof marker.binding).toBe('string');
    expect(marker.binding).toContain(`prebuilds/${process.platform}-${process.arch}.node`);
    expect(marker.binding).toContain('build/Release/better_sqlite3.node~absent');
  });

  it('reports a missing binding honestly when nothing has ever been verified', () => {
    const fixture = makeFixture({});
    const res = run(fixture, 'node');
    expect(res.status).not.toBe(0);
    expect(res.stderr).toContain('better-sqlite3 does not load under node');
    expect(fs.existsSync(fixture.markerPath)).toBe(false);
  });

  it('rejects a target it does not understand', () => {
    const fixture = makeFixture({ prebuild: true });
    const res = run(fixture, 'wasm');
    expect(res.status).toBe(2);
    expect(res.stderr).toContain('usage:');
  });

  it('re-probes when a binding is replaced in place, not only when it disappears', () => {
    const fixture = makeFixture({ prebuild: true });
    expect(run(fixture, 'node').status).toBe(0);

    // Same path, different content: presence is unchanged, so a key that only
    // records presence would still match and the stale marker would survive.
    fs.writeFileSync(fixture.prebuild, 'a-different-binding-of-a-different-size', 'utf8');

    // The two sides of this comparison come from different sources: the marker
    // is written by the spawned script, the size is stat'ed here.
    const st = fs.statSync(fixture.prebuild);
    expect(st.size).not.toBe('prebuilt-binding'.length);
    expect(run(fixture, 'node').status).toBe(0);

    const entry = String(readMarker(fixture).binding)
      .split(',')
      .find((part) => part.startsWith(`prebuilds/${process.platform}-${process.arch}.node~`));
    expect(entry).toBeDefined();
    expect(entry).toMatch(/~\d+$/);
    expect(entry?.endsWith(`~${st.size}`)).toBe(true);
  });

  it('re-probes when a node-gyp install loses its only binding', () => {
    // The other healthy install shape: no `prebuilds/` at all, the node-gyp
    // output under `build/Release` is the only loadable artifact.
    const fixture = makeFixture({ nodeGyp: true });
    const built = path.join(fixture.root, 'node_modules', 'better-sqlite3', 'build', 'Release', 'better_sqlite3.node');
    expect(fs.existsSync(built)).toBe(true);
    expect(fs.existsSync(path.join(fixture.root, 'node_modules', 'better-sqlite3', 'prebuilds'))).toBe(false);

    expect(run(fixture, 'node').status).toBe(0);
    fs.rmSync(built);

    const res = run(fixture, 'node');
    expect(res.status).not.toBe(0);
    expect(res.stderr).toContain('better-sqlite3 does not load under node');
  });
});
