/**
 * stage-builtin-plugins.mjs — stage the marketplace's builtin plugins into
 * the installer.
 *
 * The plugin marketplace is the single source of truth for the plugins it
 * publishes. `builtin-plugins.json` in that repo lists the ones that ship
 * INSIDE the duya installer, so a new user does not have to clone a
 * marketplace to get them.
 *
 * This script copies the listed plugin directories into
 * `resources/builtin-plugins/`, which electron-builder ships as
 * `builtin-marketplace-plugins/`. At startup the app seeds that directory
 * into the user-home plugin cache and registers the plugins, using the same
 * manifest for the enabled state.
 *
 * Behaviour:
 *   - The marketplace repo is located via `DUYA_MARKETPLACE_REPO`, the
 *     `--repo <path>` argument, or a sibling checkout.
 *   - A missing marketplace repo is NOT fatal by default: a local build
 *     without the marketplace still works, it just ships without the
 *     marketplace plugins. Set `DUYA_STRICT_BUILTIN_PLUGINS=1` (the release
 *     workflow does) to fail the build instead.
 *   - A plugin that is missing a file its manifest declares is fatal: the
 *     installer must not ship a broken plugin.
 */

import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
} from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TARGET_DIR = path.join(REPO_ROOT, 'resources', 'builtin-plugins');
const REPO_BUILTIN_DIR = path.join(REPO_ROOT, 'packages', 'plugin-core', 'src', 'plugins', 'builtin');
const MANIFEST_FILE = 'builtin-plugins.json';
const STRICT = process.env.DUYA_STRICT_BUILTIN_PLUGINS === '1';

function log(message) {
  console.log(`[stage-builtin-plugins] ${message}`);
}

function fatal(message) {
  console.error(`[stage-builtin-plugins] FATAL: ${message}`);
  process.exit(1);
}

/** Keep the staging directory present so electron-builder never hits a missing source dir. */
function ensureTargetDir() {
  mkdirSync(TARGET_DIR, { recursive: true });
}

function isObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Parse and validate the manifest; returns the plugin list. */
function parseManifest(raw, sourceLabel) {
  let parsed;
  try {
    // A Windows editor can leave a UTF-8 BOM in front of the file; JSON.parse
    // rejects it, and the manifest is not worth failing a build over.
    parsed = JSON.parse(raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw);
  } catch (err) {
    fatal(`${sourceLabel} is not valid JSON: ${err.message}`);
  }
  if (!isObject(parsed)) fatal(`${sourceLabel} root must be an object`);
  if (typeof parsed.version !== 'number' || !Number.isInteger(parsed.version) || parsed.version < 1) {
    fatal(`${sourceLabel} version must be a positive integer`);
  }
  if (!Array.isArray(parsed.plugins)) fatal(`${sourceLabel} plugins must be an array`);

  const seen = new Set();
  const plugins = [];
  for (const entry of parsed.plugins) {
    if (!isObject(entry)) fatal(`${sourceLabel} has a plugin entry that is not an object`);
    const { name } = entry;
    if (typeof name !== 'string' || !name.trim()) fatal(`${sourceLabel} has a plugin without a name`);
    if (name.includes('/') || name.includes('\\') || name.startsWith('.')) {
      fatal(`${sourceLabel} plugin name "${name}" must be a plain directory name`);
    }
    if (seen.has(name)) fatal(`${sourceLabel} declares "${name}" twice`);
    seen.add(name);
    if (typeof entry.path !== 'string' || !entry.path.trim()) {
      fatal(`${sourceLabel} plugin "${name}" has no path`);
    }
    const requiredPaths = entry.requiredPaths === undefined ? [] : entry.requiredPaths;
    if (!Array.isArray(requiredPaths)) {
      fatal(`${sourceLabel} plugin "${name}" requiredPaths must be an array`);
    }
    for (const item of requiredPaths) {
      if (typeof item !== 'string' || !item.trim()) {
        fatal(`${sourceLabel} plugin "${name}" has an invalid requiredPaths entry`);
      }
    }
    if (entry.defaultEnabled !== undefined && typeof entry.defaultEnabled !== 'boolean') {
      fatal(`${sourceLabel} plugin "${name}" defaultEnabled must be a boolean`);
    }
    plugins.push({
      name,
      path: entry.path,
      requiredPaths,
      defaultEnabled: entry.defaultEnabled,
    });
  }
  return plugins;
}

/** True when `relative` stays inside `root`. */
function isContained(root, relative) {
  if (!relative || path.isAbsolute(relative)) return false;
  const rel = path.relative(path.resolve(root), path.resolve(root, relative));
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}

/** Candidate marketplace checkouts, in priority order. */
function marketplaceCandidates() {
  const candidates = [];
  const fromArg = process.argv.indexOf('--repo');
  if (fromArg !== -1 && process.argv[fromArg + 1]) {
    candidates.push(path.resolve(process.argv[fromArg + 1]));
  }
  if (process.env.DUYA_MARKETPLACE_REPO) {
    candidates.push(path.resolve(process.env.DUYA_MARKETPLACE_REPO));
  }
  const parent = path.dirname(REPO_ROOT);
  candidates.push(path.join(parent, 'duya-marketplace', 'duya-marketplace'));
  candidates.push(path.join(parent, 'duya-marketplace'));
  candidates.push(path.join(parent, '..', 'duya-marketplace', 'duya-marketplace'));
  return candidates;
}

/** A marketplace checkout has a `plugins/` directory. */
function looksLikeMarketplace(dir) {
  return existsSync(path.join(dir, 'plugins'));
}

function resolveMarketplaceRepo() {
  for (const candidate of marketplaceCandidates()) {
    if (existsSync(candidate) && looksLikeMarketplace(candidate)) return candidate;
  }
  return null;
}

/** Plugin ids the repo already ships as builtin plugins. */
function collectRepoPluginIds() {
  const ids = new Set();
  if (!existsSync(REPO_BUILTIN_DIR)) return ids;
  for (const entry of readdirSync(REPO_BUILTIN_DIR, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
    const manifestPath = path.join(REPO_BUILTIN_DIR, entry.name, '.duya-plugin', 'plugin.json');
    if (!existsSync(manifestPath)) continue;
    try {
      const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
      if (typeof manifest.id === 'string' && manifest.id) ids.add(manifest.id);
    } catch {
      // A broken builtin plugin in the repo is reported by its own tests.
    }
  }
  return ids;
}

function readPluginId(pluginDir) {
  const manifestPath = path.join(pluginDir, '.duya-plugin', 'plugin.json');
  if (!existsSync(manifestPath)) return null;
  try {
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    if (typeof manifest.id === 'string' && manifest.id) return manifest.id;
    if (typeof manifest.name === 'string' && manifest.name) return `com.duya.${manifest.name}`;
  } catch {
    return null;
  }
  return null;
}

function main() {
  const marketplaceDir = resolveMarketplaceRepo();
  if (!marketplaceDir) {
    ensureTargetDir();
    if (STRICT) {
      fatal(
        'the plugin marketplace checkout was not found — set DUYA_MARKETPLACE_REPO to its path',
      );
    }
    log('no marketplace checkout found; shipping without the marketplace builtin plugins');
    return;
  }

  const manifestPath = path.join(marketplaceDir, MANIFEST_FILE);
  if (!existsSync(manifestPath)) {
    ensureTargetDir();
    if (STRICT) {
      fatal(`${manifestPath} does not exist — the marketplace declares no builtin plugins`);
    }
    log(`${marketplaceDir} declares no builtin plugins; nothing to stage`);
    return;
  }

  const plugins = parseManifest(readFileSync(manifestPath, 'utf8'), MANIFEST_FILE);
  const repoPluginIds = collectRepoPluginIds();

  // Validate everything before touching the staging directory: a broken
  // manifest must not leave the staging area half-written.
  const prepared = [];
  for (const plugin of plugins) {
    if (!isContained(marketplaceDir, plugin.path)) {
      fatal(`plugin "${plugin.name}" path "${plugin.path}" escapes the marketplace repo`);
    }
    const sourceDir = path.resolve(marketplaceDir, plugin.path);
    if (!existsSync(sourceDir)) {
      fatal(`plugin "${plugin.name}" source directory does not exist: ${sourceDir}`);
    }
    const missing = plugin.requiredPaths.filter((rel) => !existsSync(path.join(sourceDir, rel)));
    if (missing.length > 0) {
      fatal(`plugin "${plugin.name}" is missing declared files: ${missing.join(', ')}`);
    }
    const pluginId = readPluginId(sourceDir);
    if (!pluginId) {
      fatal(`plugin "${plugin.name}" has no readable .duya-plugin/plugin.json`);
    }
    if (repoPluginIds.has(pluginId)) {
      fatal(
        `plugin "${plugin.name}" has id "${pluginId}", which the repo already ships as a builtin plugin`,
      );
    }
    prepared.push({ ...plugin, sourceDir, pluginId });
  }

  rmSync(TARGET_DIR, { recursive: true, force: true });
  mkdirSync(TARGET_DIR, { recursive: true });
  for (const plugin of prepared) {
    const dest = path.join(TARGET_DIR, plugin.name);
    cpSync(plugin.sourceDir, dest, { recursive: true });
  }
  cpSync(manifestPath, path.join(TARGET_DIR, MANIFEST_FILE));

  log(
    `staged ${prepared.length} plugin(s) from ${marketplaceDir}: ${
      prepared.map((plugin) => `${plugin.name}@${plugin.pluginId}`).join(', ') || '(none)'
    }`,
  );
}

main();
