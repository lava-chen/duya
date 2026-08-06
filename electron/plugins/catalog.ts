// catalog.ts — plugin catalog.
//
// Plan: plugin-config-simplification. The inline `BUNDLED_PLUGIN_CATALOG`
// array is deleted; builtin plugins are read from the user-home cache
// (`~/.duya/plugins/cache/builtin/<id>/<version>/`) that
// `syncBuiltinPlugins()` populates at startup. The catalog scanner reads
// each cache root via `readPluginManifest` (which resolves the minimal
// `.duya-plugin/plugin.json` shape + disk-derived capabilities), attaches
// `officialAssets` when available, and derives `capabilityCounts` from the
// same on-disk directory. Local (marketplace.json) entries and bundled
// skill entries are unchanged. Catalog TTL cache is retained.

import fs from 'fs';
import path from 'path';
import { app } from 'electron';
import type { PluginCatalogEntry, PluginCategory, PluginManifest } from './types';
import { readPluginManifest } from './manifest';
import { getLogger, LogComponent } from '../logging/logger';
import { getOfficialPluginAssets } from '../../packages/plugin-core/src/plugins/loader/official-assets.js';
import { deriveCapabilityCounts } from './capability-counts.js';
import { parseSkillFrontmatter } from '../utils/skill-parser';
import { listBuiltinCacheRoots } from './cache/builtin-sync';

const COMPONENT = 'PluginCatalog' as LogComponent;

interface LocalMarketplacePlugin {
  name: string;
  source: {
    source: string;
    path: string;
  };
  policy?: {
    installation?: string;
    authentication?: string;
  };
  category?: string;
}

interface LocalMarketplaceFile {
  name: string;
  plugins: LocalMarketplacePlugin[];
}

function readLocalMarketplaceFile(): LocalMarketplaceFile | null {
  try {
    const userData = app.getPath('userData');
    const marketplacePath = path.join(userData, 'plugins', 'marketplace.json');
    if (!fs.existsSync(marketplacePath)) {
      return null;
    }
    const raw = JSON.parse(fs.readFileSync(marketplacePath, 'utf8'));
    if (typeof raw !== 'object' || raw === null || !Array.isArray(raw.plugins)) {
      return null;
    }
    return raw as LocalMarketplaceFile;
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
  manifest: Record<string, unknown>,
): PluginCatalogEntry {
  const id = (manifest.id as string) || `com.duya.${mpEntry.name}`;
  const name = (manifest.name as string) || mpEntry.name;
  const version = (manifest.version as string) || '0.1.0';
  const description = (manifest.description as string) || `Plugin: ${mpEntry.name}`;
  const author = (manifest.author as { name: string; url?: string }) || { name: 'Unknown' };

  return {
    id,
    name,
    version,
    description,
    source: 'local',
    category: normalizeCategory(mpEntry.category),
    trustLevel: 'local',
    capabilityCounts: deriveCapabilityCounts(
      manifest as unknown as Parameters<typeof deriveCapabilityCounts>[0],
    ),
    manifest: manifest as PluginCatalogEntry['manifest'],
    author,
  };
}

function getLocalCatalogEntries(): PluginCatalogEntry[] {
  const logger = getLogger();
  const marketplace = readLocalMarketplaceFile();
  if (!marketplace || !marketplace.plugins.length) {
    return [];
  }

  const entries: PluginCatalogEntry[] = [];
  const marketplaceDir = path.join(app.getPath('userData'), 'plugins');

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
      const entry = buildLocalCatalogEntry(mpEntry, manifest as unknown as Record<string, unknown>);
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

// ----------------------------------------------------------------------------
// Builtin catalog — scan ~/.duya/plugins/cache/builtin/ (populated by
// syncBuiltinPlugins at startup). Each cache root is read via
// readPluginManifest; officialAssets are attached when the plugin id
// matches the audited first-party registry.
// ----------------------------------------------------------------------------

function getBuiltinCatalogEntries(): PluginCatalogEntry[] {
  const logger = getLogger();
  const roots = listBuiltinCacheRoots();
  if (roots.length === 0) return [];

  const entries: PluginCatalogEntry[] = [];
  for (const pluginRoot of roots) {
    try {
      const manifest = readPluginManifest(pluginRoot);
      const officialAssets = getOfficialPluginAssets(manifest.id);
      const manifestWithAssets: PluginManifest = officialAssets
        ? { ...manifest, officialAssets }
        : manifest;
      const category = normalizeCategory(manifest.interface?.category);
      entries.push({
        id: manifest.id,
        name: manifest.name,
        version: manifest.version,
        description: manifest.description,
        source: 'bundled',
        category,
        trustLevel: 'official',
        capabilityCounts: deriveCapabilityCounts(manifestWithAssets, pluginRoot),
        manifest: manifestWithAssets,
        author: manifest.author,
        builtinCacheDir: pluginRoot,
      });
    } catch (err) {
      logger.warn('Failed to read builtin plugin manifest from cache', {
        pluginRoot,
        error: err instanceof Error ? err.message : String(err),
      }, COMPONENT);
    }
  }
  return entries;
}

let cachedCatalog: PluginCatalogEntry[] | null = null;
let cachedCatalogAt = 0;
const CACHE_TTL_MS = 5000;

export function getPluginCatalog(): PluginCatalogEntry[] {
  const now = Date.now();
  if (cachedCatalog && (now - cachedCatalogAt) < CACHE_TTL_MS) {
    return cachedCatalog;
  }

  const builtinEntries = getBuiltinCatalogEntries();
  const localEntries = getLocalCatalogEntries();
  const skillEntries = getBundledSkillCatalogEntries();
  cachedCatalog = [...builtinEntries, ...localEntries, ...skillEntries];
  cachedCatalogAt = now;
  return cachedCatalog;
}

export function getPluginCatalogEntry(id: string): PluginCatalogEntry | undefined {
  const catalog = getPluginCatalog();
  return catalog.find((entry) => entry.id === id);
}

export function getLocalPluginPaths(): Map<string, string> {
  const marketplace = readLocalMarketplaceFile();
  if (!marketplace || !marketplace.plugins.length) {
    return new Map();
  }

  const result = new Map<string, string>();
  const marketplaceDir = path.join(app.getPath('userData'), 'plugins');

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

// ----------------------------------------------------------------------------
// Bundled Skills Catalog
// ----------------------------------------------------------------------------
// Skills under `packages/agent/skills/` are exposed as standalone marketplace
// entries (`kind: 'skill'`) so users can selectively install them instead of
// having all skills auto-synced at runtime. Each skill becomes one catalog
// entry; installing copies the skill directory into the plugin's `skills/`
// folder, from where the existing skill loader picks it up.

/**
 * Resolve the bundled skills directory in the main process.
 * - Dev: `<repo>/packages/agent/skills`
 * - Prod: `<resourcesPath>/agent/skills` (electron-builder extraResources)
 */
function getBundledSkillsDir(): string {
  if (app.isPackaged) {
    return path.join(process.resourcesPath, 'agent', 'skills');
  }
  return path.join(app.getAppPath(), 'packages', 'agent', 'skills');
}

/**
 * Map a skill category directory name to a `PluginCategory` for marketplace
 * grouping. Skill categories follow the directory layout under
 * `packages/agent/skills/` (agentic, apple, cognition, communication,
 * development, media, office, research, websearch, visualize).
 */
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

/**
 * Scan the bundled skills directory and collect one `BundledSkillInfo` per
 * skill (per category subdirectory containing a `SKILL.md`). Categories
 * without a `SKILL.md` child are skipped silently. Platform-conditional
 * skills (e.g. `apple/*` on non-macOS) are still listed — the marketplace
 * shows them, but the loader will skip them on incompatible platforms
 * after install.
 */
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

/**
 * Build catalog entries for every bundled skill. Each entry is a
 * `kind: 'skill'` marketplace item that installs a single skill directory.
 * Results are cached for the process lifetime — the bundled skill set only
 * changes across app updates.
 */
function getBundledSkillCatalogEntries(): PluginCatalogEntry[] {
  if (cachedSkillCatalog) return cachedSkillCatalog;

  const skills = scanBundledSkills();
  cachedSkillCatalog = skills.map((skill) => {
    const id = `com.duya.skill.${skill.name}`;
    const manifest: PluginManifest = {
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
