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
  updateMarketplace,
  type MarketplaceSourceConfig,
} from './git-source';
import { readMarketplaceManifest } from './manifest';
import { getMarketplaceStatuses, readConfigMarketplaces } from '../catalog';

const COMPONENT = 'PluginMarketplaceManager' as LogComponent;

/** Plan 455 D6 — the pre-seeded official marketplace. Sync failures are
 *  WARN-only so first launch works offline. */
export const DEFAULT_OFFICIAL_MARKETPLACE = 'official';
export const DEFAULT_OFFICIAL_SOURCE: MarketplaceSourceConfig = {
  source: 'git',
  url: 'https://github.com/lava-chen/duya-marketplace.git',
};

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
    const result = await cloneMarketplace({ url: parsed.url!, name: provisional, ref: parsed.ref });
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
    try {
      if (!fs.existsSync(dir)) {
        await cloneMarketplace({ url: cfg.url!, name, ref: cfg.ref });
      } else {
        await updateMarketplace({ dir, ref: cfg.ref });
      }
    } catch (err) {
      // Stale/broken clone (shallow fetch failure, force-push, ...) —
      // re-clone from scratch as the codex fallback path.
      logger.warn('Marketplace update failed, re-cloning', {
        marketplace: name,
        error: err instanceof Error ? err.message : String(err),
      }, COMPONENT);
      removeMarketplaceClone(name);
      await cloneMarketplace({ url: cfg.url!, name, ref: cfg.ref });
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
 * (Plan 455 user decision 2). No network I/O — the startup sync performs
 * the first clone and tolerates failure.
 */
export function ensureOfficialMarketplace(): void {
  const configs = readConfigMarketplaces();
  if (configs[DEFAULT_OFFICIAL_MARKETPLACE]) {
    return;
  }
  writeConfigMarketplaces({
    ...configs,
    [DEFAULT_OFFICIAL_MARKETPLACE]: {
      ...DEFAULT_OFFICIAL_SOURCE,
      addedAt: new Date().toISOString(),
    },
  });
  getLogger().info('Seeded default official marketplace', {
    url: DEFAULT_OFFICIAL_SOURCE.url,
  }, COMPONENT);
}
