// types.ts — plugin / catalog format adapter contract (plan 531).
//
// Every agent ecosystem ships the same *concept* — a catalog that lists
// plugins and a per-plugin manifest — behind different folder names,
// field names and source discriminators:
//
//   duya          .duya-plugin/plugin.json     { source: 'local' | 'git', … }
//   Claude Code   .claude-plugin/plugin.json   string | git-subdir | url
//   Codex         .codex-plugin/plugin.json    (same source shapes) + rich `interface`
//   Cursor        .cursor-plugin/plugin.json   (same family as Claude)
//
// Adapters normalize each of those into the canonical types below, at the
// boundary, so catalog / install / UI code never branches on the source
// format again. Adding an ecosystem is then a data change: one adapter
// file, one fixture, one registry line.
//
// Adapters are PURE — no fs, no path, no network — so this module stays
// safe to import from the browser-facing barrel. Location probing is
// expressed as plain string arrays that Node-side readers join.

export type PluginFormatId = 'duya' | 'claude-code' | 'codex' | 'cursor';

/**
 * Canonical plugin source after normalization. Mirrors the plan-455
 * `MarketplacePluginSource` union (a local directory or a pinned git repo).
 */
export type NormalizedPluginSource =
  | { source: 'local'; path: string }
  | {
      source: 'git';
      url: string;
      /** Subdirectory inside the cloned repo that holds the plugin. */
      path?: string;
      /** Branch / tag pin. Claude Code calls this `ref`. */
      ref_name?: string;
      /** Exact commit pin. */
      sha?: string;
    };

export interface NormalizedAuthor {
  name?: string;
  url?: string;
  email?: string;
}

/**
 * Canonical interface (presentation) block. Key names deliberately match
 * duya's own `interface` block so an adapter's output can be fed straight
 * to the existing duya parser without a second translation.
 */
export interface NormalizedInterface {
  displayName?: string;
  shortDescription?: string;
  longDescription?: string;
  category?: string;
  brandColor?: string;
  icon?: string;
  displayName_zh?: string;
  shortDescription_zh?: string;
  screenshots?: string[];
  defaultPrompt?: string[];
}

/**
 * Capability pointers a manifest declares. duya resolves the real
 * capability set from disk (`skills/`, `hooks/`, `.mcp.json`, …), so these
 * are hints kept for readers that want the declared form — notably Codex,
 * whose manifest carries them as path strings (`skills: "./skills/"`).
 */
export interface NormalizedDeclaredCapabilities {
  skills?: string;
  mcpServers?: string;
  apps?: string;
  hooks?: string;
}

export interface NormalizedPluginManifest {
  name: string;
  /** Defaulted to `0.0.0` when the source manifest omits it. */
  version: string;
  description?: string;
  author: NormalizedAuthor;
  license?: string;
  keywords: string[];
  homepage?: string;
  repository?: string;
  interface?: NormalizedInterface;
  declared?: NormalizedDeclaredCapabilities;
}

export interface FormatAdapter {
  id: PluginFormatId;
  /** Human label for diagnostics. */
  label: string;
  /** Lower = tried first when several adapters could match. */
  priority: number;
  /** Plugin-root-relative manifest paths, most-specific first. */
  pluginManifestPaths: readonly string[];
  /** Catalog-root-relative catalog file paths (empty = manifest-only). */
  catalogPaths: readonly string[];
  /** True when this adapter owns the given raw catalog plugin-source value. */
  detectCatalogSource?(raw: unknown): boolean;
  /** Normalize a raw catalog plugin-source value. Throw only on unusable input. */
  normalizeCatalogSource?(raw: unknown): NormalizedPluginSource;
  /** True when this adapter owns the given raw plugin manifest. */
  detectPluginManifest?(raw: unknown): boolean;
  /** Normalize a raw plugin manifest into the canonical shape. */
  normalizePluginManifest?(raw: unknown): NormalizedPluginManifest;
}
