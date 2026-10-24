/**
 * Where a plugin's package files live, as seen by a standalone Host.
 *
 * ## The layout
 *
 * The Desktop installs a plugin package under its Electron `userData`:
 *
 *   <userData>/plugins/installed/<id>            -> symlink to
 *   <userData>/plugins/cache/<marketplace>/<id>/<version>
 *
 * and the builtin plugins ship in the shared data root instead:
 *
 *   <dataRoot>/plugins/cache/builtin/<id>/<version>
 *
 * The Desktop resolves the link with `fs.realpathSync`
 * (`apps/desktop/src/main/plugins/cache/layout.ts:108`), so the install path
 * a consumer sees is the versioned cache directory, never the link itself.
 *
 * ## Why the Host looks at all
 *
 * `config.toml`'s `[plugins]` block is the only persisted source of the
 * installed-plugin list, but it carries the user's intent (`enabled`) and
 * nothing else. The worker gates plugin skills and plugin MCP servers on
 * `installPath` (`packages/host/src/worker-process-entry.ts:2551`,
 * `packages/plugin-core/src/mcp/collect.ts:87`), so without a path the
 * standalone Host silently drops every plugin.
 *
 * ## What this module does NOT do
 *
 * It only READS the filesystem. It never creates, links or removes a plugin
 * directory, and it never guesses a path it cannot see on disk: a plugin with
 * no package directory simply has no install path.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { resolveConfigRoot } from './agent-profile-config.js';

/** The cache segment the builtin plugins are stored under. */
const BUILTIN_MARKETPLACE = 'builtin';

/** The environment variable the CLI uses to point at a specific `userData`. */
const USER_DATA_OVERRIDE_ENV = 'DUYA_CLI_USER_DATA_DIR';

export interface PluginInstallPathOptions {
  /** Candidate roots, highest priority first. Defaults to the probed roots. */
  readonly roots?: readonly string[];
}

/**
 * The Electron `userData` directory the Desktop would use on this platform.
 *
 * Mirrors the CLI's own probe (`packages/cli/src/api/runtime-config.ts:117`)
 * so both sides agree on where a production install lives.
 */
export function platformUserDataDir(): string | null {
  if (process.platform === 'win32') {
    const appData = process.env.APPDATA;
    return appData ? path.join(appData, 'DUYA') : null;
  }
  if (process.platform === 'darwin') {
    return path.join(os.homedir(), 'Library', 'Application Support', 'DUYA');
  }
  const xdg = process.env.XDG_DATA_HOME;
  return xdg ? path.join(xdg, 'DUYA') : path.join(os.homedir(), '.local', 'share', 'DUYA');
}

/**
 * The roots that may hold installed plugin packages, highest priority first.
 *
 * An explicit config root wins outright: it names ONE directory, so probing
 * anywhere else would read another installation's plugins. Without it the
 * candidates are the shared data root, then the platform `userData` and its
 * `duya-dev` variant — the same shape the CLI probes for a Desktop runtime.
 *
 * Test runs stop at the data root so a test never reads the plugins of the
 * machine it runs on.
 */
export function collectPluginInstallRoots(configRootOverride?: string): string[] {
  if (configRootOverride) {
    return [configRootOverride];
  }

  const override = process.env[USER_DATA_OVERRIDE_ENV];
  if (override && override.trim().length > 0) {
    const absolute = path.isAbsolute(override) ? override : path.resolve(process.cwd(), override);
    return fs.existsSync(absolute) ? [absolute] : [];
  }

  const candidates: string[] = [resolveConfigRoot()];
  if (process.env.DUYA_TEST !== '1') {
    const userData = platformUserDataDir();
    if (userData) {
      candidates.push(userData, path.join(userData, 'duya-dev'));
    }
  }
  return dedupe(candidates);
}

/**
 * The directory holding the installed package of `pluginId`.
 *
 * The installed symlink wins over the builtin cache: it is what the Desktop
 * itself resolves, so a plugin that is both installed and cached resolves to
 * the same directory the Desktop would use.
 */
export function resolvePluginInstallPath(
  pluginId: string,
  options?: PluginInstallPathOptions,
): string | undefined {
  if (!pluginId) return undefined;
  const roots = options?.roots ?? collectPluginInstallRoots();
  for (const root of roots) {
    const installed = resolveExistingPath(path.join(root, 'plugins', 'installed', pluginId));
    if (installed) return installed;
    const builtin = resolveBuiltinCacheDir(root, pluginId);
    if (builtin) return builtin;
  }
  return undefined;
}

/**
 * The plugin's own data directory, when it exists.
 *
 * The Desktop keeps it next to the install root (`<root>/plugins-data/<id>`);
 * an MCP server that stores state needs it to write to the right place.
 */
export function resolvePluginDataPath(
  pluginId: string,
  options?: PluginInstallPathOptions,
): string | undefined {
  if (!pluginId) return undefined;
  const roots = options?.roots ?? collectPluginInstallRoots();
  for (const root of roots) {
    const dataPath = path.join(root, 'plugins-data', pluginId);
    if (fs.existsSync(dataPath)) return dataPath;
  }
  return undefined;
}

/**
 * The newest cached version of a builtin plugin.
 *
 * The version directories are compared the same way the Desktop compares
 * them (`listCachedVersions` sorts the directory names), so both sides pick
 * the same version.
 */
function resolveBuiltinCacheDir(root: string, pluginId: string): string | undefined {
  const base = path.join(root, 'plugins', 'cache', BUILTIN_MARKETPLACE, pluginId);
  let versions: string[];
  try {
    versions = fs
      .readdirSync(base, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
  } catch {
    return undefined;
  }
  const newest = versions[versions.length - 1];
  if (!newest) return undefined;
  const dir = path.join(base, newest);
  return fs.existsSync(dir) ? dir : undefined;
}

/**
 * The real path of `target`, or undefined when it is missing.
 *
 * `existsSync` follows symlinks, so a dangling install link reads as missing
 * — the same result the Desktop's `resolveInstalledSymlink` produces.
 */
function resolveExistingPath(target: string): string | undefined {
  try {
    if (!fs.existsSync(target)) return undefined;
    return fs.realpathSync(target);
  } catch {
    return undefined;
  }
}

/** Drop repeated roots while keeping their order. */
function dedupe(roots: readonly string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const root of roots) {
    const key = path.resolve(root).toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(root);
  }
  return result;
}
