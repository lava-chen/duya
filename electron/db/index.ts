/**
 * db/index.ts - Barrel export for the db/ directory
 *
 * All imports from electron/db-handlers.ts should eventually
 * be redirected to this file as the single entry point.
 */

// Re-exports from sub-modules
export {
  initDatabaseFromBoot,
  initDatabase,
  getDatabase,
  getDatabasePath,
  isSafeMode,
  getSafeModeReason,
  getDatabaseStats,
  checkDatabaseSizeWarning,
} from './connection';
export type { DbInitResult, DatabaseStats } from './connection';

// Queries layer
export * from './queries/sessions';
export * from './queries/threads';
export * from './queries/messages';
export * from './queries/conductors';
export * from './queries/crons';
export * from './queries/settings';
