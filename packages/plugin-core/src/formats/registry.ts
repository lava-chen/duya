// registry.ts — the format adapter registry (plan 531).
//
// Single lookup surface for everything format-related:
//   - location tables (which paths to probe for a catalog / a plugin manifest)
//   - detection + dispatch (which adapter owns a raw value)
//   - canonical normalization (catalog source, catalog policy, plugin manifest)
//
// Consumers (`electron/plugins/manifest.ts`,
// `electron/plugins/marketplace/manifest.ts`, install, UI) call these and
// never branch on a raw source format again. Adding an ecosystem is one
// adapter file + one fixture + one line in ADAPTERS.

import type {
  FormatAdapter,
  NormalizedPluginManifest,
  NormalizedPluginSource,
  PluginFormatId,
} from './types';
import { asString, isPlainObject } from './shared';
import { duyaAdapter } from './duya';
import { claudeCodeAdapter } from './claude-code';
import { codexAdapter } from './codex';
import { cursorAdapter } from './cursor';

/** Registered adapters, ordered by ascending `priority`. */
const ADAPTERS: readonly FormatAdapter[] = [
  duyaAdapter,
  claudeCodeAdapter,
  codexAdapter,
  cursorAdapter,
].sort((a, b) => a.priority - b.priority);

export function listAdapters(): readonly FormatAdapter[] {
  return ADAPTERS;
}

export function getAdapter(id: PluginFormatId): FormatAdapter | undefined {
  return ADAPTERS.find((a) => a.id === id);
}

/** Concatenate path groups in adapter-priority order, de-duplicated. */
function uniqueOrdered(groups: readonly (readonly string[])[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const group of groups) {
    for (const p of group) {
      if (!seen.has(p)) {
        seen.add(p);
        out.push(p);
      }
    }
  }
  return out;
}

/** Every plugin-root-relative manifest path duya should probe, in order. */
export function allPluginManifestPaths(): readonly string[] {
  return uniqueOrdered(ADAPTERS.map((a) => a.pluginManifestPaths));
}

/** Every catalog-root-relative catalog path duya should probe, in order. */
export function allCatalogPaths(): readonly string[] {
  return uniqueOrdered(ADAPTERS.map((a) => a.catalogPaths));
}

/**
 * Normalize a root-relative path for path-table lookups.
 *
 * Only separators are normalized — a leading `./` is deliberately NOT
 * stripped, because every manifest path starts with a dot-folder
 * (`.duya-plugin/…`, `.claude-plugin/…`) and on Windows `path.join` produces
 * backslashes while a `./`-prefixed input would otherwise lose its dot.
 */
function normalizeRelPath(relPath: string): string {
  return relPath.replace(/\\/g, '/');
}

/** The adapter that owns a plugin manifest at the given root-relative path. */
export function adapterForManifestPath(relPath: string): FormatAdapter | undefined {
  const norm = normalizeRelPath(relPath);
  return ADAPTERS.find((a) => a.pluginManifestPaths.includes(norm));
}

/** The adapter that owns a catalog at the given root-relative path. */
export function adapterForCatalogPath(relPath: string): FormatAdapter | undefined {
  const norm = normalizeRelPath(relPath);
  return ADAPTERS.find((a) => a.catalogPaths.includes(norm));
}

/** The first adapter claiming the raw catalog plugin-source value. */
export function detectCatalogSourceFormat(raw: unknown): FormatAdapter | undefined {
  return ADAPTERS.find((a) => a.detectCatalogSource?.(raw) === true);
}

/**
 * Normalize a catalog plugin-source value to the canonical local/git union.
 * Throws when no adapter recognizes it (callers that want a soft failure
 * should catch and fall through to their own validation error).
 */
export function normalizeCatalogSource(raw: unknown): NormalizedPluginSource {
  const adapter = detectCatalogSourceFormat(raw);
  if (!adapter?.normalizeCatalogSource) {
    throw new Error('no format adapter recognizes this catalog source');
  }
  return adapter.normalizeCatalogSource(raw);
}

export interface NormalizedCatalogPolicy {
  installation?: 'not_available' | 'available' | 'installed_by_default';
  authentication?: 'on_install' | 'on_use';
}

/**
 * Canonicalize a catalog entry's `policy` block.
 *
 * Format-independent by design — which is why it lives on the registry
 * rather than on an adapter. duya and Claude Code already emit lowercase
 * enum values, but Codex emits UPPERCASE ("AVAILABLE" / "ON_INSTALL" /
 * "INSTALLED_BY_DEFAULT"; verified against
 * openai/plugins/.agents/plugins/marketplace.json). A present-but-uppercase
 * value would otherwise fail duya's enum validation and take the whole
 * catalog down with it, so folding case here is load-bearing.
 *
 * Unknown values are dropped (the caller's schema then applies its default)
 * rather than propagated as invalid.
 */
export function normalizeCatalogPolicy(raw: unknown): NormalizedCatalogPolicy | undefined {
  if (!isPlainObject(raw)) return undefined;
  const out: NormalizedCatalogPolicy = {};
  const installation = asString(raw.installation)?.toLowerCase();
  if (
    installation === 'not_available' ||
    installation === 'available' ||
    installation === 'installed_by_default'
  ) {
    out.installation = installation;
  }
  const authentication = asString(raw.authentication)?.toLowerCase();
  if (authentication === 'on_install' || authentication === 'on_use') {
    out.authentication = authentication;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/**
 * Normalize a plugin manifest. The adapter for the manifest's layout path
 * wins; a bare `raw` with no known path falls back to the duya adapter.
 */
export function normalizePluginManifest(
  relPath: string | undefined,
  raw: unknown,
): NormalizedPluginManifest {
  const adapter = (relPath ? adapterForManifestPath(relPath) : undefined) ?? ADAPTERS[0];
  const normalize = adapter.normalizePluginManifest;
  if (!normalize) {
    throw new Error(`format adapter "${adapter.id}" cannot normalize plugin manifests`);
  }
  return normalize(raw);
}

/** Path predicate used by readers that special-case the native layout. */
export function isNativeManifestPath(relPath: string): boolean {
  return adapterForManifestPath(relPath)?.id === 'duya';
}
