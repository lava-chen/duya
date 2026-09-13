/**
 * electron/services/browser/extension-installer.ts
 *
 * One-click install of the DUYA Browser Bridge extension on Windows via
 * HKCU registry writes. Bypasses the Chrome Web Store, which is blocked
 * for users in mainland China.
 *
 * Why HKCU registry:
 *   Chrome and Edge honor two registry values per extension id under
 *   `HKCU\Software\<Browser>\Extensions\<id>\` to load an unpacked extension
 *   from disk every time the browser starts:
 *     - path    REG_SZ  absolute path to the extension folder
 *     - version REG_SZ  version string from manifest.json
 *   No admin rights required, no Chrome Web Store round-trip, and the user
 *   only has to restart their browser once for it to take effect.
 *
 * Why reg.exe (no native module):
 *   `reg.exe` ships with every Windows install since XP. We spawn it via
 *   `child_process.execFile` and parse its stdout; that keeps the dependency
 *   surface flat and avoids V8-ABI native-module headaches.
 *
 * Out of scope:
 *   - Linux and macOS users see `state: 'unsupported'` and get a manual
 *     fallback in the UI ("load unpacked at chrome://extensions").
 *   - We deliberately do NOT write to HKLM — that needs admin rights and
 *     makes DUYA harder to install; HKCU is enough for personal users.
 *
 * @see docs/exec-plans/active/532-one-click-extension-install.md
 */

import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { promisify } from 'node:util';

import { app } from 'electron';

import { initLogger, LogComponent } from '../../logging/logger';

const execFileAsync = promisify(execFile);

const logger = initLogger({ level: 'WARN' });

/**
 * Production extension ID published on the Chrome Web Store. After local
 * install the bridge hello protocol sends the same ID back, and the daemon
 * auto-approves it because we whitelist it via `setAllowedExtensionIds` in
 * `electron/ipc/settings-handlers.ts`. Keeping the ID here as a constant
 * avoids a magic string in the IPC layer.
 */
export const DUYA_BRIDGE_EXTENSION_ID = 'hpkgmnimcghdnodpoehidjeinnhlnpkd';

/**
 * Browsers whose HKCU registry hive accepts a `path`/`version` pair to
 * force-load an unpacked extension. Brave and 360 share the Chromium
 * `HKCU\Software\Google\Chrome\Extensions` hive so we list them under the
 * Chrome key with a per-browser-friendly label.
 */
const TARGET_BROWSERS = [
  // (registryRoot, label) — registryRoot is the path under HKCU
  { registryRoot: 'Software\\Google\\Chrome\\Extensions', label: 'chrome' },
  { registryRoot: 'Software\\Microsoft\\Edge\\Extensions', label: 'edge' },
  // Brave writes under Google\Chrome too, but with a flag that distinguishes
  // its profile path. We skip the duplicate key write here — Brave will pick
  // up Chrome's HKCU entries only when Chrome is the user's primary browser.
  // If a user reports Brave isn't loading, we can add it later.
] as const;

type BrowserLabel = (typeof TARGET_BROWSERS)[number]['label'];

export type LocalInstallState =
  | 'not-installed'
  | 'installed-current'
  | 'installed-outdated'
  | 'unsupported';

export interface DetectLocalExtensionResult {
  state: LocalInstallState;
  /** The version bundled with this DUYA build (from resources/extension/manifest.json). */
  expectedVersion: string;
  /** The version recorded in the registry, or null if no entry was found. */
  installedVersion: string | null;
  /** Absolute path DUYA would write into the registry, or null when unsupported. */
  expectedPath: string | null;
  /** Browser labels for which a registry entry currently exists. */
  installedIn: BrowserLabel[];
}

export interface InstallLocalExtensionResult {
  ok: boolean;
  error?: string;
  registryKeysWritten: string[];
  expectedPath: string;
  expectedVersion: string;
}

export interface UninstallLocalExtensionResult {
  ok: boolean;
  error?: string;
  registryKeysRemoved: string[];
}

/**
 * Locate the bundled extension folder shipped inside this DUYA install.
 * In packaged builds it lives at `<exe-dir>/resources/extension/`. In dev
 * (electron.exe running from the repo) it lives at `<repo>/extension/`.
 *
 * Returns null if the folder or its `manifest.json` is missing — callers
 * must treat that as `state: 'unsupported'` rather than crashing.
 */
export function resolveExtensionInstallDir(): string | null {
  if (app.isPackaged) {
    const exeDir = path.dirname(process.execPath);
    const packaged = path.join(exeDir, 'resources', 'extension');
    return packaged;
  }
  const dev = path.join(app.getAppPath(), 'extension');
  return dev;
}

async function readManifestVersion(extensionDir: string): Promise<string | null> {
  try {
    const manifestPath = path.join(extensionDir, 'manifest.json');
    const raw = await fs.readFile(manifestPath, 'utf8');
    const parsed = JSON.parse(raw) as { version?: unknown };
    return typeof parsed.version === 'string' ? parsed.version : null;
  } catch {
    return null;
  }
}

/**
 * Query the Windows registry for the `path` and `version` values under
 * `HKCU\<root>\<extensionId>\`. Both `reg query` calls return multi-line
 * text; we parse out the value we need with a regex.
 *
 * Returns `null` for any missing value (registry key absent, value not
 * set, reg.exe non-zero exit) — callers should treat null as "not
 * installed" without branching on the specific cause.
 */
async function regQueryValueImpl(
  registryRoot: string,
  valueName: 'path' | 'version',
): Promise<string | null> {
  const key = `HKCU\\${registryRoot}\\${DUYA_BRIDGE_EXTENSION_ID}`;
  try {
    const { stdout } = await execFileAsync('reg.exe', [
      'query',
      key,
      '/v',
      valueName,
    ]);
    // reg.exe output (REG_SZ):
    //     path    REG_SZ    C:\Program Files\DUYA\resources\extension
    // We anchor on the value name to be robust to localized headers.
    const match = stdout.match(
      new RegExp(`^\\s*${valueName}\\s+REG_\\w+\\s+(.+)$`, 'm'),
    );
    return match ? match[1].trim() : null;
  } catch {
    // reg.exe exits non-zero when the key doesn't exist. That's expected
    // for a fresh install — do not log as an error.
    return null;
  }
}

/**
 * Indirection so unit tests can spy on this function without having to
 * mock the promisified `child_process.execFile` (which vitest can't do
 * cleanly across module boundaries). Production callers should not
 * reassign it; only the test file overrides it via `vi.spyOn`.
 */
export let regQueryValue = regQueryValueImpl;

/**
 * Build a single-line REG_SZ string suitable for `reg add`. reg.exe
 * refuses values containing `\` without doubling, so we escape that.
 */
function escapeRegString(value: string): string {
  return value.replace(/\\/g, '\\\\');
}

async function regAddValueImpl(
  registryRoot: string,
  valueName: 'path' | 'version',
  value: string,
): Promise<void> {
  const key = `HKCU\\${registryRoot}\\${DUYA_BRIDGE_EXTENSION_ID}`;
  await execFileAsync('reg.exe', [
    'add',
    key,
    '/v',
    valueName,
    '/t',
    'REG_SZ',
    '/d',
    escapeRegString(value),
    '/f',
  ]);
}

export let regAddValue = regAddValueImpl;

async function regDeleteKeyImpl(registryRoot: string): Promise<boolean> {
  const key = `HKCU\\${registryRoot}\\${DUYA_BRIDGE_EXTENSION_ID}`;
  try {
    await execFileAsync('reg.exe', ['delete', key, '/f']);
    return true;
  } catch {
    return false;
  }
}

export let regDeleteKey = regDeleteKeyImpl;

/**
 * Test-only injector. Lets unit tests replace the three registry
 * helpers with mocks without going through `vi.mock` (which can't
 * reach into a module's internal lexical bindings). Production code
 * MUST NOT call this; the service should always use the impl-bound
 * `export let` above.
 *
 * Exposed via the `__extensionInstallerTestHooks` symbol so it never
 * appears in production IDE autocomplete.
 */
export const __extensionInstallerTestHooks = {
  setRegFakes(fakes: {
    regQueryValue?: typeof regQueryValueImpl;
    regAddValue?: typeof regAddValueImpl;
    regDeleteKey?: typeof regDeleteKeyImpl;
  }): void {
    if (fakes.regQueryValue) regQueryValue = fakes.regQueryValue;
    if (fakes.regAddValue) regAddValue = fakes.regAddValue;
    if (fakes.regDeleteKey) regDeleteKey = fakes.regDeleteKey;
  },
  resetRegFakes(): void {
    regQueryValue = regQueryValueImpl;
    regAddValue = regAddValueImpl;
    regDeleteKey = regDeleteKeyImpl;
  },
};

/**
 * Detect whether the bundled extension is registered in the user's HKCU
 * hive, and whether the registered version matches what DUYA ships with.
 *
 * The comparison is purely string-based — manifest versions are
 * dot-separated numbers, semver-style — so we just check for exact
 * equality. If a downgrade becomes possible we can swap this for
 * `semver.compare` later.
 */
export async function detectLocalExtension(): Promise<DetectLocalExtensionResult> {
  if (process.platform !== 'win32') {
    return {
      state: 'unsupported',
      expectedVersion: '',
      installedVersion: null,
      expectedPath: null,
      installedIn: [],
    };
  }

  const extensionDir = resolveExtensionInstallDir();
  if (!extensionDir) {
    return {
      state: 'unsupported',
      expectedVersion: '',
      installedVersion: null,
      expectedPath: null,
      installedIn: [],
    };
  }

  const expectedVersion = await readManifestVersion(extensionDir);
  if (!expectedVersion) {
    logger.warn(
      '[extension-installer] No manifest.json version at ' + extensionDir,
      undefined,
      LogComponent.BrowserDaemon,
    );
    return {
      state: 'unsupported',
      expectedVersion: '',
      installedVersion: null,
      expectedPath: extensionDir,
      installedIn: [],
    };
  }

  // Query each browser's hive in parallel — they're independent registry
  // reads and latency adds up when we hit a slow disk.
  const results = await Promise.all(
    TARGET_BROWSERS.map(async (browser) => {
      const [path, version] = await Promise.all([
        regQueryValue(browser.registryRoot, 'path'),
        regQueryValue(browser.registryRoot, 'version'),
      ]);
      return { browser, path, version };
    }),
  );

  const installedIn: BrowserLabel[] = [];
  const versions: string[] = [];
  let expectedPath: string | null = null;

  for (const r of results) {
    if (r.path && r.version) {
      installedIn.push(r.browser.label);
      versions.push(r.version);
      if (expectedPath === null) expectedPath = r.path;
    }
  }

  if (installedIn.length === 0) {
    return {
      state: 'not-installed',
      expectedVersion,
      installedVersion: null,
      expectedPath: extensionDir,
      installedIn: [],
    };
  }

  // If every browser we see reports the same version as our bundle, treat
  // it as current. A mixed-version install (e.g. Chrome outdated but Edge
  // current) still surfaces as outdated so the user reloads the browser
  // and picks up the new manifest.
  const allCurrent = versions.every((v) => v === expectedVersion);
  const state: LocalInstallState = allCurrent
    ? 'installed-current'
    : 'installed-outdated';

  return {
    state,
    expectedVersion,
    installedVersion: versions[0] ?? null,
    expectedPath,
    installedIn,
  };
}

/**
 * Write the HKCU registry entries that tell Chrome / Edge to load the
 * bundled extension on next browser start. Idempotent: re-running with
 * the same version just refreshes `path`/`version` values.
 *
 * Errors are returned as `{ ok: false, error }` rather than thrown, so
 * the IPC layer can surface the literal `reg.exe` stderr to the UI
 * without wrapping each call site in try/catch.
 */
export async function installLocalExtension(): Promise<InstallLocalExtensionResult> {
  if (process.platform !== 'win32') {
    return {
      ok: false,
      error:
        'Local install is only supported on Windows. ' +
        'On macOS or Linux, load the extension manually at chrome://extensions.',
      registryKeysWritten: [],
      expectedPath: '',
      expectedVersion: '',
    };
  }

  const extensionDir = resolveExtensionInstallDir();
  if (!extensionDir) {
    return {
      ok: false,
      error: 'Could not locate the bundled extension folder.',
      registryKeysWritten: [],
      expectedPath: '',
      expectedVersion: '',
    };
  }

  // Verify the directory exists and has a valid manifest before touching
  // the registry. Writing registry entries that point at a missing folder
  // is harmless (Chrome ignores them at startup) but the user will be
  // confused about why nothing happened.
  try {
    const stat = await fs.stat(extensionDir);
    if (!stat.isDirectory()) {
      return {
        ok: false,
        error: `Extension folder is not a directory: ${extensionDir}`,
        registryKeysWritten: [],
        expectedPath: extensionDir,
        expectedVersion: '',
      };
    }
  } catch (error) {
    return {
      ok: false,
      error: `Extension folder not found: ${extensionDir} (${(error as Error).message})`,
      registryKeysWritten: [],
      expectedPath: extensionDir,
      expectedVersion: '',
    };
  }

  const version = await readManifestVersion(extensionDir);
  if (!version) {
    return {
      ok: false,
      error: 'Could not read manifest.json from the bundled extension.',
      registryKeysWritten: [],
      expectedPath: extensionDir,
      expectedVersion: '',
    };
  }

  const registryKeysWritten: string[] = [];
  const writeErrors: string[] = [];

  // Sequential writes to keep the error log readable; reg.exe is fast
  // enough that parallelism buys us little.
  for (const browser of TARGET_BROWSERS) {
    try {
      await regAddValue(browser.registryRoot, 'path', extensionDir);
      await regAddValue(browser.registryRoot, 'version', version);
      registryKeysWritten.push(
        `HKCU\\${browser.registryRoot}\\${DUYA_BRIDGE_EXTENSION_ID}`,
      );
      logger.info(
        `[extension-installer] Registered ${browser.label} HKCU key for v${version}`,
        undefined,
        LogComponent.BrowserDaemon,
      );
    } catch (error) {
      const message = (error as Error).message;
      writeErrors.push(`${browser.label}: ${message}`);
      logger.warn(
        `[extension-installer] reg.exe failed for ${browser.label}: ${message}`,
        undefined,
        LogComponent.BrowserDaemon,
      );
    }
  }

  if (registryKeysWritten.length === 0) {
    return {
      ok: false,
      error: `All registry writes failed. ${writeErrors.join('; ')}`,
      registryKeysWritten: [],
      expectedPath: extensionDir,
      expectedVersion: version,
    };
  }

  return {
    ok: true,
    registryKeysWritten,
    expectedPath: extensionDir,
    expectedVersion: version,
  };
}

/**
 * Remove the HKCU registry entries written by `installLocalExtension`.
 * Best-effort: a key that doesn't exist is not an error, so users can
 * run uninstall even if they manually removed the extension first.
 */
export async function uninstallLocalExtension(): Promise<UninstallLocalExtensionResult> {
  if (process.platform !== 'win32') {
    return {
      ok: false,
      error: 'Local uninstall is only supported on Windows.',
      registryKeysRemoved: [],
    };
  }

  const registryKeysRemoved: string[] = [];
  for (const browser of TARGET_BROWSERS) {
    const removed = await regDeleteKey(browser.registryRoot);
    if (removed) {
      registryKeysRemoved.push(
        `HKCU\\${browser.registryRoot}\\${DUYA_BRIDGE_EXTENSION_ID}`,
      );
    }
  }

  return { ok: true, registryKeysRemoved };
}
