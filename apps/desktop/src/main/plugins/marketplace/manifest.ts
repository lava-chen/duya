// manifest.ts — the Desktop's alias for the shared marketplace catalog reader.
//
// The reader itself lives in `@duya/plugin-core/marketplace/manifest` (plan 631)
// so the standalone Host can build a plugin catalog without Electron. It is
// already Electron-free: this re-export exists so the Desktop's import sites and
// tests keep one spelling.
export {
  MARKETPLACE_MANIFEST_RELATIVE_PATHS,
  readMarketplaceManifest,
  resolveContainedPath,
  resolvePluginEntryDir,
  type LoadedMarketplaceManifest,
  type MarketplaceAuthPolicy,
  type MarketplaceInstallPolicy,
  type MarketplacePluginEntry,
  type MarketplacePluginSource,
} from '@duya/plugin-core/marketplace/manifest';
