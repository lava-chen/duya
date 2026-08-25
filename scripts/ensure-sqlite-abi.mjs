#!/usr/bin/env node
/**
 * ensure-sqlite-abi.mjs — make `node_modules/better-sqlite3` load under the
 * requested runtime.
 *
 * better-sqlite3 is a V8-ABI native module: the Electron runtime (main +
 * agent workers, spawned with ELECTRON_RUN_AS_NODE=1 → ABI 119) and the
 * local Node.js used by Vitest (ABI 137 on Node 24) need DIFFERENT builds.
 * One `build/Release/better_sqlite3.node` can only serve one ABI, so any
 * switch between `npm test` and `npm run electron:dev` requires swapping it.
 *
 * Instead of recompiling from source (slow, needs the VS toolchain, and
 * `npm rebuild`/`node-gyp` can clobber the working binary), this script
 * swaps in the matching PREBUILT binary:
 *
 *   - node:     `prebuild-install --force` (current Node ABI, cached)
 *   - electron: copy `<pkg>/bin/win32-x64-119/better-sqlite3.node` (the
 *               Electron prebuilt) into build/Release, or download it via
 *               `prebuild-install --runtime electron --target <version>`.
 *
 * It is wired as the `pre`-hook of the DB-touching entry points
 * (`pretest*` → node, `preelectron:*` → electron) and as the
 * implementation of `npm run rebuild:node`, so the NODE_MODULE_VERSION
 * mismatch error never reaches the user again.
 *
 * Usage: node scripts/ensure-sqlite-abi.mjs <node|electron>
 * Exit codes: 0 = ready, 1 = failed to prepare (diagnostics printed).
 */

import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MODULE = 'better-sqlite3';
const MARKER = path.join(root, 'node_modules', '.better-sqlite3-abi.json');

const target = process.argv[2];
if (target !== 'node' && target !== 'electron') {
  console.error('[abi] usage: node scripts/ensure-sqlite-abi.mjs <node|electron>');
  process.exit(2);
}

function pkgDir(name) {
  try {
    return path.dirname(require.resolve(`${name}/package.json`));
  } catch {
    return null;
  }
}

function electronVersion() {
  const dir = pkgDir('electron');
  if (!dir) return null;
  try {
    return require(path.join(dir, 'package.json')).version;
  } catch {
    return null;
  }
}

function electronBinary() {
  const dir = pkgDir('electron');
  if (!dir) return null;
  const pathTxt = path.join(dir, 'path.txt');
  if (!fs.existsSync(pathTxt)) return null;
  const bin = path.join(dir, 'dist', fs.readFileSync(pathTxt, 'utf8').trim());
  if (fs.existsSync(bin)) return bin;
  // On Windows, electron ships as `electron.exe` but path.txt records the
  // bare name "electron". fs.existsSync does not apply PATHEXT, so check
  // the .exe variant explicitly. spawnSync on win32 also needs the .exe
  // suffix; passing the un-suffixed path yields ENOENT.
  if (process.platform === 'win32') {
    const exeBin = `${bin}.exe`;
    if (fs.existsSync(exeBin)) return exeBin;
  }
  return null;
}

/**
 * Normalize `node_modules/electron/path.txt` for the current platform.
 *
 * The upstream `electron` install.js writes the correct per-platform value
 * (`electron.exe` on win32, `electron` on linux, `Electron.app/.../Electron`
 * on darwin) — without a trailing newline. But node_modules is often copied
 * across platforms (CI cache, devcontainer, manual rsync) and a file written
 * on linux surfaces on Windows as `electron\n`. The downstream `cli.js`
 * (and our own spawn) does not trim(), so `electron .` then fails with
 * `ENOENT ... \electron\n`. Detect the cross-platform artifact and rewrite
 * the file in place — idempotent and self-healing.
 */
function normalizeElectronPathTxt() {
  const dir = pkgDir('electron');
  if (!dir) return;
  const pathTxt = path.join(dir, 'path.txt');
  if (!fs.existsSync(pathTxt)) return;
  const expected =
    process.platform === 'win32'
      ? 'electron.exe'
      : process.platform === 'darwin'
        ? 'Electron.app/Contents/MacOS/Electron'
        : 'electron';
  const current = fs.readFileSync(pathTxt, 'utf8');
  const normalized = current.replace(/\r?\n/g, '');
  if (normalized === expected && !current.includes('\n')) return;
  try {
    fs.writeFileSync(pathTxt, expected);
    console.error(
      `[abi] rewrote electron/path.txt (${JSON.stringify(current)} -> ${JSON.stringify(expected)}) for ${process.platform}.`,
    );
  } catch (err) {
    console.error(`[abi] failed to rewrite electron/path.txt: ${err.message}`);
  }
}

normalizeElectronPathTxt();

/**
 * Probe that the native binding REALLY loads under the target runtime.
 * `require('better-sqlite3')` alone does NOT load the addon (it is loaded
 * lazily in the Database constructor), so instantiate an in-memory DB.
 */
function loadsUnder(command, env) {
  const res = spawnSync(
    command,
    ['-e', `new (require(${JSON.stringify(MODULE)}))(':memory:');`],
    { cwd: root, encoding: 'utf8', env, timeout: 30000 },
  );
  if (res.status === 0) return { ok: true, error: null };
  const error = (res.stderr || res.stdout || '').trim();
  return { ok: false, error: error.split('\n')[0] || `exit code ${res.status}` };
}

const dir = pkgDir(MODULE);
if (!dir) {
  console.error(`[abi] ${MODULE} is not installed — run \`npm install\` first.`);
  process.exit(1);
}

const binPath = path.join(dir, 'build', 'Release', 'better_sqlite3.node');
const binMtime = fs.existsSync(binPath) ? fs.statSync(binPath).mtimeMs : 0;
const nodeAbi = process.versions.modules;
const electronVer = electronVersion();

// Fast path: unchanged since the last successful verification for this target.
try {
  const marker = JSON.parse(fs.readFileSync(MARKER, 'utf8'));
  if (
    marker.target === target &&
    marker.mtime === binMtime &&
    marker.nodeAbi === nodeAbi &&
    marker.electronVersion === electronVer
  ) {
    process.exit(0);
  }
} catch {
  // No marker yet — verify.
}

const command = target === 'electron' ? electronBinary() : process.execPath;
const env = target === 'electron' ? { ...process.env, ELECTRON_RUN_AS_NODE: '1' } : process.env;
if (!command) {
  console.error('[abi] electron binary not found; cannot verify the electron target.');
  process.exit(1);
}

const check = loadsUnder(command, env);
if (check.ok) {
  try {
    fs.mkdirSync(path.dirname(MARKER), { recursive: true });
    fs.writeFileSync(
      MARKER,
      JSON.stringify({ target, mtime: binMtime, nodeAbi, electronVersion: electronVer }),
      'utf8',
    );
  } catch {
    // Marker is a cache — failure to write is not fatal.
  }
  process.exit(0);
}

console.error(`[abi] better-sqlite3 does not load under ${target} (${check.error}) — swapping in the ${target} prebuilt…`);

let healed = false;
if (target === 'electron') {
  // Offline-first: the Electron prebuilt ships in <pkg>/bin/<platform>-<arch>-119/.
  // Fallback: repo-level prebuilds/ — survives `npm ci`, which wipes <pkg>/bin.
  // The artifact there was produced once via `npx electron-rebuild -o better-sqlite3`
  // (upstream publishes no electron-v119 prebuilt for better-sqlite3 v12+).
  // Fixed filename: this repo pins Electron 28, so the electron ABI is
  // constant; deriving it from process.versions.modules would wrongly use
  // the running Node's ABI.
  const candidates = [];
  const binDir = path.join(dir, 'bin');
  if (fs.existsSync(binDir)) {
    for (const sub of fs.readdirSync(binDir)) {
      candidates.push(path.join(binDir, sub, 'better-sqlite3.node'));
    }
  }
  candidates.push(path.join(root, 'prebuilds', 'better-sqlite3-electron-win32-x64.node'));
  for (const prebuilt of candidates) {
    if (!fs.existsSync(prebuilt)) continue;
    try {
      fs.mkdirSync(path.dirname(binPath), { recursive: true });
      fs.copyFileSync(prebuilt, binPath);
      console.error(`[abi] copied the Electron prebuilt (${path.relative(root, prebuilt)}) into build/Release.`);
      healed = true;
      break;
    } catch (err) {
      console.error(`[abi] copy failed: ${err.message}`);
    }
  }
}

if (!healed) {
  // Fallback: download the prebuilt for the target runtime (cached first).
  const prebuildInstall = path.join(root, 'node_modules', 'prebuild-install', 'bin.js');
  if (fs.existsSync(prebuildInstall)) {
    const args = [prebuildInstall, '--force'];
    if (target === 'electron' && electronVer) {
      args.push('--runtime', 'electron', '--target', electronVer);
    }
    const res = spawnSync(process.execPath, args, {
      cwd: dir,
      stdio: 'inherit',
      env: process.env,
      timeout: 300000,
    });
    healed = res.status === 0;
    if (!healed) {
      console.error(
        `[abi] prebuild-install failed (exit ${res.status}). Close DUYA and retry; the swap needs to ` +
          'overwrite build/Release/better_sqlite3.node (locked while Electron is running).',
      );
    }
  } else {
    console.error('[abi] cannot locate prebuild-install (reinstall deps first).');
  }
}

if (!healed) process.exit(1);

const reCheck = loadsUnder(command, env);
if (!reCheck.ok) {
  console.error(`[abi] still broken after swap: ${reCheck.error}`);
  process.exit(1);
}

console.error(`[abi] better-sqlite3 is ready for the ${target} runtime.`);
try {
  fs.mkdirSync(path.dirname(MARKER), { recursive: true });
  fs.writeFileSync(
    MARKER,
    JSON.stringify({
      target,
      mtime: fs.existsSync(binPath) ? fs.statSync(binPath).mtimeMs : 0,
      nodeAbi,
      electronVersion: electronVer,
    }),
    'utf8',
  );
} catch {
  // Non-fatal.
}
process.exit(0);
