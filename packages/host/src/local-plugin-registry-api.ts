/**
 * The plugin registry a standalone Host serves to the worker.
 *
 * ## What is persisted
 *
 * `config.toml`'s `[plugins]` block is the ONLY persisted source of the
 * installed-plugin list (plan 334 decision 11): the key is the composite
 * `<pluginId>@<marketplace>` and the value carries the user intent
 * (`enabled`). Everything else the Desktop registry exposes — the install
 * path, the manifest, the granted permissions — is DERIVED there, from the
 * installed package under the Desktop's Electron `userData`.
 *
 * ## What a standalone Host can derive
 *
 * The package files live under the Electron `userData` directory
 * (`%APPDATA%/duya`, `~/Library/Application Support/duya`) or, for the builtin
 * plugins, under the shared data root. The Host probes both layouts and
 * reports the directory it can actually see (`plugin-install-paths.ts`).
 * A plugin with no package directory on disk gets no path — the Host never
 * points at a directory it cannot serve.
 *
 * ## What the worker does with the answer
 *
 *  - `discoverPluginSkillPaths` requires `installPath`; with it the plugin's
 *    skill directory loads.
 *  - The MCP collector requires `installPath` and the manifest's MCP
 *    declarations; both come from the same package directory.
 *  - The enabled-plugin set is derived from `id` + `enabled`.
 *
 * Answering honestly still beats failing the action: the worker logs a
 * warning for a failed lookup and continues with an empty plugin set, so the
 * gap is invisible.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { parse as parseToml } from '@iarna/toml';
import { discoverPluginMcpServers } from '@duya/plugin-core/plugins/loader/capability-discovery';
import type { McpServerCapability } from '@duya/plugin-core/plugins/loader/capability-discovery';
import { resolveConfigRoot } from './agent-profile-config.js';
import {
  collectPluginInstallRoots,
  resolvePluginDataPath,
  resolvePluginInstallPath,
} from './plugin-install-paths.js';

/** The marketplace an entry without an `@` suffix is attributed to. */
const DEFAULT_MARKETPLACE = 'official';

/**
 * The minimal manifest shape the worker consumes.
 *
 * The collector only reads `capabilities.mcpServers`; the rest of the
 * Desktop's manifest (apps, permissions, icons) stays in the Desktop.
 */
export interface HostPluginManifest {
  readonly capabilities?: {
    readonly mcpServers?: readonly McpServerCapability[];
  };
}

/**
 * One installed plugin as the standalone Host knows it.
 *
 * The field names match the Desktop's registry entries so the worker can
 * read one shape from either side. `installPath`, `dataPath` and `manifest`
 * are present only when the Host can see the plugin's package directory.
 */
export interface HostPluginRegistryEntry {
  readonly id: string;
  readonly name: string;
  readonly enabled: boolean;
  readonly marketplace: string;
  /** The package directory of the installed plugin, when it can be found. */
  readonly installPath?: string | undefined;
  /** The plugin's own data directory, when it exists. */
  readonly dataPath?: string | undefined;
  /** The manifest declarations read from the package directory. */
  readonly manifest?: HostPluginManifest | undefined;
}

export interface HostLocalPluginRegistryApiV1 {
  listPlugins(): HostPluginRegistryEntry[];
}

/**
 * Split the composite `<pluginId>@<marketplace>` key.
 *
 * The id may itself contain `@`, so the LAST `@` is the separator — the
 * same rule the Desktop's registry store uses.
 */
function parseCompositeKey(key: string): { id: string; marketplace: string } {
  const at = key.lastIndexOf('@');
  if (at <= 0) {
    return { id: key, marketplace: DEFAULT_MARKETPLACE };
  }
  return { id: key.slice(0, at), marketplace: key.slice(at + 1) };
}

/**
 * The user's intent for one plugin.
 *
 * An entry that omits `enabled` counts as enabled — the Desktop registry
 * store applies the same default.
 */
function readEnabled(value: unknown): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return true;
  return (value as { enabled?: unknown }).enabled !== false;
}

/**
 * Read the installed-plugin list from `config.toml`.
 *
 * READ-ONLY, like every other config reader in the Host: `config.toml` is
 * hand-edited, and a bad write there must not take the worker down.
 */
export function readPluginRegistry(configRootOverride?: string): HostPluginRegistryEntry[] {
  const configPath = path.join(configRootOverride ?? resolveConfigRoot(), 'config.toml');
  let raw: string;
  try {
    raw = fs.readFileSync(configPath, 'utf8');
  } catch {
    return [];
  }
  let parsed: unknown;
  try {
    parsed = parseToml(raw);
  } catch {
    return [];
  }
  const plugins = (parsed as { plugins?: unknown } | null)?.plugins;
  if (!plugins || typeof plugins !== 'object' || Array.isArray(plugins)) return [];

  const roots = collectPluginInstallRoots(configRootOverride);
  const entries: HostPluginRegistryEntry[] = [];
  for (const [key, value] of Object.entries(plugins as Record<string, unknown>)) {
    const { id, marketplace } = parseCompositeKey(key);
    if (!id) continue;
    entries.push(
      withInstalledFiles(
        { id, name: id, enabled: readEnabled(value), marketplace },
        id,
        roots,
      ),
    );
  }
  return entries;
}

/**
 * Attach the on-disk facts of a plugin to its registry entry.
 *
 * A disabled plugin is not loaded by the worker, so there is no reason to
 * walk its package directory.
 */
function withInstalledFiles(
  entry: HostPluginRegistryEntry,
  pluginId: string,
  roots: readonly string[],
): HostPluginRegistryEntry {
  if (!entry.enabled) return entry;
  const installPath = resolvePluginInstallPath(pluginId, { roots });
  if (!installPath) return entry;
  const dataPath = resolvePluginDataPath(pluginId, { roots });
  const manifest = readPluginManifestShape(installPath);
  return {
    ...entry,
    installPath,
    ...(dataPath === undefined ? {} : { dataPath }),
    ...(manifest === undefined ? {} : { manifest }),
  };
}

/**
 * The MCP declarations of an installed plugin.
 *
 * The discovery is the same one the Desktop's manifest reader uses
 * (`@duya/plugin-core/plugins/loader/capability-discovery`), so both sides
 * see the same servers for the same package directory.
 */
function readPluginManifestShape(installPath: string): HostPluginManifest | undefined {
  try {
    const mcpServers = discoverPluginMcpServers(installPath);
    if (mcpServers.length === 0) return undefined;
    return { capabilities: { mcpServers } };
  } catch {
    return undefined;
  }
}

/** The Host's plugin registry, read from the shared config root. */
export function createHostLocalPluginRegistryApi(
  configRootOverride?: string,
): HostLocalPluginRegistryApiV1 {
  return {
    listPlugins() {
      return readPluginRegistry(configRootOverride);
    },
  };
}
