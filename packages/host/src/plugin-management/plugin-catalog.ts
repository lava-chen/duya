/**
 * plugin-catalog.ts — what the configured marketplaces offer, as a Host row.
 *
 * ## The row is display plus coordinates, not a manifest
 *
 * A catalog row answers "what is this plugin called, what does it do, and where
 * would its files come from". It deliberately does not run the plugin loader:
 * capabilities, permissions and MCP declarations are what the worker gates on,
 * and those are read from the INSTALLED package by `local-plugin-registry-api.ts`
 * — never from a remote catalog. Keeping the two readers apart is what stops a
 * marketplace from being able to declare a capability a user then trusts.
 *
 * ## Failures degrade one step at a time
 *
 * A marketplace whose clone is missing or whose catalog does not parse becomes a
 * named issue, not an empty catalog, and one unreadable plugin entry is skipped
 * while its siblings still list. A surface that shows 200 plugins from three
 * sources must be able to say that the fourth source is broken.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

import { allPluginManifestPaths } from '@duya/plugin-core/formats/registry';
import {
  resolveConfiguredMarketplaceDir,
  type MarketplaceSourceConfig,
} from '@duya/plugin-core/marketplace/git-source';
import {
  readMarketplaceManifest,
  resolvePluginEntryDir,
  type MarketplacePluginEntry,
} from '@duya/plugin-core/marketplace/manifest';
import type {
  HostMarketplaceIssue,
  HostPluginCatalogEntry,
} from '@duya/agent-protocol/plugin-management';

import type { PluginIntent } from './plugin-files.js';
import { toPluginConfigKey } from './plugin-files.js';

/** The fields a catalog row needs from a plugin manifest, however it is spelled. */
interface PackageMetadata {
  id?: string;
  name?: string;
  version?: string;
  description?: string;
  displayName?: string;
  shortDescription?: string;
  longDescription?: string;
  category?: string;
}

/** A catalog row plus the coordinates an install needs to fetch it. */
export interface CatalogRow {
  readonly entry: HostPluginCatalogEntry;
  /** The marketplace directory as of this read (a refresh may move it). */
  readonly marketplaceDir: string;
  /** The declared package source, kept for the install step. */
  readonly pluginEntry: MarketplacePluginEntry;
}

export interface CatalogBuild {
  readonly rows: readonly CatalogRow[];
  readonly issues: readonly HostMarketplaceIssue[];
  readonly marketplaceNames: readonly string[];
}

export interface CatalogBuildInput {
  readonly marketplacesRoot: string;
  readonly marketplaces: Readonly<Record<string, MarketplaceSourceConfig>>;
  readonly installed: Readonly<Record<string, PluginIntent>>;
}

/**
 * Read every non-removed marketplace's catalog.
 *
 * Plugin ids are deduplicated first-wins in `[marketplaces]` order, which is the
 * Desktop's rule: the duya source is configured before the mirrors, so a plugin
 * offered by several ecosystems resolves to the same id the Desktop would
 * install.
 */
export function buildPluginCatalog(input: CatalogBuildInput): CatalogBuild {
  const rows: CatalogRow[] = [];
  const issues: HostMarketplaceIssue[] = [];
  const marketplaceNames: string[] = [];
  const seen = new Set<string>();

  for (const [name, config] of Object.entries(input.marketplaces)) {
    if (config.removed === true) continue;
    marketplaceNames.push(name);

    const dir = resolveConfiguredMarketplaceDir(input.marketplacesRoot, name, config);
    if (dir === null || !fs.existsSync(dir)) {
      issues.push({ marketplace: name, error: 'not synced yet' });
      continue;
    }

    let manifest: ReturnType<typeof readMarketplaceManifest>;
    try {
      manifest = readMarketplaceManifest(dir);
    } catch (error) {
      issues.push({
        marketplace: name,
        error: error instanceof Error ? error.message : String(error),
      });
      continue;
    }
    if (manifest === null) {
      issues.push({ marketplace: name, error: 'no marketplace.json found' });
      continue;
    }
    // A hidden source keeps its entry count in the marketplace list but
    // contributes nothing to the catalog — the same rule the Desktop applies.
    if (config.hidden === true) continue;

    for (const pluginEntry of manifest.plugins) {
      const row = buildRow(name, dir, pluginEntry, input.installed);
      if (row === null || seen.has(row.entry.pluginId)) continue;
      seen.add(row.entry.pluginId);
      rows.push(row);
    }
  }

  return { rows, issues, marketplaceNames };
}

function buildRow(
  marketplace: string,
  marketplaceDir: string,
  pluginEntry: MarketplacePluginEntry,
  installed: Readonly<Record<string, PluginIntent>>,
): CatalogRow | null {
  if (pluginEntry.source.source !== 'local' && pluginEntry.source.source !== 'git') {
    return null;
  }

  // A git-source plugin has no directory until it is cloned, so its row is
  // built from the catalog declaration alone and `requiresClone` says why the
  // copy is not there yet.
  let packageDir: string | null = null;
  if (pluginEntry.source.source === 'local') {
    try {
      packageDir = resolvePluginEntryDir(marketplaceDir, pluginEntry);
    } catch {
      return null;
    }
    if (!fs.existsSync(packageDir)) return null;
  }

  const metadata = packageDir === null ? {} : readPackageMetadata(packageDir);
  const pluginId = metadata.id ?? `com.duya.${pluginEntry.name}`;
  const intent = installed[toPluginConfigKey(pluginId, marketplace)];
  const displayName = metadata.displayName ?? (packageDir === null ? undefined : metadata.name);
  const category = pluginEntry.category ?? metadata.category;

  // A field the package does not declare stays absent rather than spelled
  // `undefined`: the contract is exactOptionalPropertyTypes-clean on the wire.
  const entry: HostPluginCatalogEntry = {
    pluginId,
    marketplace,
    name: metadata.name ?? pluginEntry.name,
    version: metadata.version ?? '0.0.0',
    trustLevel: marketplace === 'official' ? 'official' : 'verified',
    installPolicy: pluginEntry.policy?.installation ?? 'available',
    installed: intent !== undefined,
    enabled: intent?.enabled !== false,
    requiresClone: pluginEntry.source.source === 'git',
    ...(displayName === undefined ? {} : { displayName }),
    ...(metadata.description === undefined ? {} : { description: metadata.description }),
    ...(metadata.shortDescription === undefined
      ? {}
      : { shortDescription: metadata.shortDescription }),
    ...(metadata.longDescription === undefined
      ? {}
      : { longDescription: metadata.longDescription }),
    ...(category === undefined ? {} : { category }),
    ...(pluginEntry.policy?.authentication === undefined
      ? {}
      : { authPolicy: pluginEntry.policy.authentication }),
  };
  return { entry, marketplaceDir, pluginEntry };
}

const MANIFEST_PATHS = allPluginManifestPaths();

/**
 * The display fields of a package manifest, lenient by construction.
 *
 * Probes every adapter's manifest path (duya native first) and reads only
 * top-level scalars and the `interface` block. A manifest that does not parse
 * yields nothing rather than throwing, because one broken package must not
 * remove the other two hundred rows.
 */
function readPackageMetadata(pluginDir: string): PackageMetadata {
  for (const relPath of MANIFEST_PATHS) {
    const candidate = path.join(pluginDir, relPath);
    if (!fs.existsSync(candidate)) continue;
    let raw: unknown;
    try {
      raw = JSON.parse(fs.readFileSync(candidate, 'utf8'));
    } catch {
      return {};
    }
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return {};
    const doc = raw as Record<string, unknown>;
    const iface = asRecord(doc.interface);
    const out: PackageMetadata = {};
    const id = asString(doc.id);
    if (id !== undefined) out.id = id;
    const name = asString(doc.name);
    if (name !== undefined) out.name = name;
    const version = asString(doc.version);
    if (version !== undefined && version !== '0.0.0') out.version = version;
    const description = asString(doc.description);
    if (description !== undefined) out.description = description;
    const displayName = iface === null ? undefined : asString(iface.displayName);
    if (displayName !== undefined) out.displayName = displayName;
    const shortDescription = iface === null ? undefined : asString(iface.shortDescription);
    if (shortDescription !== undefined) out.shortDescription = shortDescription;
    const longDescription = iface === null ? undefined : asString(iface.longDescription);
    if (longDescription !== undefined) out.longDescription = longDescription;
    const category = iface === null ? undefined : asString(iface.category);
    if (category !== undefined) out.category = category;
    return out;
  }
  return {};
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function asString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed === '' ? undefined : trimmed;
}
