/**
 * plugin-management — the Host's write side of `[plugins]` and `[marketplaces]`.
 *
 * The inventory next door (`plugin-inventory.ts`) reads what is installed; this
 * directory answers "what could I install, and change it". Split by concern the
 * way `provider-management/` is: `plugin-files.ts` owns the two namespaces and
 * their revision, `plugin-catalog.ts` and `plugin-marketplaces.ts` project the
 * on-disk catalogs into client rows, `management-api.ts` owns the rules.
 *
 * The install and git primitives themselves live in `@duya/plugin-core`, which
 * is what lets the Desktop and a standalone Host share one set of safety rules.
 */

export {
  HostPluginApiError,
  createHostLocalPluginManagementApi,
} from './management-api.js';
export type { PluginManagementOptions } from './management-api.js';
export { buildPluginCatalog } from './plugin-catalog.js';
export type { CatalogBuild, CatalogRow } from './plugin-catalog.js';
export {
  PluginFileError,
  parsePluginConfigKey,
  pluginFilePaths,
  readPluginSnapshot,
  revisionOf,
  toPluginConfigKey,
  toPluginTable,
  writeMarketplaceTable,
  writePluginTable,
} from './plugin-files.js';
export type {
  PluginFiles,
  PluginIntent,
  PluginSnapshot,
} from './plugin-files.js';
export { buildMarketplaceView, buildMarketplaceViews } from './plugin-marketplaces.js';
export type { MarketplaceViewBuild } from './plugin-marketplaces.js';
