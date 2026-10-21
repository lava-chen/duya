import type { AppConnection, AppConnectionStatus, ProviderId } from './types.js';

export type MaybePromise<T> = T | Promise<T>;

/** Supports synchronous in-memory fakes and the asynchronous Host transport. */
export interface ConnectionStorePort {
  list(): MaybePromise<AppConnection[]>;
  listByProvider(provider: ProviderId): MaybePromise<AppConnection[]>;
  get(id: string): MaybePromise<AppConnection | undefined>;
  upsert(connection: AppConnection): MaybePromise<AppConnection>;
  updateStatus(
    id: string,
    status: AppConnectionStatus,
    patch?: { expiresAt?: number | null; lastError?: string | null },
  ): MaybePromise<AppConnection | undefined>;
  remove(id: string): MaybePromise<boolean>;
}
