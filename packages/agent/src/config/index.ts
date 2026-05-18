/**
 * Config module exports
 * Configuration file reader for agent package
 */

export { readConfig, getConfigDatabasePath } from './config.js';
export type { AppConfig } from './config.js';

// Cache configuration
export * from './cache-config.js';