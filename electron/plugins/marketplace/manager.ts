// manager.ts — marketplace lifecycle: add / remove / refresh / sync-all
// (Plan 455). Codex parity (doc 17.4/17.5): a marketplace is a git repo
// (or local dir) holding a `marketplace.json` catalog; the identity is the
// manifest `name`, the clone lives under the marketplaces cache root, and
// every mutation is atomic and contained.
import fs from 'fs';
import path from 'path';
import { getConfigStore } from '../../config/store-instance';
import { getLogger, LogComponent } from '../../logging/logger';
import {
  MarketplaceSourceError,
  parseMarketplaceSource,
  safeMarketplaceDirName,
} from '../../../packages/plugin-core/src/marketplace/source-parse';
import {
  cloneMarketplace,
  getMarketplaceCloneDir,
  removeMarketplaceClone,
  resolveConfiguredMarketplaceDir,
  resolveSourceUrls,
  updateMarketplace,
  type MarketplaceSourceConfig,
} from './git-source';
import { readMarketplaceManifest } from './manifest';
import { getMarketplaceStatuses, readConfigMarketplaces } from '../catalog';

const COMPONENT = 'PluginMarketplaceManager' as LogComponent;

/** Plan 455 D6 — the pre-seeded official marketplace. Sync failures are
 *  WARN-only so first launch works offline.
 *  Plan 529: there are now two default sources seeded together — the
 *  legacy DUYA official (gitee primary, github mirror, plan 528) and
 *  Anthropic's `claude-plugins-official`. They appear as separate tabs
 *  in the UI; the catalog layer dedups by plugin id (first-wins). */
export const DEFAULT_OFFICIAL_MARKETPLACE = 'official';
export const DEFAULT_OFFICIAL_SOURCES: ReadonlyArray<MarketplaceSourceConfig> = [
  {
    source: 'git',
    displayName: 'DUYA Official',
    // Gitee primary (国内 + 海外连接都好), GitHub mirror as fallback.
    // plan 528 — marketplace source fallback / mirror.
    urls: [
      'https://gitee.com/lava-chen/duya-marketplace.git',
      'https://github.com/lava-chen/duya-marketplace.git',
    ],
  },
  {
    source: 'git',
    displayName: 'Claude Code Official',
    // anthropics/claude-plugins-official — Anthropic-managed, 36.2k
    // stars, Apache 2.0, the canonical Claude Code plugin directory.
    // plan 529 — second seeded marketplace.
    urls: ['https://github.com/anthropics/claude-plugins-official.git'],
  },
];
/** Back-compat shim: legacy code that imports the singular form. */
export const DEFAULT_OFFICIAL_SOURCE: MarketplaceSourceConfig =
  DEFAULT_OFFICIAL_SOURCES[0];

export interface MarketplaceView {
  name: string;
  displayName?: string;
  kind: 'git' | 'local';
  url?: string;
  path?: string;
  ref?: string;
  addedAt?: string;
  /** Present when the clone is missing or the manifest is unreadable. */
  error?: string;
  pluginCount: number;
  pluginNames: string[];
}

export interface MarketplaceSyncOutcome {
  marketplace: string;
  error?: string;
}

function writeConfigMarketplaces(entries: Record<string, MarketplaceSourceConfig & { addedAt?: string }>): void {
  getConfigStore().set('marketplaces', entries);
}

/** List every configured marketplace with its live sync status. */
export function listMarketplaces(): MarketplaceView[] {
  const configs = readConfigMarketplaces();
  const statuses = new Map(getMarketplaceStatuses().map((s) => [s.marketplace, s]));

  return Object.entries(configs).map(([name, cfg]) => {
    const status = statuses.get(name);
    let displayName: string | undefined;
    let pluginNames: string[] = [];

    if (!status?.error) {
      const dir = resolveConfiguredMarketplaceDir(name, cfg);
      try {
        const manifest = dir ? readMarketplaceManifest(dir) : null;
        displayName = manifest?.displayName ?? manifest?.name;
        pluginNames = manifest?.plugins.map((p) => p.name) ?? [];
      } catch {
        // Status already carries the error; leave metadata empty.
      }
    }

    return {
      name,
      displayName,
      kind: cfg.source,
      url: cfg.url,
      path: cfg.path,
      ref: cfg.ref,
      addedAt: cfg.addedAt,
      error: status?.error,
      pluginCount: status?.pluginCount ?? 0,
      pluginNames,
    };
  });
}

function slugFromUrl(url: string): string {
  const withoutSuffix = url.replace(/\.git$/, '');
  const last = withoutSuffix.split(/[/:]/).filter(Boolean).pop() ?? 'marketplace';
  return safeMarketplaceDirName(last);
}

/**
 * Add a marketplace from a user-supplied source string (codex
 * `marketplace_add` parity): parse → clone/validate → read the manifest →
 * adopt its `name` as identity → persist to ConfigStore `[marketplaces]`.
 */
export async function addMarketplace(input: string, ref?: string): Promise<MarketplaceView> {
  const logger = getLogger();
  const parsed = parseMarketplaceSource(input, ref);
  const configs = readConfigMarketplaces();

  let name: string;
  let stored: MarketplaceSourceConfig;

  if (parsed.kind === 'git') {
    const provisional = slugFromUrl(parsed.url!);
    if (configs[provisional]) {
      throw new Error(`marketplace "${provisional}" is already configured`);
    }
    const result = await cloneMarketplace({ urls: [parsed.url!], name: provisional, ref: parsed.ref });
    try {
      const manifest = readMarketplaceManifest(result.dir);
      if (!manifest) {
        throw new MarketplaceSourceError('invalid_request', 'no marketplace.json found in the cloned repo');
      }
      name = safeMarketplaceDirName(manifest.name);
      if (name !== provisional) {
        if (configs[name] || fs.existsSync(getMarketplaceCloneDir(name))) {
          removeMarketplaceClone(provisional);
          throw new Error(`marketplace "${name}" is already configured`);
        }
        fs.renameSync(getMarketplaceCloneDir(provisional), getMarketplaceCloneDir(name));
      }
    } catch (err) {
      removeMarketplaceClone(provisional);
      throw err;
    }
    stored = { source: 'git', url: parsed.url, ref: parsed.ref };
  } else {
    const dir = path.resolve(parsed.path!);
    if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) {
      throw new MarketplaceSourceError('invalid_request', `local marketplace directory not found: ${dir}`);
    }
    const manifest = readMarketplaceManifest(dir);
    if (!manifest) {
      throw new MarketplaceSourceError('invalid_request', 'no marketplace.json found in the local directory');
    }
    name = safeMarketplaceDirName(manifest.name);
    if (configs[name]) {
      throw new Error(`marketplace "${name}" is already configured`);
    }
    stored = { source: 'local', path: dir, ref: parsed.ref };
  }

  writeConfigMarketplaces({
    ...configs,
    [name]: { ...stored, addedAt: new Date().toISOString() },
  });
  logger.info('Marketplace added', { name, kind: stored.source }, COMPONENT);

  const view = listMarketplaces().find((m) => m.name === name);
  return view ?? { name, kind: stored.source, pluginCount: 0, pluginNames: [], ...stored };
}

/**
 * Remove a marketplace. Refuses while plugins installed from it remain —
 * remove those first (codex keeps installed plugins independent of the
 * marketplace, so this is a bookkeeping guard, not a data-consistency one).
 */
export function removeMarketplace(name: string): void {
  const configs = readConfigMarketplaces();
  if (!configs[name]) {
    throw new Error(`marketplace "${name}" is not configured`);
  }

  const plugins = getConfigStore().getByPath('plugins');
  const installedFrom = plugins && typeof plugins === 'object'
    ? Object.keys(plugins as Record<string, unknown>).filter((key) => key.endsWith(`@${name}`))
    : [];
  if (installedFrom.length > 0) {
    throw new Error(
      `marketplace "${name}" still has installed plugins (${installedFrom.join(', ')}) — remove them first`,
    );
  }

  if (configs[name].source === 'git') {
    removeMarketplaceClone(name);
  }
  const next = { ...configs };
  delete next[name];
  writeConfigMarketplaces(next);

  getLogger().info('Marketplace removed', { name }, COMPONENT);
}

/**
 * Re-sync one marketplace: git sources fetch + hard-reset (falling back to
 * a fresh clone), local sources are re-validated in place.
 */
export async function refreshMarketplace(name: string): Promise<MarketplaceView> {
  const logger = getLogger();
  const configs = readConfigMarketplaces();
  const cfg = configs[name];
  if (!cfg) {
    throw new Error(`marketplace "${name}" is not configured`);
  }

  if (cfg.source === 'local') {
    const dir = cfg.path ?? '';
    if (!fs.existsSync(dir)) {
      throw new Error(`local marketplace directory is gone: ${dir}`);
    }
  } else {
    const dir = getMarketplaceCloneDir(name);
    const urls = resolveSourceUrls(cfg);
    if (urls.length === 0) {
      throw new Error(`marketplace "${name}" has no clone URL configured`);
    }
    try {
      if (!fs.existsSync(dir)) {
        await cloneMarketplace({ urls, name, ref: cfg.ref });
      } else {
        await updateMarketplace({ dir, ref: cfg.ref });
      }
    } catch (err) {
      // Stale/broken clone (shallow fetch failure, force-push, ...) —
      // re-clone from scratch as the codex fallback path. plan 528
      // extends this so the re-clone walks every mirror, not just the
      // first URL.
      logger.warn('Marketplace update failed, re-cloning', {
        marketplace: name,
        error: err instanceof Error ? err.message : String(err),
      }, COMPONENT);
      removeMarketplaceClone(name);
      await cloneMarketplace({ urls, name, ref: cfg.ref });
    }
  }

  const view = listMarketplaces().find((m) => m.name === name);
  if (!view) {
    throw new Error(`marketplace "${name}" vanished during refresh`);
  }
  if (view.error) {
    throw new Error(`marketplace "${name}" refreshed with errors: ${view.error}`);
  }
  return view;
}

/**
 * Sync every configured marketplace, returning one outcome per
 * marketplace (Plan 455 Phase 4 startup sync consumes this).
 */
export async function syncAllMarketplaces(): Promise<MarketplaceSyncOutcome[]> {
  const configs = readConfigMarketplaces();
  const outcomes: MarketplaceSyncOutcome[] = [];
  for (const name of Object.keys(configs)) {
    try {
      await refreshMarketplace(name);
      outcomes.push({ marketplace: name });
    } catch (err) {
      outcomes.push({
        marketplace: name,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return outcomes;
}

/**
 * Seed the default official marketplace into `[marketplaces]` if absent
 * (Plan 455 user decision 2 + plan 529). No network I/O — the startup
 * sync performs the first clone and tolerates failure.
 *
 * Idempotent: existing entries are never overwritten so a user who has
 * manually removed a default source keeps their choice. The legacy
 * registry key 'official' is kept for back-compat with users who
 * already have it in config.toml; the Anthropic marketplace uses the
 * new 'claude-plugins-official' key.
 */
export function ensureOfficialMarketplace(): void {
  const configs = readConfigMarketplaces();
  const seeded: Array<{ name: string; url: string }> = [];
  for (let i = 0; i < DEFAULT_OFFICIAL_SOURCES.length; i++) {
    const source = DEFAULT_OFFICIAL_SOURCES[i];
    const name = i === 0 ? DEFAULT_OFFICIAL_MARKETPLACE : 'claude-plugins-official';
    if (configs[name]) continue;
    configs[name] = { ...source, addedAt: new Date().toISOString() };
    seeded.push({ name, url: resolveSourceUrls(source)[0] });
  }
  if (seeded.length === 0) return;
  writeConfigMarketplaces(configs);
  const logger = getLogger();
  for (const { name, url } of seeded) {
    logger.info('Seeded default official marketplace', { name, url }, COMPONENT);
  }
}
