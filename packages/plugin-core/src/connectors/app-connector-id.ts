/**
 * AppConnectorId — Plan 455 Phase A.
 *
 * Codex parity: `codex-rs/plugin/src/lib.rs` `AppConnectorId(pub String)`.
 * A branded string, NOT a closed union: the connector catalog is open —
 * plugins declare new connectors via `.app.json` and the host resolves
 * them at runtime. The builtin ids below are well-known residents of the
 * catalog, not the type's extent.
 */

export type AppConnectorId = string & { readonly __brand: 'AppConnectorId' };

export function asAppConnectorId(id: string): AppConnectorId {
  return id as AppConnectorId;
}

/** Well-known first-party connector ids (Plan 312 builtin providers). */
export const BUILTIN_CONNECTOR_IDS: readonly AppConnectorId[] = [
  'google',
  'gmail',
  'calendar',
  'slack',
  'microsoft365',
  'figma',
  'supabase',
  'sentry',
  'vercel',
  'notion',
  'linear',
  'github',
  'wecom',
].map(asAppConnectorId);

const BUILTIN_ID_SET = new Set<string>(BUILTIN_CONNECTOR_IDS);

export function isBuiltinConnectorId(id: string): boolean {
  return BUILTIN_ID_SET.has(id);
}

const ID_SEGMENT_PATTERN = /^[a-z][a-z0-9_-]*$/;

/** Shape check for a raw declared id (before namespacing). */
export function isWellFormedConnectorId(id: string): boolean {
  return ID_SEGMENT_PATTERN.test(id);
}

/**
 * Third-party declaration namespace: `plugin-<config-name>-<connectorId>`
 * (Plan 455 OQ2) — predictable and auditable; can never collide with
 * builtin ids or with another plugin's connectors.
 */
export function pluginConnectorId(configName: string, connectorId: string): string {
  return `plugin-${configName}-${connectorId}`;
}
