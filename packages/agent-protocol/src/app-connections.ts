export type HostAppConnectionStatus =
  | 'disconnected'
  | 'pending'
  | 'connected'
  | 'expired'
  | 'revoked'
  | 'error';

/** Persisted App Connection metadata. Credentials never cross this contract. */
export interface HostAppConnectionRecord {
  readonly id: string;
  readonly provider: string;
  readonly accountLabel: string;
  readonly accountId: string;
  readonly scopes: readonly string[];
  readonly status: HostAppConnectionStatus;
  readonly expiresAt: number | null;
  readonly lastError: string | null;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly connectionSlug: string;
}

export interface HostAppConnectionWriteInput {
  readonly id: string;
  readonly provider: string;
  readonly accountLabel: string;
  readonly accountId: string;
  readonly scopes: readonly string[];
  readonly status: HostAppConnectionStatus;
  readonly expiresAt: number | null;
  readonly lastError: string | null;
  readonly createdAt: number;
}

export interface HostAppConnectionStatusPatch {
  readonly expiresAt?: number | null;
  readonly lastError?: string | null;
}

/** Local-only persistence capability for connection metadata. */
export interface HostLocalAppConnectionApiV1 {
  listAppConnections(): Promise<readonly HostAppConnectionRecord[]>;
  listAppConnectionsByProvider(provider: string): Promise<readonly HostAppConnectionRecord[]>;
  getAppConnection(id: string): Promise<HostAppConnectionRecord | null>;
  upsertAppConnection(input: HostAppConnectionWriteInput): Promise<HostAppConnectionRecord>;
  updateAppConnectionStatus(
    id: string,
    status: HostAppConnectionStatus,
    patch?: HostAppConnectionStatusPatch,
  ): Promise<HostAppConnectionRecord | null>;
  removeAppConnection(id: string): Promise<boolean>;
}
