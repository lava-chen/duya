import type {
  HostAppConnectionRecord,
  HostAppConnectionWriteInput,
  HostLocalAppConnectionApiV1,
} from '@duya/agent-protocol';
import { asAppConnectorId } from '@duya/connectors/app-connector-id';
import type { AppConnection } from './types.js';
import type { ConnectionStorePort } from './connection-store-port.js';

/** Adapts the authenticated Host API to the OAuth and connector service port. */
export class HostConnectionStore implements ConnectionStorePort {
  constructor(private readonly api: HostLocalAppConnectionApiV1) {}

  async list(): Promise<AppConnection[]> {
    return (await this.api.listAppConnections()).map(toAppConnection);
  }

  async listByProvider(provider: string): Promise<AppConnection[]> {
    return (await this.api.listAppConnectionsByProvider(provider)).map(toAppConnection);
  }

  async get(id: string): Promise<AppConnection | undefined> {
    const record = await this.api.getAppConnection(id);
    return record ? toAppConnection(record) : undefined;
  }

  async upsert(connection: AppConnection): Promise<AppConnection> {
    const input: HostAppConnectionWriteInput = {
      id: connection.id,
      provider: connection.provider,
      accountLabel: connection.accountLabel,
      accountId: connection.accountId,
      scopes: [...connection.scopes],
      status: connection.status,
      expiresAt: connection.expiresAt,
      lastError: connection.lastError,
      createdAt: connection.createdAt,
    };
    return toAppConnection(await this.api.upsertAppConnection(input));
  }

  async updateStatus(
    id: string,
    status: AppConnection['status'],
    patch?: { expiresAt?: number | null; lastError?: string | null },
  ): Promise<AppConnection | undefined> {
    const record = await this.api.updateAppConnectionStatus(id, status, patch);
    return record ? toAppConnection(record) : undefined;
  }

  remove(id: string): Promise<boolean> {
    return this.api.removeAppConnection(id);
  }
}

function toAppConnection(record: HostAppConnectionRecord): AppConnection {
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
