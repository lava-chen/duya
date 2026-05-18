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