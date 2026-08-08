/**
 * config/index.ts - Configuration management exports
 *
 * Unified exports for config subsystem.
 */

export { ConfigStore, type ConfigStoreOptions } from './store';
export { DEFAULT_CONFIG, mergeConfig, type DuyaConfig } from './schema';
export { resolveConfigRoot, resolveConfigTomlPath, resolveDatabasePathFromConfigToml } from './compass';
export { toLLMProvider, type ApiProvider, type ApiProviderType, type LLMProvider } from './provider-types';
export { resolveDatabasePath, updateDatabasePath } from './boot-config';