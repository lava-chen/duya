/**
 * The plugin registry a standalone Host serves to the worker.
 *
 * ## What is persisted
 *
 * `config.toml`'s `[plugins]` block is the ONLY persisted source of the
 * installed-plugin list (plan 334 decision 11): the key is the composite
 * `<pluginId>@<marketplace>` and the value carries the user intent
 * (`enabled`). Everything else the Desktop registry exposes — the install
 * path, the manifest, the granted permissions — is DERIVED there, from
 * the installed package under the Desktop's Electron `userData`.
 *
 * ## What a standalone Host cannot say
 *
 * The package files live under the Electron `userData` directory
 * (`%APPDATA%/duya`, `~/Library/Application Support/duya`), NOT under the
 * shared data root the Host reads. A standalone Host therefore has no
 * install directory to point at, and this API reports what is true and
 * stops there — it does not invent an `installPath`.
 *
 * ## What the worker does with the answer
 *
 *  - `discoverPluginSkillPaths` requires `installPath`; without it the
 *    plugin contributes no skill directory, so plugin skills stay
 *    unavailable in a standalone Host.
 *  - The MCP collector requires `installPath` too; without it the plugin
 *    declares no MCP server.
 *  - The enabled-plugin set is derived from `id` + `enabled`, and that IS
 *    available here.
 *
 * Answering honestly still beats failing the action: the worker logs a
 * warning for a failed lookup and continues with an empty plugin set, so
 * the gap is invisible.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { parse as parseToml } from '@iarna/toml';
import { resolveConfigRoot } from './agent-profile-config.js';

/** The marketplace an entry without an `@` suffix is attributed to. */
const DEFAULT_MARKETPLACE = 'official';

/**
 * One installed plugin as the standalone Host knows it.
 *
 * The field names match the Desktop's registry entries so the worker can
 * read one shape from either side. `installPath` and `manifest` are
 * deliberately absent: they describe the Desktop's install directory.
 */
export interface HostPluginRegistryEntry {
  readonly id: string;
  readonly name: string;
  readonly enabled: boolean;
  readonly marketplace: string;
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

  const entries: HostPluginRegistryEntry[] = [];
  for (const [key, value] of Object.entries(plugins as Record<string, unknown>)) {
    const { id, marketplace } = parseCompositeKey(key);
    if (!id) continue;
    entries.push({ id, name: id, enabled: readEnabled(value), marketplace });
  }
  return entries;
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
