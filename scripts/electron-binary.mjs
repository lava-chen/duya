#!/usr/bin/env node
/**
 * electron-binary.mjs — locate the Electron executable that
 * `scripts/ensure-sqlite-abi.mjs` probes the better-sqlite3 binding with.
 *
 * WHY THIS EXISTS (the `build` CI job failure, all three OSes)
 * ------------------------------------------------------------
 * `electron@44.2.0` — the version pinned in package-lock.json — ships NO
 * lifecycle scripts at all. Its package.json has no `scripts` field, so npm
 * has nothing to run, and package-lock.json correspondingly records no
 * `hasInstallScript` for it. `install.js` (which downloads and unpacks the
 * zip) is reachable only through the `install-electron` bin, and the download
 * is triggered lazily by `index.js` the first time something `require`s the
 * package.
 *
 * The consequence: after a clean `npm ci` there is no `node_modules/electron/
 * dist/` and no `node_modules/electron/path.txt`, on any platform. A resolver
 * that only reads those two artefacts is therefore guaranteed to report
 * "binary not found" forever, no matter how healthy the install is — which is
 * exactly what the `build` job hit, because `preelectron:build` runs this
 * check before anything has required `electron`.
 *
 * So the binary is resolved through the package's OWN entry point,
 * `require('electron')`, which is both the supported way to ask the question
 * and the step that produces the answer when it is missing. The `path.txt`
 * probe is kept as a fallback for the one case `require` cannot serve: a
 * `require` that runs inside an Electron main process exports the module API
 * object rather than a path.
 *
 * This module performs NO download itself and swallows no error — it reports
 * which of the two failures it saw so the caller can say so. Whether an
 * unavailable target should fail the build is the caller's decision, not this
 * module's.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { createRequire } from 'node:module';

/** The `electron` package itself cannot be resolved from this checkout. */
export const MISSING_PACKAGE = 'electron-package-missing';

/** The package is present but no executable could be produced or found. */
export const MISSING_BINARY = 'electron-binary-unavailable';

/**
 * @typedef {object} ResolvedBinary
 * @property {true} ok
 * @property {string} binary Absolute path to the Electron executable.
 * @property {'require'|'path.txt'} source Which probe produced the answer.
 *
 * @typedef {object} UnresolvedBinary
 * @property {false} ok
 * @property {typeof MISSING_PACKAGE|typeof MISSING_BINARY} reason
 * @property {string} detail Human-readable cause, safe to print in CI.
 *
 * @typedef {ResolvedBinary|UnresolvedBinary} BinaryResolution
 */

/**
 * Resolve the binary from the on-disk layout alone: `dist/` plus the
 * `path.txt` pointer that `install.js` writes after unpacking.
 *
 * @param {string} packageDir Absolute path of the `electron` package.
 * @param {string} [platform] Defaults to `process.platform`.
 * @returns {string|null} Absolute executable path, or null when absent.
 */
function binaryFromPathTxt(packageDir, platform = process.platform) {
  const pathTxt = path.join(packageDir, 'path.txt');
  if (!fs.existsSync(pathTxt)) return null;
  const bin = path.join(packageDir, 'dist', fs.readFileSync(pathTxt, 'utf8').trim());
  if (fs.existsSync(bin)) return bin;
  // On Windows, electron ships as `electron.exe` but path.txt records the
  // bare name "electron". fs.existsSync does not apply PATHEXT, so check
  // the .exe variant explicitly. spawnSync on win32 also needs the .exe
  // suffix; passing the un-suffixed path yields ENOENT.
  if (platform === 'win32') {
    const exeBin = `${bin}.exe`;
    if (fs.existsSync(exeBin)) return exeBin;
  }
  return null;
}

/**
 * Resolve the Electron executable, producing it if the package is installed
 * but not yet unpacked.
 *
 * @param {object} options
 * @param {string|null} options.packageDir Absolute path of the `electron`
 *   package, or null when it is not installed.
 * @param {(id: string) => unknown} [options.requireFn] Injection point for
 *   tests; defaults to a `createRequire` rooted at this file.
 * @param {string} [options.platform] Defaults to `process.platform`.
 * @returns {BinaryResolution}
 */
export function resolveElectronBinary({
  packageDir,
  requireFn = createRequire(import.meta.url),
  platform = process.platform,
}) {
  if (!packageDir) {
    return {
      ok: false,
      reason: MISSING_PACKAGE,
      detail: 'the `electron` package is not installed — run `npm install` first.',
    };
  }

  // Ask the package itself first. This has to come before the path.txt probe
  // because it is also the step that CREATES the binary: on a fresh install
  // the require is what performs the lazy download that install.js's absence
  // from the lifecycle left undone.
  let requireError = null;
  try {
    const exported = requireFn('electron');
    if (typeof exported === 'string' && exported.length > 0 && fs.existsSync(exported)) {
      return { ok: true, binary: exported, source: 'require' };
    }
  } catch (err) {
    requireError = err instanceof Error ? err.message : String(err);
  }

  // Fall back to the raw on-disk layout. This still matters: `require` can
  // resolve without returning a usable path (a require running inside an
  // Electron main process exports the module API object, not a string), and
  // in that case the files on disk are the only source of truth.
  const fromPathTxt = binaryFromPathTxt(packageDir, platform);
  if (fromPathTxt) {
    return { ok: true, binary: fromPathTxt, source: 'path.txt' };
  }

  return {
    ok: false,
    reason: MISSING_BINARY,
    detail: requireError ?? 'no `dist/` executable and no `path.txt` pointer',
  };
}
