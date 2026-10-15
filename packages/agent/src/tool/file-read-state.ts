/**
 * Plan 610 A8 shim   ?session-level file read state moved to
 * `@duya/capabilities` (`fs/read-state`). Pass-through; the module-level
 * ledger instance lives in the capability, so every importer shares it.
 */

export * from '@duya/capabilities/file-read-state';
