/**
 * core store barrel — flat 7-file layout under `electron/db/core/`.
 * Each aggregate owns its own module; types are inline-exported, no
 * separate types.ts. See `docs/design-docs/2026-08-06-core-database-architecture.md`.
 */

export * from './database';
export * from './message-log';
export * from './session-store';
export * from './mailbox';
export * from './stores';
export * from './legacy-import';
