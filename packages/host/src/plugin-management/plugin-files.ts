/**
 * plugin-files.ts — the on-disk half of plugin management.
 *
 * ## One file, two namespaces
 *
 * `config.toml` holds both halves of the plugin story: `[plugins."<id>@<market>"]`
 * is the user's intent (`enabled`) for a plugin the disk already has, and
 * `[marketplaces.<name>]` is where the catalogs came from. Nothing else about an
 * installation is persisted — the install path is probed from disk every read
 * (`plugin-install-paths.ts`), which is why an install here has to leave a real
 * package behind or the row it writes is a lie.
 *
 * ## Why the whole namespace is rewritten
 *
 * `writeConfigNamespace` edits one root table surgically and verifies the result
 * by re-parsing, so an unrelated `[agents]` block keeps its comments and layout
 * while this surface replaces `[plugins]` with what it read plus one change. The
 * read-modify-write is serialized by the caller and fenced by `expectedRevision`,
 * because the other writer is a Desktop window a person is clicking in.
 */

import * as path from 'node:path';
import { createHash } from 'node:crypto';
import type { MarketplaceSourceConfig } from '@duya/plugin-core/marketplace/git-source';
import type { PluginRoots } from '@duya/plugin-core/install/layout';
import { marketplacesCacheRoot } from '@duya/plugin-core/install/layout';
import {
  readConfigNamespace,
  readConfigTomlDocument,
  readRawConfig,
  writeConfigNamespace,
} from '../config-agents/config-file.js';

/**
 * The user's intent for one installed plugin.
 *
 * `enabled` is the only field this surface names; `extra` is every other field
 * the file holds, carried through the write so a hand-configured plugin row
 * (`path`, a note, a field this Host does not know about) survives an enable
 * rather than being silently reduced to one boolean.
 */
export interface PluginIntent {
  enabled?: boolean;
  readonly extra: Record<string, unknown>;
}

/** The `[plugins."<key>"]` table as it goes back into the file. */
export function toPluginTable(intent: PluginIntent): Record<string, unknown> {
  return {
    ...intent.extra,
    ...(intent.enabled === undefined ? {} : { enabled: intent.enabled }),
  };
}

/** The three places a plugin write touches. */
export interface PluginFiles {
  readonly configPath: string;
  readonly roots: PluginRoots;
  readonly marketplacesRoot: string;
}

export function pluginFilePaths(writeRoot: string): PluginFiles {
  const roots: PluginRoots = { rootDir: writeRoot };
  return {
    configPath: path.join(writeRoot, 'config.toml'),
    roots,
    marketplacesRoot: marketplacesCacheRoot(roots),
  };
}

/** The composite `[plugins]` key. `official` is the pre-attribution default. */
export function toPluginConfigKey(pluginId: string, marketplace: string): string {
  return `${pluginId}@${marketplace || 'official'}`;
}

export function parsePluginConfigKey(key: string): { pluginId: string; marketplace: string } {
  const at = key.lastIndexOf('@');
  if (at <= 0) return { pluginId: key, marketplace: 'official' };
  return { pluginId: key.slice(0, at), marketplace: key.slice(at + 1) };
}

/** Both namespaces as one snapshot, plus the revision the file hashes to. */
export interface PluginSnapshot {
  readonly plugins: Record<string, PluginIntent>;
  readonly marketplaces: Record<string, MarketplaceSourceConfig>;
  readonly revision: string;
}

/** The file state is not something this surface may write over. */
export class PluginFileError extends Error {}

/**
 * Read `[plugins]` and `[marketplaces]` as one snapshot.
 *
 * A namespace that exists in a shape other than a table is reported, not read as
 * empty: `[plugins]` as `[[plugins]]` would otherwise survive as "no plugins
 * installed" and the next write would delete the user's configuration.
 */
export async function readPluginSnapshot(files: PluginFiles): Promise<PluginSnapshot> {
  const doc = await readConfigTomlDocument(files.configPath);
  return {
    plugins: readIntentTable(doc),
    marketplaces: readMarketplaceTable(doc),
    revision: await revisionOf(files),
  };
}

function readIntentTable(doc: Record<string, unknown>): Record<string, PluginIntent> {
  let raw: Record<string, unknown>;
  try {
    raw = readConfigNamespace(doc, 'plugins');
  } catch (error) {
    throw new PluginFileError(error instanceof Error ? error.message : String(error));
  }
  const out: Record<string, PluginIntent> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      throw new PluginFileError(
        `config.toml \`plugins."${key}"\` is not a table; fix the file by hand — nothing here rewrites it`,
      );
    }
    const entry = value as Record<string, unknown>;
    const extra = { ...entry };
    delete extra.enabled;
    out[key] = typeof entry.enabled === 'boolean' ? { enabled: entry.enabled, extra } : { extra };
  }
  return out;
}

function readMarketplaceTable(doc: Record<string, unknown>): Record<string, MarketplaceSourceConfig> {
  let raw: Record<string, unknown>;
  try {
    raw = readConfigNamespace(doc, 'marketplaces');
  } catch (error) {
    throw new PluginFileError(error instanceof Error ? error.message : String(error));
  }
  const out: Record<string, MarketplaceSourceConfig> = {};
  for (const [name, value] of Object.entries(raw)) {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      throw new PluginFileError(
        `config.toml \`marketplaces."${name}"\` is not a table; fix the file by hand — nothing here rewrites it`,
      );
    }
    const entry = value as Record<string, unknown>;
    if (entry.source !== 'git' && entry.source !== 'local') {
      throw new PluginFileError(
        `config.toml \`marketplaces."${name}".source\` must be "git" or "local"; nothing here rewrites it`,
      );
    }
    out[name] = entry as unknown as MarketplaceSourceConfig;
  }
  return out;
}

/**
 * A content hash of `config.toml`, as short as a row can be.
 *
 * `''` when the file does not exist: "no configuration yet" is one value, and a
 * client that echoes it back proves nothing appeared while its panel was open.
 */
export async function revisionOf(files: PluginFiles): Promise<string> {
  const raw = await readRawConfig(files.configPath);
  if (raw === null) return '';
  return createHash('sha256').update(raw).digest('hex').slice(0, 16);
}

/** Replace `[plugins]` with `intents`, leaving every other byte of the file alone. */
export async function writePluginTable(
  files: PluginFiles,
  intents: Record<string, PluginIntent>,
): Promise<void> {
  const table: Record<string, unknown> = {};
  for (const [key, intent] of Object.entries(intents)) table[key] = toPluginTable(intent);
  await writeConfigNamespace(files.configPath, 'plugins', table);
}

/** Replace `[marketplaces]` with `table`, leaving every other byte alone. */
export async function writeMarketplaceTable(
  files: PluginFiles,
  table: Record<string, MarketplaceSourceConfig>,
): Promise<void> {
  await writeConfigNamespace(files.configPath, 'marketplaces', table as Record<string, unknown>);
}
