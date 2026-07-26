/**
 * Backward-compat re-export.
 *
 * The ConfigManager implementation was moved into `electron/config/manager.ts`
 * (part of the config subsystem folder), but the unit test at
 * `electron/config-manager.test.ts` still imports `./config-manager`. Keep
 * this thin shim so the test resolves without rewriting every import.
 */
export * from './config/manager';
