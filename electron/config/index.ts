/**
 * config/index.ts - Configuration management exports
 *
 * Unified exports for config subsystem.
 */

export {
  initConfigManager,
  getConfigManager,
  toLLMProvider,
  type ApiProvider,
} from './manager';

export {
  resolveDatabasePath,
  updateDatabasePath,
} from './boot-config';

export { migrateMultiProviderV1 } from './migrations/multi-provider-v1';