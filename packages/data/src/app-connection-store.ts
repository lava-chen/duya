import type {
  HostAppConnectionRecord,
  HostAppConnectionStatus,
  HostAppConnectionStatusPatch,
  HostAppConnectionWriteInput,
} from '@duya/agent-protocol/app-connections';
import type { SqliteDatabase } from './sqlite-connection.js';

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
  connection_slug: string;
}

export type DeriveConnectionSlug = (connectionId: string, takenSlugs: ReadonlySet<string>) => string;

/** Data-owned persistence for App Connection metadata; secrets remain in TokenVault. */
export class AppConnectionStore {
  constructor(
    private readonly db: SqliteDatabase,
    private readonly deriveConnectionSlug: DeriveConnectionSlug,
  ) {}

  upsert(input: HostAppConnectionWriteInput): HostAppConnectionRecord {
    const now = Date.now();
    const existing = this.get(input.id);
    let connectionSlug: string;
    if (existing) {
      connectionSlug = existing.connectionSlug;
    } else {
      const siblings = this.listByProvider(input.provider).filter((row) => row.id !== input.id);
      connectionSlug = siblings.length === 0
        ? ''
        : this.deriveConnectionSlug(
            input.id,
            new Set(['', ...siblings.map((row) => row.connectionSlug)]),
          );
    }

    this.db.prepare(
      `INSERT INTO app_connections
         (id, provider, account_label, account_id, scopes, status, expires_at, last_error, created_at, updated_at, connection_slug)
       VALUES (@id, @provider, @account_label, @account_id, @scopes, @status, @expires_at, @last_error, @created_at, @updated_at, @connection_slug)
       ON CONFLICT(id) DO UPDATE SET
         provider = excluded.provider,
         account_label = excluded.account_label,
         account_id = excluded.account_id,
         scopes = excluded.scopes,
         status = excluded.status,
         expires_at = excluded.expires_at,
         last_error = excluded.last_error,
         updated_at = excluded.updated_at`,
    ).run({
      id: input.id,
      provider: input.provider,
      account_label: input.accountLabel,
      account_id: input.accountId,
      scopes: JSON.stringify(input.scopes),
      status: input.status,
      expires_at: input.expiresAt,
      last_error: input.lastError,
      created_at: input.createdAt ?? now,
      updated_at: now,
      connection_slug: connectionSlug,
    });

    return this.get(input.id) ?? {
      ...input,
      scopes: [...input.scopes],
      connectionSlug,
      updatedAt: now,
    };
  }

  get(id: string): HostAppConnectionRecord | null {
    const row = this.db.prepare('SELECT * FROM app_connections WHERE id = ?').get(id) as AppConnectionRow | undefined;
    return row ? rowToRecord(row) : null;
  }

  list(): readonly HostAppConnectionRecord[] {
    const rows = this.db.prepare('SELECT * FROM app_connections ORDER BY updated_at DESC').all() as AppConnectionRow[];
    return rows.map(rowToRecord);
  }

  listByProvider(provider: string): readonly HostAppConnectionRecord[] {
    const rows = this.db.prepare(
      'SELECT * FROM app_connections WHERE provider = ? ORDER BY updated_at DESC',
    ).all(provider) as AppConnectionRow[];
    return rows.map(rowToRecord);
  }

  updateStatus(
    id: string,
    status: HostAppConnectionStatus,
    patch?: HostAppConnectionStatusPatch,
  ): HostAppConnectionRecord | null {
    const current = this.get(id);
    if (!current) return null;
    this.db.prepare(
      `UPDATE app_connections
         SET status = @status,
             expires_at = @expires_at,
             last_error = @last_error,
             updated_at = @updated_at
       WHERE id = @id`,
    ).run({
      id,
      status,
      expires_at: patch?.expiresAt !== undefined ? patch.expiresAt : current.expiresAt,
      last_error: patch?.lastError !== undefined ? patch.lastError : current.lastError,
      updated_at: Date.now(),
    });
    return this.get(id);
  }

  remove(id: string): boolean {
    return this.db.prepare('DELETE FROM app_connections WHERE id = ?').run(id).changes > 0;
  }
}

function rowToRecord(row: AppConnectionRow): HostAppConnectionRecord {
  let scopes: string[] = [];
  try {
    const parsed: unknown = JSON.parse(row.scopes);
    if (Array.isArray(parsed)) scopes = parsed.filter((value): value is string => typeof value === 'string');
  } catch {
    // Treat malformed persisted scope JSON as an empty list.
  }
  return {
    id: row.id,
    provider: row.provider,
    accountLabel: row.account_label,
    accountId: row.account_id,
    scopes,
    status: row.status as HostAppConnectionStatus,
    expiresAt: row.expires_at,
    lastError: row.last_error,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    connectionSlug: row.connection_slug,
  };
}
