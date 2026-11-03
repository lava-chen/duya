import fs from 'fs';
import path from 'path';
import { pathToFileURL } from 'url';
import type { PluginCatalogEntry, PluginCategory, PluginManifest } from './types.js';
import { listCapabilityKinds, readAppConnectionDeclarations, readPluginManifest } from './manifest.js';
import { getOfficialPluginAssets } from '@duya/plugin-core/plugins/loader/official-assets';
import { deriveCapabilityCounts } from './capability-counts.js';
import { readMarketplaceManifest, resolvePluginEntryDir } from './marketplace/manifest.js';
import type { MarketplacePluginEntry } from './marketplace/manifest.js';
import type { PluginCatalogEnvironment, BuiltinSeedOutcome } from './ports.js';
import type { MarketplaceSourceConfig } from './marketplace/git-source.js';
import { parseSkillFrontmatter } from './skill-parser.js';
import { pickLatestVersion } from './cache/version-resolver.js';
type LogComponent = string;
interface LocalMarketplacePlugin {
  name: string;
  source: {
    source: string;
    path: string;
  };
  policy?: {
    installation?: string | undefined;
    authentication?: string | undefined;
  } | undefined;
  category?: string | undefined;
}
interface LocalMarketplaceFile {
  baseDir?: string | undefined;
  name: string;
  plugins: LocalMarketplacePlugin[];
}
export interface MarketplaceCatalogStatus {
  marketplace: string;
  /** Optional UI tab label override; falls back to `marketplace`. Plan 529. */
  displayName?: string | undefined;
  /** Set when the clone is missing or its manifest failed to read. */
  error?: string | undefined;
  pluginCount: number;
}
interface BundledSkillInfo {
  /** Skill name from frontmatter `name` field. */
  name: string;
  /** Skill description from frontmatter. */
  description: string;
  /** Skill version from frontmatter, defaults to `'0.1.0'`. */
  version: string;
  /** Author name from frontmatter, defaults to `'DUYA Team'`. */
  author: string;
  /** Category directory name (e.g. `'office'`, `'research'`). */
  categoryDir: string;
  /** Absolute path to the skill source directory. */
  skillDir: string;
}
export function createPluginCatalog(options: PluginCatalogEnvironment) {
  const getLogger = () => options.logger;
  const getConfigStore = () => options.config;
  const { resolveConfiguredMarketplaceDir } = options.git;
  const getBuiltinSeedRoot = options.builtinRoot;
  const seedBuiltinPlugins = options.seedBuiltins;
  function readConfigMarketplaces(): Record<string, MarketplaceSourceConfig & { addedAt?: string | undefined }> {
    const raw = getConfigStore().getByPath('marketplaces');
    if (raw && typeof raw === 'object') {
      return raw as Record<string, MarketplaceSourceConfig & { addedAt?: string | undefined }>;
    }
    return {};
  }
  const COMPONENT = 'PluginCatalog' as LogComponent;
  function invalidatePluginCatalogCache(): void {
    cachedCatalog = null;
    cachedCatalogAt = 0;
    cachedSkillCatalog = null;
  }
  function resolveIconUrl(manifest: PluginManifest, pluginRoot: string): string | undefined {
    const relIcon = manifest.interface?.icon;
    if (!relIcon) return undefined;
    const abs = path.resolve(pluginRoot, relIcon.replace(/^\.\//, ''));
    if (!fs.existsSync(abs)) return undefined;
    return pathToFileURL(abs).href.replace(/^file:\/\//, 'duya-file://');
  }
  function readLocalMarketplaceFile(): LocalMarketplaceFile | null {
    try {
      const marketplacePath = [...new Set([options.packageRoot, ...(options.readRoots ?? [])])].map(root => path.join(root, 'plugins', 'marketplace.json')).find(file => fs.existsSync(file));
      if (!marketplacePath) return null;
      if (!fs.existsSync(marketplacePath)) {
        return null;
      }
      const raw = JSON.parse(fs.readFileSync(marketplacePath, 'utf8'));
      if (typeof raw !== 'object' || raw === null || !Array.isArray(raw.plugins)) {
        return null;
      }
      return { ...raw, baseDir: path.dirname(marketplacePath) } as LocalMarketplaceFile;
    } catch {
      return null;
    }
  }
  const VALID_CATEGORIES: Set<string> = new Set([
    'productivity', 'development', 'research', 'data',
    'communication', 'media', 'automation', 'other',
  ]);
  function normalizeCategory(cat: string | undefined): PluginCategory {
    if (!cat) return 'other';
    const lower = cat.toLowerCase();
    if (VALID_CATEGORIES.has(lower)) return lower as PluginCategory;
    return 'other';
  }
  function buildLocalCatalogEntry(
    mpEntry: LocalMarketplacePlugin,
    manifest: PluginManifest,
    pluginDir: string,
  ): PluginCatalogEntry {
    const id = (manifest.id as string) || `com.duya.${mpEntry.name}`;
    const name = (manifest.name as string) || mpEntry.name;
    const version = (manifest.version as string) || '0.1.0';
    const description = (manifest.description as string) || `Plugin: ${mpEntry.name}`;
    const author = (manifest.author as { name: string; url?: string | undefined }) || { name: 'Unknown' };

    return applyInterfaceMetadata({
      id,
      name,
      version,
      description,
      icon: resolveIconUrl(manifest, pluginDir),
      source: 'local',
      category: normalizeCategory(mpEntry.category),
      trustLevel: 'local',
      capabilityCounts: deriveCapabilityCounts(
        manifest as unknown as Parameters<typeof deriveCapabilityCounts>[0],
      ),
      manifest: manifest as PluginCatalogEntry['manifest'],
      author,
    }, manifest);
  }
  function getLocalCatalogEntries(): PluginCatalogEntry[] {
    const logger = getLogger();
    const marketplace = readLocalMarketplaceFile();
    if (!marketplace || !marketplace.plugins.length) {
      return [];
    }

    const entries: PluginCatalogEntry[] = [];
    const marketplaceDir = marketplace.baseDir ?? path.join(options.packageRoot, 'plugins');

    for (const mpEntry of marketplace.plugins) {
      try {
        let pluginDir = mpEntry.source.path;
        if (!path.isAbsolute(pluginDir)) {
          pluginDir = path.resolve(marketplaceDir, pluginDir);
        }

        if (!fs.existsSync(pluginDir)) {
          logger.warn('Local plugin directory not found', { name: mpEntry.name, path: pluginDir }, COMPONENT);
          continue;
        }

        const manifest = readPluginManifest(pluginDir);
        const entry = buildLocalCatalogEntry(mpEntry, manifest, pluginDir);
        entries.push(entry);
      } catch (err) {
        logger.warn('Failed to read local plugin manifest', {
          name: mpEntry.name,
          error: err instanceof Error ? err.message : String(err),
        }, COMPONENT);
      }
    }

    return entries;
  }
  function getBuiltinCatalogEntries(builtinRoot?: string): PluginCatalogEntry[] {
    const logger = getLogger();
    const root = builtinRoot ?? getBuiltinSeedRoot();
    if (!fs.existsSync(root)) {
      return [];
    }

    const entries: PluginCatalogEntry[] = [];
    for (const id of fs.readdirSync(root)) {
      const idDir = path.join(root, id);
      if (!fs.statSync(idDir).isDirectory()) continue;
      let versionDir: string | null = null;
      try {
        const versions = fs.readdirSync(idDir).filter((v) => fs.statSync(path.join(idDir, v)).isDirectory());
        versionDir = pickLatestVersion(versions);
      } catch {
        versionDir = null;
      }
      if (!versionDir) continue;

      const pluginDir = path.join(idDir, versionDir);
      try {
        const manifest = readPluginManifest(pluginDir);
        const entry = buildBuiltinCatalogEntry(manifest, pluginDir);
        if (entry) entries.push(entry);
      } catch (err) {
        logger.warn('Failed to read builtin plugin manifest', {
          id,
          error: err instanceof Error ? err.message : String(err),
        }, COMPONENT);
      }
    }
    return entries;
  }
  function buildBuiltinCatalogEntry(
    manifest: PluginManifest,
    pluginDir: string,
  ): PluginCatalogEntry | null {
    if (!manifest?.name) return null;
    const id = manifest.id || `com.duya.${manifest.name}`;
    // Derive the install-dialog auth gate from the plugin's own app
    // declarations: a required connection means the install flow must run the
    // OAuth connect step (two-icon UI), an optional one connects on use.
    // Marketplace entries get this from their marketplace.json policy — builtin
    // plugins have no such metadata, so it comes from the declaration itself.
    const appDecls = readAppConnectionDeclarations(pluginDir);
    const authPolicy: PluginCatalogEntry['authPolicy'] =
      appDecls.length === 0
        ? undefined
        : appDecls.some((decl) => decl.required)
          ? 'on_install'
          : 'on_use';
    return applyInterfaceMetadata({
      id,
      name: manifest.name,
      version: manifest.version || '0.1.0',
      description: manifest.description || `Plugin: ${manifest.name}`,
      icon: resolveIconUrl(manifest, pluginDir),
      source: 'builtin-directory',
      category: normalizeCategory(manifest.interface?.category),
      trustLevel: 'official',
      capabilityCounts: deriveCapabilityCounts(manifest as PluginCatalogEntry['manifest'], pluginDir),
      // Full synced copy under the user-home builtin cache. Without this the
      // install falls back to a manifest-only copy: assets (icon) and local
      // skills never land in the versioned cache.
      marketplacePluginDir: pluginDir,
      authPolicy,
      manifest,
      author: manifest.author,
    }, manifest);
  }
  let cachedCatalog: PluginCatalogEntry[] | null = null;
  let cachedCatalogAt = 0;
  const CACHE_TTL_MS = 5000;
  function getPluginCatalog(): PluginCatalogEntry[] {
    const now = Date.now();
    if (cachedCatalog && (now - cachedCatalogAt) < CACHE_TTL_MS) {
      return cachedCatalog;
    }

    const localEntries = getLocalCatalogEntries();
    const skillEntries = getBundledSkillCatalogEntries();
    const marketplaceEntries = getMarketplaceCatalogEntries().entries;
    // Plan 455 follow-up: builtin plugins ship in the user-home cache
    // (`~/.duya/plugins/cache/builtin/<id>/<version>/`) and must be part of
    // the catalog — otherwise registry entries pointing at them can never
    // resolve a manifest, and downstream consumers (e.g. the composer `@`
    // plugin list) degrade to empty.
    const builtinEntries = getBuiltinCatalogEntries();
    // Priority order for first-wins dedup below:
    //   1. builtin — `officialAssets` resolved + `trustLevel: 'official'`,
    //      canonical installed copy under `~/.duya/plugins/cache/builtin/`.
    //   2. marketplace — remote upstream; surfaces "newer version available".
    //   3. local — `marketplace.json` entries; shadowed by builtin/marketplace.
    //   4. skill — bundled skills, distinct id namespace; dedup is a no-op.
    // Without this, a single id can appear twice (e.g. both `com.duya.documents/`
    // and `documents/` under the builtin cache root), which:
    //   - trips React's `warnOnInvalidKey` in MarketplacePage
    //     (`key={`${marketplace ?? "local"}:${id}`}` → duplicate `local:` prefix)
    //   - makes `getPluginCatalogEntry(id)` return the local copy instead of
    //     the canonical builtin one, so installs resolve against the wrong root.
    const combined: PluginCatalogEntry[] = [
      ...builtinEntries,
      ...marketplaceEntries,
      ...localEntries,
      ...skillEntries,
    ];
    const seen = new Set<string>();
    cachedCatalog = combined.filter((entry) => {
      if (seen.has(entry.id)) return false;
      seen.add(entry.id);
      return true;
    });
    cachedCatalogAt = now;
    return cachedCatalog;
  }
  function getPluginCatalogEntry(id: string, marketplace?: string): PluginCatalogEntry | undefined {
    const catalog = getPluginCatalog();
    if (marketplace) {
      return catalog.find((entry) => entry.id === id && entry.marketplace === marketplace);
    }
    return catalog.find((entry) => entry.id === id);
  }
  function marketplaceDirFor(name: string, source: MarketplaceSourceConfig): string | null {
    return resolveConfiguredMarketplaceDir(name, source);
  }
  function applyInterfaceMetadata(
    entry: PluginCatalogEntry,
    manifest: PluginManifest,
  ): PluginCatalogEntry {
    const iface = manifest.interface;
    if (!iface) return entry;
    if (iface.displayName_zh) entry.displayName_zh = iface.displayName_zh;
    if (iface.shortDescription) entry.shortDescription = iface.shortDescription;
    if (iface.shortDescription_zh) entry.shortDescription_zh = iface.shortDescription_zh;
    if (iface.longDescription) entry.longDescription = iface.longDescription;
    if (iface.longDescription_zh) entry.longDescription_zh = iface.longDescription_zh;
    if (iface.defaultPrompt?.length) {
      entry.usageExamples = iface.defaultPrompt.map((prompt) => ({ prompt }));
    }
    return entry;
  }
  function getMarketplaceCatalogEntries(): {
    entries: PluginCatalogEntry[];
    statuses: MarketplaceCatalogStatus[];
  } {
    const logger = getLogger();
    const entries: PluginCatalogEntry[] = [];
    const statuses: MarketplaceCatalogStatus[] = [];
    const seenIds = new Set<string>();
    const seenDirs = new Set<string>();

    for (const [name, config] of Object.entries(readConfigMarketplaces())) {
      // Removed official sources leave a tombstone so startup seeding does not
      // restore them; they contribute neither entries nor status.
      if (config.removed) continue;
      const dir = marketplaceDirFor(name, config);
      if (!dir || !fs.existsSync(dir)) {
        statuses.push({
          marketplace: name,
          displayName: config.displayName,
          error: 'not synced yet',
          pluginCount: 0,
        });
        continue;
      }

      const dirKey = path.resolve(dir);
      if (seenDirs.has(dirKey)) {
        logger.debug('Skipping duplicate marketplace directory', {
          marketplace: name, dir: dirKey,
        }, COMPONENT);
        statuses.push({
          marketplace: name,
          displayName: config.displayName,
          pluginCount: 0,
        });
        continue;
      }
      seenDirs.add(dirKey);

      let manifest;
      try {
        manifest = readMarketplaceManifest(dir);
      } catch (err) {
        const error = err instanceof Error ? err.message : String(err);
        logger.warn('Failed to read marketplace manifest', { marketplace: name, error }, COMPONENT);
        statuses.push({
          marketplace: name,
          displayName: config.displayName,
          error,
          pluginCount: 0,
        });
        continue;
      }
      if (!manifest) {
        statuses.push({
          marketplace: name,
          displayName: config.displayName,
          error: 'no marketplace.json found',
          pluginCount: 0,
        });
        continue;
      }

      // Hidden sources keep their status (so the source dialog can show the
      // count) but contribute no catalog entries.
      if (config.hidden) {
        statuses.push({
          marketplace: name,
          displayName: config.displayName,
          pluginCount: manifest.plugins.length,
        });
        continue;
      }

      let pluginCount = 0;
      for (const pluginEntry of manifest.plugins) {
        try {
          const entry = buildMarketplaceCatalogEntry(name, dir, pluginEntry);
          if (!entry) continue;
          if (seenIds.has(entry.id)) {
            logger.debug('Skipping duplicate plugin id across marketplaces', {
              id: entry.id, marketplace: name,
            }, COMPONENT);
            continue;
          }
          seenIds.add(entry.id);
          entries.push(entry);
          pluginCount++;
        } catch (err) {
          logger.warn('Failed to read marketplace plugin', {
            marketplace: name,
            plugin: pluginEntry.name,
            error: err instanceof Error ? err.message : String(err),
          }, COMPONENT);
        }
      }
      statuses.push({
        marketplace: name,
        displayName: config.displayName,
        pluginCount,
      });
    }

    return { entries, statuses };
  }
  function buildMarketplaceCatalogEntry(
    marketplaceName: string,
    marketplaceDir: string,
    pluginEntry: MarketplacePluginEntry,
  ): PluginCatalogEntry | null {
    const official = marketplaceName === 'official';

    if (pluginEntry.source.source === 'local') {
      const pluginDir = resolvePluginEntryDir(marketplaceDir, pluginEntry);
      const manifest = readPluginManifest(pluginDir);
      const category = normalizeCategory(pluginEntry.category ?? manifest.interface?.category);

      const officialAssets = official
        ? getOfficialPluginAssets(manifest.id || `com.duya.${pluginEntry.name}`)
        : undefined;
      const manifestWithAssets: PluginManifest = officialAssets
        ? { ...manifest, officialAssets }
        : manifest;

      return applyInterfaceMetadata({
        id: manifest.id || `com.duya.${pluginEntry.name}`,
        name: manifest.name || pluginEntry.name,
        version: manifest.version || '0.1.0',
        description: manifest.description || `Plugin: ${pluginEntry.name}`,
        icon: resolveIconUrl(manifest, pluginDir),
        source: 'marketplace',
        marketplace: marketplaceName,
        marketplacePluginDir: pluginDir,
        installPolicy: pluginEntry.policy?.installation ?? 'available',
        authPolicy: pluginEntry.policy?.authentication,
        category,
        trustLevel: official ? 'official' : 'verified',
        capabilityCounts: deriveCapabilityCounts(manifestWithAssets, pluginDir),
        manifest: manifestWithAssets,
        author: manifest.author,
      }, manifest);
    }

    if (pluginEntry.source.source === 'git') {
      return {
        id: `com.duya.${pluginEntry.name}`,
        name: pluginEntry.name,
        version: '0.1.0',
        description: `Plugin: ${pluginEntry.name}`,
        source: 'marketplace',
        marketplace: marketplaceName,
        installPolicy: pluginEntry.policy?.installation ?? 'available',
        authPolicy: pluginEntry.policy?.authentication,
        category: normalizeCategory(pluginEntry.category),
        trustLevel: official ? 'official' : 'verified',
        gitSourceUrl: pluginEntry.source.url,
        gitSourceRef: pluginEntry.source.ref_name,
        manifest: {
          schemaVersion: 'duya.plugin.v2', author: { name: 'Unknown' }, capabilities: {}, permissions: [], engines: { duya: ">=0.1.0" },
          id: `com.duya.${pluginEntry.name}`,
          name: pluginEntry.name,
          version: '0.1.0',
          description: `Plugin: ${pluginEntry.name}`,
          components: {},
        },
      };
    }

    return null;
  }
  function getMarketplaceStatuses(): MarketplaceCatalogStatus[] {
    return getMarketplaceCatalogEntries().statuses;
  }
  function getLocalPluginPaths(): Map<string, string> {
    const marketplace = readLocalMarketplaceFile();
    if (!marketplace || !marketplace.plugins.length) {
      return new Map();
    }

    const result = new Map<string, string>();
    const marketplaceDir = marketplace.baseDir ?? path.join(options.packageRoot, 'plugins');

    for (const entry of marketplace.plugins) {
      let pluginDir = entry.source.path;
      if (!path.isAbsolute(pluginDir)) {
        pluginDir = path.resolve(marketplaceDir, pluginDir);
      }
      if (fs.existsSync(pluginDir)) {
        result.set(entry.name, pluginDir);
      }
    }

    return result;
  }
  function getBundledSkillsDir(): string {
    return options.bundledSkillsRoot();
  }
  const SKILL_CATEGORY_TO_PLUGIN_CATEGORY: Record<string, PluginCategory> = {
    agentic: 'development',
    apple: 'productivity',
    cognition: 'other',
    communication: 'communication',
    development: 'development',
    media: 'media',
    office: 'productivity',
    research: 'research',
    websearch: 'research',
    visualize: 'other',
  };
  function scanBundledSkills(): BundledSkillInfo[] {
    const logger = getLogger();
    const root = getBundledSkillsDir();
    const skills: BundledSkillInfo[] = [];

    if (!fs.existsSync(root)) {
      logger.warn('Bundled skills directory not found', { dir: root }, COMPONENT);
      return skills;
    }

    let categoryDirs: fs.Dirent[];
    try {
      categoryDirs = fs.readdirSync(root, { withFileTypes: true });
    } catch (err) {
      logger.warn('Failed to read bundled skills directory', {
        dir: root,
        error: err instanceof Error ? err.message : String(err),
      }, COMPONENT);
      return skills;
    }

    for (const catEntry of categoryDirs) {
      if (!catEntry.isDirectory() || catEntry.name.startsWith('.')) continue;
      const categoryDir = catEntry.name;
      const categoryPath = path.join(root, categoryDir);

      let skillDirs: fs.Dirent[];
      try {
        skillDirs = fs.readdirSync(categoryPath, { withFileTypes: true });
      } catch {
        continue;
      }

      for (const skillEntry of skillDirs) {
        if (!skillEntry.isDirectory() || skillEntry.name.startsWith('.')) continue;
        const skillDirPath = path.join(categoryPath, skillEntry.name);
        const skillMdPath = path.join(skillDirPath, 'SKILL.md');
        if (!fs.existsSync(skillMdPath)) continue;

        try {
          const raw = fs.readFileSync(skillMdPath, 'utf8');
          const { frontmatter } = parseSkillFrontmatter(raw);
          const name = (frontmatter.name as string) || skillEntry.name;
          const description = (frontmatter.description as string) || `Skill: ${name}`;
          const version = (frontmatter.version as string) || '0.1.0';
          const author = (frontmatter.author as string) || 'DUYA Team';
          skills.push({
            name,
            description,
            version,
            author,
            categoryDir,
            skillDir: skillDirPath,
          });
        } catch (err) {
          logger.warn('Failed to read skill frontmatter', {
            skill: skillEntry.name,
            category: categoryDir,
            error: err instanceof Error ? err.message : String(err),
          }, COMPONENT);
        }
      }
    }

    return skills;
  }
  let cachedSkillCatalog: PluginCatalogEntry[] | null = null;
  function getBundledSkillCatalogEntries(): PluginCatalogEntry[] {
    if (cachedSkillCatalog) return cachedSkillCatalog;

    const skills = scanBundledSkills();
    cachedSkillCatalog = skills.map((skill) => {
      const id = `com.duya.skill.${skill.name}`;
      const manifest: PluginManifest = {
        capabilities: {},
        schemaVersion: 'duya.plugin.v2',
        id,
        name: skill.name,
        version: skill.version,
        description: skill.description,
        author: { name: skill.author },
        components: {
          mcpServers: [],
          appConnections: [],
          skills: [skill.name],
          workflows: [],
        },
        permissions: [],
        engines: { duya: '>=0.1.0' },
      };
      return {
        id,
        name: skill.name,
        version: skill.version,
        description: skill.description,
        source: 'bundled' as const,
        category: SKILL_CATEGORY_TO_PLUGIN_CATEGORY[skill.categoryDir] || 'other',
        trustLevel: 'official' as const,
        kind: 'skill' as const,
        skillSourceDir: skill.skillDir,
        manifest,
        capabilityCounts: {
          skills: 1,
          mcpServers: 0,
          cli: 0,
          ui: 0,
          hooks: 0,
          workflows: 0,
        },
      };
    });

    return cachedSkillCatalog;
  }
  function syncBuiltinPlugins(): BuiltinSeedOutcome {
    const outcome = seedBuiltinPlugins();
    cachedCatalog = null;
    cachedCatalogAt = 0;
    cachedSkillCatalog = null;
    return outcome;
  }
  return { readConfigMarketplaces, invalidatePluginCatalogCache, resolveIconUrl, getBuiltinCatalogEntries, getPluginCatalog, getPluginCatalogEntry, getMarketplaceStatuses, getLocalPluginPaths, getBundledSkillsDir, syncBuiltinPlugins };
}
