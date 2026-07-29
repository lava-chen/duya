/**
 * ConnectionStore — SQLite DAO for App Connection metadata.
 *
 * Plan 312 Phase 0. Companion to {@link TokenVault}: this layer owns
 * the connection lifecycle state machine, the vault owns the secrets.
 *
 * Schema lives in `electron/db/schema.ts` (`app_connections` table).
 * Uses `CREATE TABLE IF NOT EXISTS`, so no migration entry is needed
 * beyond the schema file — the table appears on the next boot.
 */

import type Database from 'better-sqlite3';
import type {
  AppConnection,
  AppConnectionStatus,
  ProviderId,
} from './types';
import { getLogger, LogComponent } from '../../logging/logger';

const COMPONENT = 'AppConnectionStore' as LogComponent;

interface AppConnectionRow {
  id: string;
  provider: string;
  account_label: string;
  account_id: string;
  scopes: string;
  status: string;
  expires_at: number | null;
  last_error: string | null;
  created_at: number;
  updated_at: number;
}

function rowToConnection(row: AppConnectionRow): AppConnection {
  let scopes: string[] = [];
  try {
    const parsed = JSON.parse(row.scopes) as unknown;
    if (Array.isArray(parsed)) scopes = parsed.filter((s): s is string => typeof s === 'string');
  } catch {
    // malformed JSON → empty scopes
  }
  return {
    id: row.id,
    provider: row.provider as ProviderId,
    accountLabel: row.account_label,
    accountId: row.account_id,
    scopes,
    status: row.status as AppConnectionStatus,
    expiresAt: row.expires_at,
    lastError: row.last_error,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export class ConnectionStore {
  private readonly logger = getLogger();
  private readonly db: Database.Database;

  constructor(db: Database.Database) {
    this.db = db;
  }

  upsert(conn: AppConnection): AppConnection {
    const now = Date.now();
    this.db
      .prepare(
        `INSERT INTO app_connections
           (id, provider, account_label, account_id, scopes, status, expires_at, last_error, created_at, updated_at)
         VALUES (@id, @provider, @account_label, @account_id, @scopes, @status, @expires_at, @last_error, @created_at, @updated_at)
         ON CONFLICT(id) DO UPDATE SET
           provider = excluded.provider,
           account_label = excluded.account_label,
           account_id = excluded.account_id,
           scopes = excluded.scopes,
           status = excluded.status,
           expires_at = excluded.expires_at,
           last_error = excluded.last_error,
           updated_at = excluded.updated_at`,
      )
      .run({
        id: conn.id,
        provider: conn.provider,
        account_label: conn.accountLabel,
        account_id: conn.accountId,
        scopes: JSON.stringify(conn.scopes),
        status: conn.status,
        expires_at: conn.expiresAt,
        last_error: conn.lastError,
        created_at: conn.createdAt ?? now,
        updated_at: now,
      });
    return this.get(conn.id) ?? { ...conn, updatedAt: now };
  }

  get(id: string): AppConnection | undefined {
    const row = this.db
      .prepare('SELECT * FROM app_connections WHERE id = ?')
      .get(id) as AppConnectionRow | undefined;
    return row ? rowToConnection(row) : undefined;
  }

  list(): AppConnection[] {
    const rows = this.db
      .prepare('SELECT * FROM app_connections ORDER BY updated_at DESC')
      .all() as AppConnectionRow[];
    return rows.map(rowToConnection);
  }

  listByProvider(provider: ProviderId): AppConnection[] {
    const rows = this.db
      .prepare('SELECT * FROM app_connections WHERE provider = ? ORDER BY updated_at DESC')
      .all(provider) as AppConnectionRow[];
    return rows.map(rowToConnection);
  }

  updateStatus(
    id: string,
    status: AppConnectionStatus,
    patch?: { expiresAt?: number | null; lastError?: string | null },
  ): AppConnection | undefined {
    const current = this.get(id);
    if (!current) {
      this.logger.warn('updateStatus: connection not found', { id }, COMPONENT);
      return undefined;
    }
    const now = Date.now();
    this.db
      .prepare(
        `UPDATE app_connections
           SET status = @status,
               expires_at = @expires_at,
               last_error = @last_error,
               updated_at = @updated_at
           WHERE id = @id`,
      )
      .run({
        id,
        status,
        expires_at: patch?.expiresAt !== undefined ? patch.expiresAt : current.expiresAt,
        last_error: patch?.lastError !== undefined ? patch.lastError : current.lastError,
        updated_at: now,
      });
    return this.get(id);
  }

  remove(id: string): boolean {
    const result = this.db.prepare('DELETE FROM app_connections WHERE id = ?').run(id);
    return result.changes > 0;
  }
}
