/**
 * plugin-app-grant-store.ts — durable grant records for Plugin App capabilities
 * in `duya-core.db` (plan 610 T31b, dispatch doc 25).
 *
 * ## What this owns
 *
 * One row per (plugin, App, capability) written through the privileged Host
 * grant API:
 *
 *   - `plugin_id` / `app_id` / `capability` — which declaration the approval
 *     was for. The capability ID is an opaque plugin contract; nothing here
 *     parses it.
 *   - `mapping_revision` — the Host grant API's digest of the manifest tool
 *     scope it checked when it wrote this row.
 *   - `tools_json` — that checked scope snapshot.
 *   - `granted_at` / `revoked_at` — record-write time and revocation time.
 *
 * ## What this is NOT
 *
 * This is not the plugin registry's `grantedPermissions` and not
 * `plugin-core`'s `PermissionService`. Both of those record what a manifest
 * *asked* for; neither records a decision the user actually made. This store
 * persists the grant record supplied by a trusted caller; it does not prove
 * that a human approved it, authenticate callers, or enforce invocation
 * scope. Human approval and consumption of this record are responsibilities
 * of the later Host/Desktop composition. An App frame is not given direct
 * database access.
 *
 * The grant is also not a tool approval. A grant says the App may reach for
 * a capability; the Runtime's own MCP approval still decides whether a
 * particular call happens. A grant never bypasses that gate.
 *
 * ## Migration id 41
 *
 * Core migration ids run in one sequence across `collectCoreDataMigrations()`
 * (see `core-data-host.ts`); 40 went to `plugin-app-instance-store.ts`, so 41
 * was the next free id in this package. `main-schema.ts` numbers the SEPARATE
 * main database and reaches past 41; the two sequences are independent.
 */

import { Buffer } from 'node:buffer';
import type { Migration, SqliteDatabase } from './core-database.js';
import type { PluginAppCapabilityGrant, PluginAppCapabilityTool } from '@duya/agent-protocol';
export type { PluginAppCapabilityGrant, PluginAppCapabilityTool } from '@duya/agent-protocol';

/** Hard ceiling on one serialized tool scope, measured in UTF-8 bytes. */
export const PLUGIN_APP_GRANT_TOOLS_MAX_BYTES = 64 * 1024;

export interface PluginAppGrantInput {
  readonly pluginId: string;
  readonly appId: string;
  readonly capability: string;
  readonly mappingRevision: string;
  readonly tools: readonly PluginAppCapabilityTool[];
}

export type PluginAppGrantStoreErrorReason =
  /** A field was blank, or a tool entry was not a well-formed pair. */
  | 'invalid_input'
  /** The tool scope is not strictly JSON or is too large. */
  | 'invalid_tools'
  /** The stored tool scope is not readable as a JSON array. */
  | 'corrupt_tools';

export class PluginAppGrantStoreError extends Error {
  readonly reason: PluginAppGrantStoreErrorReason;

  constructor(reason: PluginAppGrantStoreErrorReason, message: string) {
    super(message);
    this.name = 'PluginAppGrantStoreError';
    this.reason = reason;
  }
}

interface PluginAppGrantRow {
  plugin_id: string;
  app_id: string;
  capability: string;
  mapping_revision: string;
  tools_json: string;
  granted_at: number;
  revoked_at: number | null;
}

function isNonEmptyString(value: string): boolean {
  return value.length > 0 && value.length <= 256 && value.trim() === value && !value.includes('\0');
}

function isTool(value: unknown): value is PluginAppCapabilityTool {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const candidate = value as { serverName?: unknown; toolName?: unknown };
  return typeof candidate.serverName === 'string' && typeof candidate.toolName === 'string';
}

function serializeTools(tools: readonly PluginAppCapabilityTool[]): string {
  const payload = tools.map((tool) => ({ serverName: tool.serverName, toolName: tool.toolName }));
  if (!payload.every(isTool)) {
    throw new PluginAppGrantStoreError('invalid_tools', 'A granted tool entry is malformed.');
  }
  const json = JSON.stringify(payload);
  if (Buffer.byteLength(json, 'utf8') > PLUGIN_APP_GRANT_TOOLS_MAX_BYTES) {
    throw new PluginAppGrantStoreError('invalid_tools', 'The granted tool scope is too large.');
  }
  return json;
}

function parseTools(json: string): PluginAppCapabilityTool[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    throw new PluginAppGrantStoreError('corrupt_tools', 'The stored tool scope is not readable.');
  }
  if (!Array.isArray(parsed) || !parsed.every(isTool)) {
    throw new PluginAppGrantStoreError('corrupt_tools', 'The stored tool scope is not a tool list.');
  }
  return parsed.map((tool) => ({ serverName: tool.serverName, toolName: tool.toolName }));
}

function rowToGrant(row: PluginAppGrantRow): PluginAppCapabilityGrant {
  return {
    pluginId: row.plugin_id,
    appId: row.app_id,
    capability: row.capability,
    mappingRevision: row.mapping_revision,
    tools: parseTools(row.tools_json),
    grantedAt: row.granted_at,
    revokedAt: row.revoked_at,
  };
}

export class PluginAppGrantStore {
  /** Migration id=41: create plugin_app_grants. */
  static readonly migrations: Migration[] = [
    {
      id: 41,
      name: 'create_plugin_app_grants',
      up: (db) => {
        db.exec(`
          CREATE TABLE IF NOT EXISTS plugin_app_grants (
            plugin_id        TEXT NOT NULL,
            app_id           TEXT NOT NULL,
            capability       TEXT NOT NULL,
            mapping_revision TEXT NOT NULL,
            tools_json       TEXT NOT NULL,
            granted_at       INTEGER NOT NULL,
            revoked_at       INTEGER,
            PRIMARY KEY (plugin_id, app_id, capability),
            CHECK (length(trim(plugin_id)) > 0),
            CHECK (length(trim(app_id)) > 0),
            CHECK (length(trim(capability)) > 0),
            CHECK (length(trim(mapping_revision)) > 0)
          );

          CREATE INDEX IF NOT EXISTS idx_plugin_app_grants_app
            ON plugin_app_grants(plugin_id, app_id);
        `);
      },
    },
  ];

  private readonly db: SqliteDatabase;

  constructor(db: SqliteDatabase) {
    this.db = db;
  }

  /**
 * Persist (or replace) one grant record supplied by the Host API.
   *
 * Replacing the row also replaces its mapping snapshot. This store does not
 * decide whether the replacement follows a human approval, or whether a
 * changed manifest mapping remains covered; the Host authority composition
 * must enforce those rules before writing or consuming the record.
   */
  grant(input: PluginAppGrantInput): PluginAppCapabilityGrant {
    if (!isNonEmptyString(input.pluginId) || !isNonEmptyString(input.appId) ||
        !isNonEmptyString(input.capability) || !isNonEmptyString(input.mappingRevision)) {
      throw new PluginAppGrantStoreError('invalid_input', 'A grant field is missing or malformed.');
    }
    const toolsJson = serializeTools(input.tools);
    const grantedAt = Date.now();
    this.db
      .prepare(
        `INSERT INTO plugin_app_grants (
           plugin_id, app_id, capability, mapping_revision, tools_json, granted_at, revoked_at
         ) VALUES (
           @plugin_id, @app_id, @capability, @mapping_revision, @tools_json, @granted_at, NULL
         )
         ON CONFLICT (plugin_id, app_id, capability) DO UPDATE SET
           mapping_revision = excluded.mapping_revision,
           tools_json = excluded.tools_json,
           granted_at = excluded.granted_at,
           revoked_at = NULL`,
      )
      .run({
        plugin_id: input.pluginId,
        app_id: input.appId,
        capability: input.capability,
        mapping_revision: input.mappingRevision,
        tools_json: toolsJson,
        granted_at: grantedAt,
      });
    const stored = this.get(input.pluginId, input.appId, input.capability);
    if (stored === null) {
      throw new PluginAppGrantStoreError('corrupt_tools', 'The granted row could not be read back.');
    }
    return stored;
  }

  /**
   * Revoke one capability. Returns false when there was nothing to revoke,
   * so a repeated revoke is not an error.
   */
  revoke(input: { pluginId: string; appId: string; capability: string }): boolean {
    if (!isNonEmptyString(input.pluginId) || !isNonEmptyString(input.appId) ||
        !isNonEmptyString(input.capability)) {
      throw new PluginAppGrantStoreError('invalid_input', 'A grant field is missing or malformed.');
    }
    const result = this.db
      .prepare(
        `UPDATE plugin_app_grants
         SET revoked_at = @revoked_at
         WHERE plugin_id = @plugin_id AND app_id = @app_id AND capability = @capability
           AND revoked_at IS NULL`,
      )
      .run({
        plugin_id: input.pluginId,
        app_id: input.appId,
        capability: input.capability,
        revoked_at: Date.now(),
      });
    return result.changes > 0;
  }

  get(pluginId: string, appId: string, capability: string): PluginAppCapabilityGrant | null {
    const row = this.db
      .prepare(
        `SELECT * FROM plugin_app_grants
         WHERE plugin_id = ? AND app_id = ? AND capability = ?`,
      )
      .get(pluginId, appId, capability) as PluginAppGrantRow | undefined;
    return row ? rowToGrant(row) : null;
  }

  /** Every recorded grant for one App, revoked ones included. */
  listByApp(pluginId: string, appId: string): PluginAppCapabilityGrant[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM plugin_app_grants
         WHERE plugin_id = ? AND app_id = ?
         ORDER BY capability`,
      )
      .all(pluginId, appId) as PluginAppGrantRow[];
    return rows.map(rowToGrant);
  }

  /** The capabilities the user currently approves for one App. */
  listActiveCapabilities(pluginId: string, appId: string): string[] {
    const rows = this.db
      .prepare(
        `SELECT capability FROM plugin_app_grants
         WHERE plugin_id = ? AND app_id = ? AND revoked_at IS NULL
         ORDER BY capability`,
      )
      .all(pluginId, appId) as Array<{ capability: string }>;
    return rows.map((row) => row.capability);
  }
}
