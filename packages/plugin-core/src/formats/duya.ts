// duya.ts — the native DUYA format adapter (the canonical baseline).
//
// `.duya-plugin/plugin.json` (or a root `plugin.json` for the portable
// case) already uses the canonical shape, so this adapter is mostly
// validation + defaulting. It exists so the registry has an unambiguous
// owner for duya's own catalogs and manifests, and so `plugin.json` at a
// plugin root resolves to *something* deterministic.

import type {
  FormatAdapter,
  NormalizedPluginManifest,
  NormalizedPluginSource,
} from './types';
import {
  asString,
  asStringArray,
  buildInterfaceBlock,
  isPlainObject,
  normalizeAuthor,
  normalizeVersion,
  requireName,
} from './shared';

const PLUGIN_MANIFEST_PATHS = ['.duya-plugin/plugin.json', 'plugin.json'] as const;
// duya's own catalog is the bare root `marketplace.json`. The
// `.agents/plugins/*` paths are Codex's and live on the codex adapter, so a
// lookup for them resolves to the codex format rather than to duya.
const CATALOG_PATHS = ['marketplace.json'] as const;

/** duya catalog source: the `{ source: 'local' | 'git', … }` union. */
function normalizeDuyaCatalogSource(raw: unknown): NormalizedPluginSource {
  if (!isPlainObject(raw)) {
    throw new Error('duya catalog source must be an object');
  }
  if (raw.source === 'local') {
    const path = asString(raw.path);
    if (!path) throw new Error('duya local source is missing "path"');
    return { source: 'local', path };
  }
  if (raw.source === 'git') {
    const url = asString(raw.url);
    if (!url) throw new Error('duya git source is missing "url"');
    const sub = asString(raw.path);
    // duya names the pin `ref_name`; `ref` is accepted as an alias so
    // mixed-hand-authored manifests keep working.
    const ref = asString(raw.ref_name) ?? asString(raw.ref);
    const sha = asString(raw.sha);
    return {
      source: 'git',
      url,
      ...(sub ? { path: sub } : {}),
      ...(ref ? { ref_name: ref } : {}),
      ...(sha ? { sha } : {}),
    };
  }
  throw new Error('unrecognized duya catalog source');
}

function normalizeDuyaPluginManifest(raw: unknown): NormalizedPluginManifest {
  if (!isPlainObject(raw)) {
    throw new Error('duya plugin manifest must be a JSON object');
  }
  const name = requireName(raw, 'duya');
  const interfaceBlock = buildInterfaceBlock(raw.interface);
  return {
    name,
    version: normalizeVersion(raw.version),
    description: asString(raw.description),
    author: normalizeAuthor(raw.author),
    license: asString(raw.license),
    keywords: asStringArray(raw.keywords),
    homepage: asString(raw.homepage),
    repository: asString(raw.repository),
    ...(interfaceBlock ? { interface: interfaceBlock } : {}),
  };
}

export const duyaAdapter: FormatAdapter = {
  id: 'duya',
  label: 'DUYA',
  priority: 0,
  pluginManifestPaths: PLUGIN_MANIFEST_PATHS,
  catalogPaths: CATALOG_PATHS,
  detectCatalogSource: (raw) =>
    isPlainObject(raw) && (raw.source === 'local' || raw.source === 'git'),
  normalizeCatalogSource: normalizeDuyaCatalogSource,
  normalizePluginManifest: normalizeDuyaPluginManifest,
};
