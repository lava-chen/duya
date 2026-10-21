/**
 * `@duya/connectors` — the App Connector vocabulary and declaration schema.
 *
 * Plan 610 A5. Moved out of `packages/plugin-core/src/connectors/` so the
 * connector surface stops looking like part of the plugin distribution
 * framework. `plugin-core` owns plugin install / marketplace / manifest;
 * this package owns what an `.app.json` connector DECLARES.
 *
 * Two subpaths are declared in `package.json` `exports` and are the supported
 * surface. `.` re-exports both for convenience; a consumer that only needs
 * the id vocabulary or only the schema imports that subpath directly.
 *
 * Boundary: this package is vocabulary. It knows nothing about Goal / Task /
 * Run, performs no IO, and imports no other `@duya/*` package.
 */

export {
  AppDeclarationFileSchema,
  OAuthClientDeclarationSchema,
  AppToolDeclarationSchema,
  AppDeclarationSchema,
  RestInvokeDeclarationSchema,
  parseAppDeclarationFile,
} from './app-schema.js';
export type {
  AppDeclaration,
  AppToolDeclaration,
  OAuthClientDeclaration,
  RestInvokeDeclaration,
  ParsedAppDeclarations,
} from './app-schema.js';
export {
  asAppConnectorId,
  BUILTIN_CONNECTOR_IDS,
  isBuiltinConnectorId,
  isWellFormedConnectorId,
  pluginConnectorId,
} from './app-connector-id.js';
export type { AppConnectorId } from './app-connector-id.js';
