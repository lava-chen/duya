/**
 * fetch-ripgrep.mjs — download a pinned ripgrep binary into resources/ripgrep/
 * so packaged builds ship their own rg engine.
 *
 * The agent's GrepTool resolves the binary via DUYA_RIPGREP_PATH (published
 * at main-process boot from resources/ripgrep/), falling back to PATH and
 * then to its pure-Node engine. Bundling rg keeps packaged searches fast on
 * machines where ripgrep was never installed.
 *
 * Behavior:
 *   - Cached: skips when resources/ripgrep/<binary> exists with a matching
 *     VERSION marker. Delete the directory (or bump RIPGREP_VERSION) to refetch.
 *   - Non-fatal: network/platform failures print a warning and exit 0 so
 *     offline builds still succeed — set DUYA_STRICT_RIPGREP=1 to make them
 *     fail the build instead.
 *
 * Env overrides: RIPGREP_VERSION (pinned release tag without the "v").
 */

import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const RIPGREP_VERSION = process.env.RIPGREP_VERSION || '14.1.1';
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TARGET_DIR = path.join(REPO_ROOT, 'resources', 'ripgrep');
const BINARY_NAME = process.platform === 'win32' ? 'rg.exe' : 'rg';
const STRICT = process.env.DUYA_STRICT_RIPGREP === '1';

function log(message) {
  console.log(`[fetch-ripgrep] ${message}`);
}

function fail(message) {
  if (STRICT) {
    console.error(`[fetch-ripgrep] FATAL: ${message}`);
    process.exit(1);
  }
  log(`WARNING: ${message} — continuing without bundled ripgrep`);
  // Keep the directory present so electron-builder's extraResources glob
  // never hits a missing source dir.
  mkdirSync(TARGET_DIR, { recursive: true });
  process.exit(0);
}

/** Release asset triple per platform/arch, mirroring pi's tools-manager table. */
function assetTriple(platform, arch) {
  if (platform === 'win32') {
    return arch === 'arm64' ? 'aarch64-pc-windows-msvc' : 'x86_64-pc-windows-msvc';
  }
  if (platform === 'darwin') {
    return arch === 'arm64' ? 'aarch64-apple-darwin' : 'x86_64-apple-darwin';
  }
  if (platform === 'linux') {
    // musl builds are fully static — they run on any glibc, old or new.
    return arch === 'arm64' ? 'aarch64-unknown-linux-gnu' : 'x86_64-unknown-linux-musl';
  }
  return null;
}

function currentMarker() {
  try {
    return readFileSync(path.join(TARGET_DIR, 'VERSION'), 'utf8').trim();
  } catch {
    return null;
  }
}

function findExtractedBinary(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      const found = findExtractedBinary(full);
      if (found) return found;
    } else if (entry.name === BINARY_NAME) {
      return full;
    }
  }
  return null;
}

async function download(url, destination) {
  log(`downloading ${url}`);
  const response = await fetch(url, { redirect: 'follow' });
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} for ${url}`);
  }
  const buffer = Buffer.from(await response.arrayBuffer());
  writeFileSync(destination, buffer);
  log(`downloaded ${(buffer.length / 1024 / 1024).toFixed(1)} MB`);
}

async function main() {
  const binaryPath = path.join(TARGET_DIR, BINARY_NAME);

  mkdirSync(TARGET_DIR, { recursive: true });

  if (existsSync(binaryPath) && currentMarker() === RIPGREP_VERSION) {
    log(`cached ripgrep ${RIPGREP_VERSION} already present (${binaryPath})`);
    return;
  }

  const triple = assetTriple(process.platform, process.arch);
  if (!triple) {
    fail(`unsupported platform ${process.platform}/${process.arch}`);
    return;
  }

  const isZip = process.platform === 'win32';
  const archiveName = `ripgrep-${RIPGREP_VERSION}-${triple}.${isZip ? 'zip' : 'tar.gz'}`;
  const url = `https://github.com/BurntSushi/ripgrep/releases/download/${RIPGREP_VERSION}/${archiveName}`;
  const archivePath = path.join(TARGET_DIR, `.download-${archiveName}`);
  const stageDir = path.join(TARGET_DIR, '.stage');

  await download(url, archivePath);

  rmSync(stageDir, { recursive: true, force: true });
  mkdirSync(stageDir, { recursive: true });

  // Windows ships bsdtar (handles zip); macOS/Linux tar handles tar.gz.
  const tarResult = spawnSync(
    'tar',
    [isZip ? '-xf' : '-xzf', archivePath, '-C', stageDir],
    { stdio: 'inherit' },
  );
  if (tarResult.status !== 0) {
    throw new Error(`tar extraction failed with status ${tarResult.status}`);
  }

  const extracted = findExtractedBinary(stageDir);
  if (!extracted || statSync(extracted).isDirectory()) {
    throw new Error(`${BINARY_NAME} not found inside ${archiveName}`);
  }

  copyFileSync(extracted, binaryPath);
  if (process.platform !== 'win32') {
    chmodSync(binaryPath, 0o755);
  }
  writeFileSync(path.join(TARGET_DIR, 'VERSION'), `${RIPGREP_VERSION}\n`);

  rmSync(stageDir, { recursive: true, force: true });
  rmSync(archivePath, { force: true });
  log(`installed ripgrep ${RIPGREP_VERSION} -> ${binaryPath}`);
}

main().catch((error) => {
  fail(error instanceof Error ? error.message : String(error));
});
