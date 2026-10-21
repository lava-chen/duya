/**
 * Synchronous compatibility facade for existing store-level tests.
 * Production services use HostConnectionStore and @duya/data owns the SQL DAO.
 */

import type Database from 'better-sqlite3';
import type { HostAppConnectionRecord } from '@duya/agent-protocol';
import { AppConnectionStore as DataAppConnectionStore } from '@duya/data/app-connection-store';
import { deriveConnectionSlug } from '@duya/plugin-core/mcp/core/alias';
import { asAppConnectorId } from '@duya/connectors/app-connector-id';
import type { AppConnection, AppConnectionStatus, ProviderId } from './types.js';
import type { ConnectionStorePort } from './connection-store-port.js';

export class ConnectionStore implements ConnectionStorePort {
  private readonly store: DataAppConnectionStore;

  constructor(db: Database.Database) {
    this.store = new DataAppConnectionStore(db, deriveConnectionSlug);
  }

  upsert(connection: AppConnection): AppConnection {
    return fromDataRecord(this.store.upsert({
      id: connection.id,
      provider: connection.provider,
      accountLabel: connection.accountLabel,
      accountId: connection.accountId,
      scopes: connection.scopes,
      status: connection.status,
      expiresAt: connection.expiresAt,
      lastError: connection.lastError,
      createdAt: connection.createdAt,
    }));
  }

  get(id: string): AppConnection | undefined {
    const record = this.store.get(id);
    return record ? fromDataRecord(record) : undefined;
  }

  list(): AppConnection[] {
    return this.store.list().map(fromDataRecord);
  }

  listByProvider(provider: ProviderId): AppConnection[] {
    return this.store.listByProvider(provider).map(fromDataRecord);
  }

  updateStatus(
    id: string,
    status: AppConnectionStatus,
    patch?: { expiresAt?: number | null; lastError?: string | null },
  ): AppConnection | undefined {
    const record = this.store.updateStatus(id, status, patch);
    return record ? fromDataRecord(record) : undefined;
  }

  remove(id: string): boolean {
    return this.store.remove(id);
  }
}

function fromDataRecord(record: HostAppConnectionRecord): AppConnection {
  return {
    id: record.id,
    provider: asAppConnectorId(record.provider),
    accountLabel: record.accountLabel,
    accountId: record.accountId,
    scopes: [...record.scopes],
    status: record.status,
    expiresAt: record.expiresAt,
    lastError: record.lastError,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    connectionSlug: record.connectionSlug,
  };
}
