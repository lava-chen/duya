/**
 * config/index.ts - Configuration management exports
 *
 * Unified exports for config subsystem.
 */

export { ConfigStore, type ConfigStoreOptions } from './store';
export { DEFAULT_CONFIG, mergeConfig, type DuyaConfig } from './schema';
export { resolveConfigRoot, resolveConfigTomlPath, resolveDatabasePathFromConfigToml } from './compass';
// Legacy exports kept while ConfigManager remains (decision 14); removed when deleted.
export { initConfigManager, getConfigManager, toLLMProvider, type ApiProvider } from './manager';
export { resolveDatabasePath, updateDatabasePath } from './boot-config';
export { migrateMultiProviderV1 } from './migrations/multi-provider-v1';