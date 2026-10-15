/**
 * Compatibility exports for callers that still use the former Desktop path.
 * Run manifest construction is owned by the Electron-independent Host package.
 */
export { buildRunManifest } from '@duya/host/manifest-factory';
export type { BuiltRun, RunIntent, RunOrigin } from '@duya/host/manifest-factory';
