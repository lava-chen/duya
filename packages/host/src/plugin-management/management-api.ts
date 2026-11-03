/**
 * management-api.ts — the Host's plugin and marketplace write side.
 *
 * ## What this is for
 *
 * Installing a plugin used to require an Electron window: every step — clone,
 * catalog read, cache swap, `config.toml` intent row — ran in the Desktop main
 * process. This module is that machinery moved to the Host, so any client of the
 * local control plane (the TUI first) can offer the same surface, and so there is
 * one implementation of the safety rules rather than two that drift.
 *
 * ## The rules this holds itself to
 *
 * - **A row is an install or it is nothing.** The Desktop writes a synthetic
 *   `plugin.json` when a catalog row has no source directory. Here, an install
 *   whose content cannot be fetched fails: the worker gates a plugin's skills
 *   and MCP servers on the installed directory, so an empty package would read
 *   as installed and do nothing.
 * - **Only the fields this surface names are rewritten.** `[plugins."<id>@<m>"]`
 *   keeps any other field the user wrote; `[providers.*]` and `[agents]` are not
 *   touched at all, because the namespace edit is surgical.
 * - **A mutation reads the files fresh.** There is no cache, because the other
 *   writer is a Desktop window a person is clicking in.
 * - **`expectedRevision` is optional.** Echoing the revision read with the list
 *   turns "the other surface changed this while my panel was open" into a
 *   refusal; omitting it is the caller choosing to write blind.
 * - **Uninstall does not delete a plugin's data unless asked.** State a plugin
 *   wrote belongs to the user, not to the package that was removed.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

import type {
  HostLocalPluginManagementApiV1,
  HostMarketplaceAddInput,
  HostMarketplaceList,
  HostMarketplaceMutationResult,
  HostMarketplaceRefreshResult,
  HostMarketplaceRemoveInput,
  HostMarketplaceSyncOutcome,
  HostPluginCatalogList,
  HostPluginEnabledInput,
  HostPluginInstallInput,
  HostPluginMutationResult,
  HostPluginRemoveInput,
  HostPluginRemoveResult,
} from '@duya/agent-protocol/plugin-management';
import {
  assertPathSegment,
  installPluginPackage,
  uninstallPluginPackage,
} from '@duya/plugin-core/install/package';
import { resolveInstalledLink } from '@duya/plugin-core/install/layout';
import {
  cloneMarketplace,
  clonePluginFromGit,
  marketplaceCloneDir,
  removeMarketplaceClone,
  resolveConfiguredMarketplaceDir,
  resolveSourceUrls,
  updateMarketplace,
  type MarketplaceGitLog,
  type MarketplaceSourceConfig,
} from '@duya/plugin-core/marketplace/git-source';
import {
  readMarketplaceManifest,
  resolvePluginEntryDir,
  type LoadedMarketplaceManifest,
  type MarketplacePluginEntry,
} from '@duya/plugin-core/marketplace/manifest';
import { isDefaultOfficialSource } from '@duya/plugin-core/marketplace/official-seeds';
import {
  MarketplaceSourceError,
  parseMarketplaceSource,
  safeMarketplaceDirName,
  type ParsedMarketplaceSource,
} from '@duya/plugin-core/marketplace/source-parse';

import { resolvePluginWriteRoot } from '../plugin-install-paths.js';
import { buildPluginCatalog, type CatalogBuild, type CatalogRow } from './plugin-catalog.js';
import {
  PluginFileError,
  parsePluginConfigKey,
  pluginFilePaths,
  readPluginSnapshot,
  revisionOf,
  toPluginConfigKey,
  writeMarketplaceTable,
  writePluginTable,
  type PluginFiles,
  type PluginIntent,
  type PluginSnapshot,
} from './plugin-files.js';
import { buildMarketplaceView, buildMarketplaceViews } from './plugin-marketplaces.js';

/** A refusal the HTTP layer can turn into a status without guessing. */
export class HostPluginApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'HostPluginApiError';
  }
}

export interface PluginManagementOptions {
  /** Directory holding `config.toml` and the plugin tree. */
  readonly root?: string | undefined;
  readonly log?: MarketplaceGitLog | undefined;
  /** Timestamp for a marketplace's `addedAt`; a test pins it to keep bytes stable. */
  readonly now?: (() => string) | undefined;
}

/**
 * Create the plugin management API.
 *
 * Mutations run through one queue: an install is a directory swap plus a config
 * read-modify-write, and neither half is atomic on its own. Two clients writing
 * `[plugins]` at once would otherwise lose one of them inside the window between
 * the read and the rename.
 */
export function createHostLocalPluginManagementApi(
  options: PluginManagementOptions = {},
): HostLocalPluginManagementApiV1 {
  const files = pluginFilePaths(options.root ?? resolvePluginWriteRoot());
  const log = options.log;
  const now = options.now ?? ((): string => new Date().toISOString());
  let tail: Promise<unknown> = Promise.resolve();
  const serialize = <T>(task: () => Promise<T>): Promise<T> => {
    const run = tail.then(task, task);
    tail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  };

  return {
    async listPluginCatalog(): Promise<HostPluginCatalogList> {
      let snapshot: PluginSnapshot;
      try {
        snapshot = await readPluginSnapshot(files);
      } catch (error) {
        return { entries: [], marketplaces: [], issues: [], revision: '', error: messageOf(error) };
      }
      const catalog = catalogOf(snapshot);
      return {
        entries: catalog.rows.map((row) => row.entry),
        marketplaces: catalog.marketplaceNames,
        issues: catalog.issues,
        revision: snapshot.revision,
      };
    },

    async listMarketplaces(): Promise<HostMarketplaceList> {
      let snapshot: PluginSnapshot;
      try {
        snapshot = await readPluginSnapshot(files);
      } catch (error) {
        return { marketplaces: [], revision: '', error: messageOf(error) };
      }
      return {
        marketplaces: buildMarketplaceViews(files.marketplacesRoot, snapshot.marketplaces).views,
        revision: snapshot.revision,
      };
    },

    async installPlugin(input: HostPluginInstallInput): Promise<HostPluginMutationResult> {
      return serialize(async () => {
        const pluginId = requirePluginId(input.pluginId);
        const wantedMarketplace = optionalMarketplace(input.marketplace);
        const enabled = requireBoolean(input.enabled, true, 'enabled');
        const snapshot = await openForWrite(files, optionalString(input.expectedRevision));
        const row = requireRow(catalogOf(snapshot), pluginId, wantedMarketplace, snapshot);
        const sourceDir = await materializeSource(row);
        const installed = installPluginPackage({
          roots: files.roots,
          marketplace: row.entry.marketplace,
          pluginId,
          version: row.entry.version,
          sourceDir,
          ...(log === undefined ? {} : { log }),
        });

        const key = toPluginConfigKey(pluginId, installed.marketplace);
        await persistPlugins(files, { ...snapshot.plugins, [key]: { enabled, extra: {} } });
        return {
          pluginId,
          marketplace: installed.marketplace,
          enabled,
          installed: true,
          version: installed.version,
          revision: await revisionOf(files),
        };
      });
    },

    async setPluginEnabled(input: HostPluginEnabledInput): Promise<HostPluginMutationResult> {
      return serialize(async () => {
        const pluginId = requirePluginId(input.pluginId);
        const enabled = requireBoolean(input.enabled, false, 'enabled');
        const snapshot = await openForWrite(files, optionalString(input.expectedRevision));
        const key = installedKeys(
          snapshot,
          pluginId,
          optionalMarketplace(input.marketplace),
        )[0];
        if (key === undefined) throw pluginNotFound(pluginId, input.marketplace);

        const next: Record<string, PluginIntent> = { ...snapshot.plugins };
        next[key] = { extra: { ...next[key]?.extra }, enabled };
        await persistPlugins(files, next);

        const link = resolveInstalledLink(files.roots, pluginId);
        const { marketplace } = parsePluginConfigKey(key);
        return {
          pluginId,
          marketplace,
          enabled,
          // Observed, not assumed: enabling a package the disk does not have
          // says so here rather than leaving the panel to discover it.
          installed: link !== null,
          ...(link === null ? {} : { version: path.basename(link) }),
          revision: await revisionOf(files),
        };
      });
    },

    async removePlugin(input: HostPluginRemoveInput): Promise<HostPluginRemoveResult> {
      return serialize(async () => {
        const pluginId = requirePluginId(input.pluginId);
        const wantedMarketplace = optionalMarketplace(input.marketplace);
        const snapshot = await openForWrite(files, optionalString(input.expectedRevision));
        const keys = installedKeys(snapshot, pluginId, wantedMarketplace);
        if (keys.length === 0) throw pluginNotFound(pluginId, input.marketplace);

        const removed: string[] = [];
        const next: Record<string, PluginIntent> = { ...snapshot.plugins };
        let marketplace = wantedMarketplace ?? '';
        for (const key of keys) {
          const parsed = parsePluginConfigKey(key);
          marketplace = parsed.marketplace;
          removed.push(
            ...uninstallPluginPackage({
              roots: files.roots,
              marketplace: parsed.marketplace,
              pluginId,
              deleteData: input.deleteData === true,
              ...(log === undefined ? {} : { log }),
            }),
          );
          delete next[key];
        }
        await persistPlugins(files, next);
        return {
          pluginId,
          marketplace,
          removedPaths: removed,
          revision: await revisionOf(files),
        };
      });
    },

    async addMarketplace(input: HostMarketplaceAddInput): Promise<HostMarketplaceMutationResult> {
      return serialize(async () => {
        const snapshot = await openForWrite(
          files,
          optionalString(input.expectedRevision),
        );
        const ref = optionalString(input.ref);
        const parsed = parseSource(input.source);
        let name: string;
        let stored: MarketplaceSourceConfig;

        if (parsed.kind === 'git') {
          const url = parsed.url ?? '';
          const provisional = slugFromUrl(url);
          if (isConfigured(snapshot.marketplaces, provisional)) {
            throw marketplaceExists(provisional);
          }
          let manifest: LoadedMarketplaceManifest;
          try {
            const clone = await cloneMarketplace({
              root: files.marketplacesRoot,
              urls: [url],
              name: provisional,
              ...(ref === undefined ? {} : { ref }),
              ...(log === undefined ? {} : { log }),
            });
            manifest = requireMarketplaceManifest(clone.dir);
          } catch (error) {
            removeCloneQuietly(files.marketplacesRoot, provisional);
            throw asAddError(error);
          }
          name = safeName(manifest.name);
          if (name !== provisional) {
            if (isConfigured(snapshot.marketplaces, name)) {
              removeCloneQuietly(files.marketplacesRoot, provisional);
              throw marketplaceExists(name);
            }
            renameClone(files.marketplacesRoot, provisional, name);
          }
          stored = { source: 'git', url, ...(ref === undefined ? {} : { ref }) };
        } else {
          const dir = parsed.path ?? '';
          if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) {
            throw new HostPluginApiError(
              400,
              'invalid_marketplace_source',
              `local marketplace directory not found: ${dir}`,
            );
          }
          stored = { source: 'local', path: dir, ...(ref === undefined ? {} : { ref }) };
          name = safeName(requireMarketplaceManifest(dir).name);
          if (isConfigured(snapshot.marketplaces, name)) throw marketplaceExists(name);
        }

        const added: MarketplaceSourceConfig = { ...stored, addedAt: now() };
        await persistMarketplaces(files, { ...snapshot.marketplaces, [name]: added });
        return {
          marketplace: buildMarketplaceView(files.marketplacesRoot, name, added),
          revision: await revisionOf(files),
        };
      });
    },

    async removeMarketplace(
      input: HostMarketplaceRemoveInput,
    ): Promise<HostMarketplaceMutationResult> {
      return serialize(async () => {
        const name = requireMarketplaceName(input.marketplace);
        const snapshot = await openForWrite(
          files,
          optionalString(input.expectedRevision),
        );
        const config = snapshot.marketplaces[name];
        if (config === undefined || config.removed === true) throw marketplaceNotFound(name);

        // Installed plugins outlive their marketplace by design — the package is
        // copied out of the clone — so this is a bookkeeping guard, not a
        // consistency one: leaving the row for an installed plugin that can no
        // longer be re-resolved is the confusing state.
        const installedFrom = Object.keys(snapshot.plugins).filter(
          (key) => parsePluginConfigKey(key).marketplace === name,
        );
        if (installedFrom.length > 0) {
          throw new HostPluginApiError(
            409,
            'marketplace_has_installed_plugins',
            `marketplace "${name}" still has installed plugins (${installedFrom.join(', ')}) — remove them first`,
          );
        }

        const view = buildMarketplaceView(files.marketplacesRoot, name, config);
        if (config.source === 'git') removeCloneQuietly(files.marketplacesRoot, name);
        const next: Record<string, MarketplaceSourceConfig> = { ...snapshot.marketplaces };
        if (isDefaultOfficialSource(name)) next[name] = { ...config, removed: true };
        else delete next[name];
        await persistMarketplaces(files, next);
        return { marketplace: view, revision: await revisionOf(files) };
      });
    },

    async refreshMarketplace(input: {
      readonly marketplace?: string;
      readonly expectedRevision?: string;
    }): Promise<HostMarketplaceRefreshResult> {
      return serialize(async () => {
        const wanted = optionalMarketplace(input.marketplace);
        const snapshot = await openForWrite(
          files,
          optionalString(input.expectedRevision),
        );
        const targets: Array<[string, MarketplaceSourceConfig]> = [];
        for (const [name, config] of Object.entries(snapshot.marketplaces)) {
          if (config.removed === true) continue;
          if (wanted === undefined) {
            // A hidden source contributes no catalog rows, so the unqualified
            // refresh skips it — the same rule the startup sync applies.
            if (config.hidden === true) continue;
          } else if (name !== wanted) {
            continue;
          }
          targets.push([name, config]);
        }
        if (wanted !== undefined && targets.length === 0) throw marketplaceNotFound(wanted);

        const outcomes: HostMarketplaceSyncOutcome[] = [];
        for (const [name, config] of targets) outcomes.push(await syncOne(name, config));
        return { outcomes, revision: await revisionOf(files) };
      });
    },
  };

  /** Fetch one source and report the result instead of throwing. */
  async function syncOne(
    name: string,
    config: MarketplaceSourceConfig,
  ): Promise<HostMarketplaceSyncOutcome> {
    if (config.source === 'local') {
      const dir = config.path ?? '';
      if (!fs.existsSync(dir)) {
        return { marketplace: name, error: `local marketplace directory is gone: ${dir}` };
      }
      try {
        readMarketplaceManifest(dir);
      } catch (error) {
        return { marketplace: name, error: messageOf(error) };
      }
      return { marketplace: name };
    }

    const urls = resolveSourceUrls(config);
    if (urls.length === 0) {
      return { marketplace: name, error: `marketplace "${name}" has no clone URL configured` };
    }
    const dir = resolveConfiguredMarketplaceDir(files.marketplacesRoot, name, config);
    if (dir === null) return { marketplace: name, error: 'no clone directory resolvable' };
    try {
      if (!fs.existsSync(dir)) {
        await cloneDir(name, urls, config.ref);
        return { marketplace: name };
      }
      try {
        await updateMarketplace({
          root: files.marketplacesRoot,
          dir,
          ...(config.ref === undefined ? {} : { ref: config.ref }),
        });
      } catch (error) {
        // A stale or corrupted shallow clone (failed fetch, force-push) is
        // recovered by re-cloning from scratch, walking every mirror — the
        // fallback the Desktop's sync uses.
        log?.warn('Marketplace update failed, re-cloning', { marketplace: name, error: messageOf(error) });
        removeMarketplaceClone(files.marketplacesRoot, name);
        await cloneDir(name, urls, config.ref);
      }
      return { marketplace: name };
    } catch (error) {
      return { marketplace: name, error: messageOf(error) };
    }
  }

  async function cloneDir(
    name: string,
    urls: string[],
    ref: string | undefined,
  ): Promise<void> {
    await cloneMarketplace({
      root: files.marketplacesRoot,
      urls,
      name,
      ...(ref === undefined ? {} : { ref }),
      ...(log === undefined ? {} : { log }),
    });
  }

  /** Copy a catalog row's package somewhere the installer can read. */
  async function materializeSource(row: CatalogRow): Promise<string> {
    const entry = row.pluginEntry;
    if (entry.source.source !== 'git') return sourceDirOf(row, entry);
    let clonedDir: string;
    try {
      const clone = await clonePluginFromGit({
        root: files.marketplacesRoot,
        url: entry.source.url,
        marketplace: row.entry.marketplace,
        pluginName: entry.name,
        ...(entry.source.ref_name === undefined ? {} : { ref: entry.source.ref_name }),
        ...(log === undefined ? {} : { log }),
      });
      clonedDir = clone.dir;
    } catch (error) {
      throw new HostPluginApiError(
        502,
        'plugin_clone_failed',
        `could not fetch plugin "${entry.name}" from ${entry.source.url}: ${messageOf(error)}`,
      );
    }
    return sourceDirOf(row, entry, clonedDir);
  }

  function sourceDirOf(
    row: CatalogRow,
    entry: MarketplacePluginEntry,
    gitDir?: string,
  ): string {
    let dir: string;
    try {
      dir = resolvePluginEntryDir(row.marketplaceDir, entry, gitDir);
    } catch (error) {
      throw new HostPluginApiError(
        409,
        'plugin_source_unavailable',
        `plugin "${entry.name}" declares a source this Host cannot read: ${messageOf(error)}`,
      );
    }
    if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) {
      throw new HostPluginApiError(
        409,
        'plugin_source_unavailable',
        `plugin "${entry.name}" has no package in this marketplace — refresh it and retry`,
      );
    }
    return dir;
  }

  function catalogOf(snapshot: PluginSnapshot): CatalogBuild {
    return buildPluginCatalog({
      marketplacesRoot: files.marketplacesRoot,
      marketplaces: snapshot.marketplaces,
      installed: snapshot.plugins,
    });
  }
}

/** The one catalog row for `pluginId`, or a refusal naming what was searched. */
function requireRow(
  catalog: CatalogBuild,
  pluginId: string,
  marketplace: string | undefined,
  snapshot: PluginSnapshot,
): CatalogRow {
  if (marketplace !== undefined && !isConfigured(snapshot.marketplaces, marketplace)) {
    throw marketplaceNotFound(marketplace);
  }
  const matches = catalog.rows.filter(
    (row) =>
      row.entry.pluginId === pluginId &&
      (marketplace === undefined || row.entry.marketplace === marketplace),
  );
  const row = matches[0];
  if (row === undefined) throw pluginNotFound(pluginId, marketplace);
  if (row.entry.installPolicy === 'not_available') {
    throw new HostPluginApiError(
      403,
      'plugin_install_not_available',
      `marketplace "${row.entry.marketplace}" marks "${pluginId}" as not installable`,
    );
  }
  return row;
}

/** Every `[plugins]` key for this plugin, optionally narrowed to one marketplace. */
function installedKeys(
  snapshot: PluginSnapshot,
  pluginId: string,
  marketplace: string | undefined,
): string[] {
  return Object.keys(snapshot.plugins).filter((key) => {
    const parsed = parsePluginConfigKey(key);
    return parsed.pluginId === pluginId && (marketplace === undefined || parsed.marketplace === marketplace);
  });
}

/** Read a snapshot, refusing to continue when it is stale or unwritable. */
async function openForWrite(files: PluginFiles, expectedRevision?: string): Promise<PluginSnapshot> {
  let snapshot: PluginSnapshot;
  try {
    snapshot = await readPluginSnapshot(files);
  } catch (error) {
    throw new HostPluginApiError(
      409,
      'plugin_config_unwritable',
      error instanceof PluginFileError
        ? error.message
        : `The plugin configuration could not be read: ${messageOf(error)}`,
    );
  }
  if (expectedRevision !== undefined && expectedRevision !== snapshot.revision) {
    throw new HostPluginApiError(
      409,
      'plugin_revision_conflict',
      'the plugin configuration changed since it was read; reload the list and re-apply',
    );
  }
  return snapshot;
}

async function persistPlugins(files: PluginFiles, intents: Record<string, PluginIntent>): Promise<void> {
  try {
    await writePluginTable(files, intents);
  } catch (error) {
    throw writeFailed('plugins', error);
  }
}

async function persistMarketplaces(
  files: PluginFiles,
  table: Record<string, MarketplaceSourceConfig>,
): Promise<void> {
  const clean: Record<string, MarketplaceSourceConfig> = {};
  for (const [name, config] of Object.entries(table)) {
    requireMarketplaceName(name);
    const entry: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(config)) {
      if (value !== undefined) entry[key] = value;
    }
    clean[name] = entry as unknown as MarketplaceSourceConfig;
  }
  try {
    await writeMarketplaceTable(files, clean);
  } catch (error) {
    throw writeFailed('marketplaces', error);
  }
}

function writeFailed(namespace: string, error: unknown): HostPluginApiError {
  // The TOML layer names the file and the parse problem, never a value; the
  // user still has to know which namespace failed to move.
  return new HostPluginApiError(
    500,
    'plugin_write_failed',
    `the \`${namespace}\` configuration could not be saved: ${messageOf(error)}`,
  );
}

function requireMarketplaceManifest(dir: string): LoadedMarketplaceManifest {
  let manifest: LoadedMarketplaceManifest | null;
  try {
    manifest = readMarketplaceManifest(dir);
  } catch (error) {
    throw new HostPluginApiError(400, 'invalid_marketplace_source', messageOf(error));
  }
  if (manifest === null) {
    throw new HostPluginApiError(400, 'invalid_marketplace_source', 'no marketplace.json found in this source');
  }
  return manifest;
}

function safeName(value: string): string {
  try {
    return safeMarketplaceDirName(value);
  } catch (error) {
    throw new HostPluginApiError(400, 'invalid_marketplace_source', messageOf(error));
  }
}

function parseSource(input: unknown): ParsedMarketplaceSource {
  if (typeof input !== 'string') {
    throw new HostPluginApiError(400, 'invalid_marketplace_source', 'source must be a string');
  }
  try {
    return parseMarketplaceSource(input);
  } catch (error) {
    throw asAddError(error);
  }
}

/** A source-parse refusal keeps its own code when it is about the host. */
function asAddError(error: unknown): HostPluginApiError {
  if (error instanceof HostPluginApiError) return error;
  if (error instanceof MarketplaceSourceError) {
    return new HostPluginApiError(
      400,
      error.code === 'blocked_host' ? 'blocked_marketplace_host' : 'invalid_marketplace_source',
      error.message,
    );
  }
  return new HostPluginApiError(500, 'plugin_write_failed', messageOf(error));
}

function renameClone(root: string, from: string, to: string): void {
  const source = marketplaceCloneDir(root, from);
  const destination = marketplaceCloneDir(root, to);
  try {
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.renameSync(source, destination);
  } catch (error) {
    removeCloneQuietly(root, from);
    throw new HostPluginApiError(500, 'plugin_write_failed', messageOf(error));
  }
}

function removeCloneQuietly(root: string, name: string): void {
  try {
    removeMarketplaceClone(root, name);
  } catch {
    // A clone directory that cannot be deleted is not worth failing an add over:
    // it is inside the cache, and the next refresh walks it.
  }
}

/** `owner/repo` or `<host>/<org>/<repo>.git` → the last path segment, slugged. */
function slugFromUrl(url: string): string {
  const withoutSuffix = url.replace(/\.git$/, '');
  const last = withoutSuffix.split(/[/:]/).filter(Boolean).pop() ?? 'marketplace';
  return safeName(last);
}

function isConfigured(
  marketplaces: Readonly<Record<string, MarketplaceSourceConfig>>,
  name: string,
): boolean {
  const config = marketplaces[name];
  return config !== undefined && config.removed !== true;
}

function requirePluginId(value: unknown): string {
  const id = typeof value === 'string' ? value.trim() : '';
  if (id === '') throw new HostPluginApiError(400, 'invalid_plugin', 'pluginId is required');
  try {
    return assertPathSegment(id, 'plugin id');
  } catch {
    throw new HostPluginApiError(
      400,
      'invalid_plugin',
      `plugin id ${JSON.stringify(id)} cannot be used as a directory name`,
    );
  }
}

function requireMarketplaceName(value: unknown): string {
  const name = optionalMarketplace(value);
  if (name === undefined) {
    throw new HostPluginApiError(400, 'invalid_marketplace', 'marketplace is required');
  }
  return name;
}

/** A trimmed optional string, or undefined when absent or blank. */
function optionalString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed === '' ? undefined : trimmed;
}

/** An optional marketplace name — a value that also has to survive as a path segment. */
function optionalMarketplace(value: unknown): string | undefined {
  const name = optionalString(value);
  if (name === undefined) return undefined;
  try {
    return assertPathSegment(name, 'marketplace');
  } catch {
    throw new HostPluginApiError(
      400,
      'invalid_marketplace',
      `marketplace ${JSON.stringify(name)} cannot be used as a name`,
    );
  }
}

function requireBoolean(value: unknown, fallback: boolean, label: string): boolean {
  if (value === undefined || value === null) return fallback;
  if (typeof value !== 'boolean') {
    throw new HostPluginApiError(400, 'invalid_plugin', `${label} must be a boolean`);
  }
  return value;
}

function pluginNotFound(pluginId: string, marketplace: unknown): HostPluginApiError {
  const suffix = typeof marketplace === 'string' && marketplace !== '' ? ` in marketplace "${marketplace}"` : '';
  return new HostPluginApiError(404, 'plugin_not_found', `no plugin "${pluginId}" offered${suffix}`);
}

function marketplaceNotFound(name: string): HostPluginApiError {
  return new HostPluginApiError(404, 'marketplace_not_found', `marketplace "${name}" is not configured`);
}

function marketplaceExists(name: string): HostPluginApiError {
  return new HostPluginApiError(409, 'marketplace_exists', `marketplace "${name}" is already configured`);
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
