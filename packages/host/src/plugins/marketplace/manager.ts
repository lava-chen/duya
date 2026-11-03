import fs from 'fs';
import path from 'path';
import {
  MarketplaceSourceError,
  parseMarketplaceSource,
  safeMarketplaceDirName,
} from '@duya/plugin-core/marketplace/source-parse';
import { readMarketplaceManifest } from './manifest.js';
import type { MarketplaceEnvironment } from '../ports.js';
import type { MarketplaceSourceConfig } from './git-source.js';
type LogComponent = string;
export interface OfficialMarketplaceSeed {
  registryName: string;
  source: MarketplaceSourceConfig;
}
export interface MarketplaceView {
  name: string;
  displayName?: string | undefined;
  kind: 'git' | 'local';
  url?: string | undefined;
  path?: string | undefined;
  ref?: string | undefined;
  addedAt?: string | undefined;
  /** Hidden sources stay configured but their plugins leave the catalog. */
  hidden: boolean;
  /** Present when the clone is missing or the manifest is unreadable. */
  error?: string | undefined;
  pluginCount: number;
  pluginNames: string[];
}
export interface MarketplaceSyncOutcome {
  marketplace: string;
  error?: string | undefined;
}
export function createMarketplaceManager(options: MarketplaceEnvironment) {
  const getConfigStore = () => options.config;
  const getLogger = () => options.logger;
  const { cloneMarketplace, getMarketplaceCloneDir, removeMarketplaceClone, resolveConfiguredMarketplaceDir, resolveSourceUrls, updateMarketplace } = options.git;
  const { getMarketplaceStatuses, invalidatePluginCatalogCache, readConfigMarketplaces } = options.catalog;
  const COMPONENT = 'PluginMarketplaceManager' as LogComponent;



  function writeConfigMarketplaces(entries: Record<string, MarketplaceSourceConfig & { addedAt?: string | undefined }>): void {
    getConfigStore().set('marketplaces', entries);
  }
  function isDefaultOfficialSource(name: string): boolean {
    return DEFAULT_OFFICIAL_SOURCES.some((seed) => seed.registryName === name);
  }
  function isConfigured(
    configs: Record<string, MarketplaceSourceConfig & { addedAt?: string | undefined }>,
    name: string,
  ): boolean {
    const cfg = configs[name];
    return cfg !== undefined && cfg.removed !== true;
  }
  function listMarketplaces(): MarketplaceView[] {
    const configs = readConfigMarketplaces();
    const statuses = new Map(getMarketplaceStatuses().map((s) => [s.marketplace, s]));

    return Object.entries(configs).filter(([, cfg]) => !cfg.removed).map(([name, cfg]) => {
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
        hidden: cfg.hidden === true,
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
  async function addMarketplace(input: string, ref?: string): Promise<MarketplaceView> {
    const logger = getLogger();
    const parsed = parseMarketplaceSource(input, ref);
    const configs = readConfigMarketplaces();

    let name: string;
    let stored: MarketplaceSourceConfig;

    if (parsed.kind === 'git') {
      const provisional = slugFromUrl(parsed.url!);
      if (isConfigured(configs, provisional)) {
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
          if (isConfigured(configs, name) || fs.existsSync(getMarketplaceCloneDir(name))) {
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
      if (isConfigured(configs, name)) {
        throw new Error(`marketplace "${name}" is already configured`);
      }
      stored = { source: 'local', path: dir, ref: parsed.ref };
    }

    writeConfigMarketplaces({
      ...readConfigMarketplaces(),
      [name]: { ...stored, addedAt: new Date().toISOString() },
    });
    invalidatePluginCatalogCache();
    logger.info('Marketplace added', { name, kind: stored.source }, COMPONENT);

    const view = listMarketplaces().find((m) => m.name === name);
    return view ?? {
      ...stored,
      name,
      kind: stored.source,
      hidden: stored.hidden === true,
      pluginCount: 0,
      pluginNames: [],
    };
  }
  function removeMarketplace(name: string): void {
    const configs = readConfigMarketplaces();
    const cfg = configs[name];
    if (!cfg || cfg.removed) {
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

    if (cfg.source === 'git') {
      removeMarketplaceClone(name);
    }
    const next = { ...configs };
    if (isDefaultOfficialSource(name)) {
      next[name] = { ...cfg, removed: true };
    } else {
      delete next[name];
    }
    writeConfigMarketplaces(next);
    invalidatePluginCatalogCache();

    getLogger().info('Marketplace removed', { name }, COMPONENT);
  }
  function setMarketplaceHidden(name: string, hidden: boolean): void {
    const configs = readConfigMarketplaces();
    const cfg = configs[name];
    if (!cfg || cfg.removed) {
      throw new Error(`marketplace "${name}" is not configured`);
    }

    const entry: MarketplaceSourceConfig & { addedAt?: string | undefined } = { ...cfg };
    if (hidden) entry.hidden = true;
    else delete entry.hidden;

    writeConfigMarketplaces({ ...configs, [name]: entry });
    invalidatePluginCatalogCache();
    getLogger().info(hidden ? 'Marketplace hidden' : 'Marketplace shown', { name }, COMPONENT);
  }
  async function refreshMarketplace(name: string): Promise<MarketplaceView> {
    const logger = getLogger();
    const configs = readConfigMarketplaces();
    const cfg = configs[name];
    if (!cfg || cfg.removed) {
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

    // Clone contents changed on disk — the catalog must not serve the
    // pre-refresh memoized list (a fast re-clone can land inside the 5s TTL).
    invalidatePluginCatalogCache();

    const view = listMarketplaces().find((m) => m.name === name);
    if (!view) {
      throw new Error(`marketplace "${name}" vanished during refresh`);
    }
    if (view.error) {
      throw new Error(`marketplace "${name}" refreshed with errors: ${view.error}`);
    }
    return view;
  }
  async function syncAllMarketplaces(): Promise<MarketplaceSyncOutcome[]> {
    const configs = readConfigMarketplaces();
    const outcomes: MarketplaceSyncOutcome[] = [];
    for (const [name, cfg] of Object.entries(configs)) {
      // Hidden and removed sources stay out of the startup sync: hidden ones
      // contribute no catalog entries, removed ones are tombstones.
      if (cfg.hidden || cfg.removed) continue;
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
  function ensureOfficialMarketplace(): void {
    const configs = readConfigMarketplaces();
    const seeded: Array<{ name: string; url: string }> = [];
    for (const { registryName, source } of DEFAULT_OFFICIAL_SOURCES) {
      if (configs[registryName]) continue;
      configs[registryName] = { ...source, addedAt: new Date().toISOString() };
      seeded.push({ name: registryName, url: resolveSourceUrls(source)[0] ?? '' });
    }
    if (seeded.length === 0) return;
    writeConfigMarketplaces(configs);
    const logger = getLogger();
    for (const { name, url } of seeded) {
      logger.info('Seeded default official marketplace', { name, url }, COMPONENT);
    }
  }
  return { DEFAULT_OFFICIAL_SOURCES, DEFAULT_OFFICIAL_MARKETPLACE, DEFAULT_OFFICIAL_SOURCE, listMarketplaces, addMarketplace, removeMarketplace, setMarketplaceHidden, refreshMarketplace, syncAllMarketplaces, ensureOfficialMarketplace };
}
export const DEFAULT_OFFICIAL_SOURCES: ReadonlyArray<OfficialMarketplaceSeed> = [
  {
    registryName: 'official',
    source: {
      source: 'git',
      displayName: 'DUYA Official',
      // Gitee primary (国内 + 海外连接都好), GitHub mirror as fallback.
      // plan 528 — marketplace source fallback / mirror.
      urls: [
        'https://gitee.com/lava-chen/duya-marketplace.git',
        'https://github.com/lava-chen/duya-marketplace.git',
      ],
    },
  },
  {
    registryName: 'claude-plugins-official',
    source: {
      source: 'git',
      displayName: 'Claude Code Official',
      // anthropics/claude-plugins-official — Anthropic-managed, 36.2k stars,
      // Apache 2.0. Catalog: .claude-plugin/marketplace.json.
      urls: ['https://github.com/anthropics/claude-plugins-official.git'],
    },
  },
  {
    registryName: 'codex-official',
    source: {
      source: 'git',
      displayName: 'Codex Official',
      // openai/plugins — OpenAI-managed. Catalog:
      // .agents/plugins/marketplace.json (65 plugins; UPPERCASE policy enums,
      // folded by registry.normalizeCatalogPolicy).
      urls: ['https://github.com/openai/plugins.git'],
    },
  },
  {
    registryName: 'cursor-official',
    source: {
      source: 'git',
      displayName: 'Cursor Official',
      // cursor/plugins — Cursor-managed ("plugin specification and official
      // plugins"). Catalog: .cursor-plugin/marketplace.json (78 plugins;
      // top-level displayName/logo presentation fields).
      urls: ['https://github.com/cursor/plugins.git'],
    },
  },
];
export const DEFAULT_OFFICIAL_MARKETPLACE = 'official';
export const DEFAULT_OFFICIAL_SOURCE: MarketplaceSourceConfig =
  DEFAULT_OFFICIAL_SOURCES[0]!.source;