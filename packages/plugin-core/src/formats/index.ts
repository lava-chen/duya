// index.ts — barrel for the plugin format adapter layer (plan 531).
//
// Pure normalization only: no fs / path / net, so this is safe to import
// from the browser-facing barrel. Node-side readers import the specific
// pieces they need (they join `allPluginManifestPaths()` onto a directory).

export type {
  FormatAdapter,
  NormalizedAuthor,
  NormalizedDeclaredCapabilities,
  NormalizedInterface,
  NormalizedPluginManifest,
  NormalizedPluginSource,
  PluginFormatId,
} from './types';

export {
  adapterForCatalogPath,
  adapterForManifestPath,
  allCatalogPaths,
  allPluginManifestPaths,
  detectCatalogSourceFormat,
  getAdapter,
  isNativeManifestPath,
  listAdapters,
  normalizeCatalogPolicy,
  normalizeCatalogSource,
  normalizePluginManifest,
} from './registry';
export type { NormalizedCatalogPolicy } from './registry';

export { duyaAdapter } from './duya';
export { claudeCodeAdapter, normalizeClaudeCatalogSource } from './claude-code';
export { codexAdapter } from './codex';
export { cursorAdapter } from './cursor';

export {
  asStringArray,
  buildInterfaceBlock,
  GIT_URL_LIKE,
  normalizeAuthor,
} from './shared';
