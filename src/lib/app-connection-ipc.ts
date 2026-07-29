/**
 * App Connection IPC client — Renderer-side wrapper.
 *
 * Plan 312 Phase 2. Mirrors the shape of `src/lib/plugin-ipc.ts`:
 *   - thin wrapper over `window.electronAPI.appConnection`
 *   - returns the same DTO envelope the IPC handlers return
 *   - never touches token fields (they don't exist on the DTO)
 *
 * The `AppConnectionStatusDTO` is re-exported so renderer components
 * can stay type-safe without importing from `electron/services`.
 */

import type { AppConnectionStatusDTO } from '../../electron/services/app-connections/types';

export type { AppConnectionStatusDTO } from '../../electron/services/app-connections/types';

export type { ProviderId, AppConnectionStatus } from '../../electron/services/app-connections/types';

export interface AppConnectionListResponse {
  success: boolean;
  data?: AppConnectionStatusDTO[];
  error?: string;
}

export interface AppConnectionSingleResponse {
  success: boolean;
  data?: AppConnectionStatusDTO;
  error?: string;
  errorCode?: string;
}

export interface AppConnectionDisconnectResponse {
  success: boolean;
  data?: { disconnected: boolean };
  error?: string;
}

export function getAppConnectionAPI() {
  const api = window.electronAPI;
  if (!api) {
    return null;
  }
  return {
    list: async (): Promise<AppConnectionListResponse> => {
      return api.appConnection.list() as Promise<AppConnectionListResponse>;
    },
    status: async (connectionId: string): Promise<AppConnectionSingleResponse> => {
      return api.appConnection.status(connectionId) as Promise<AppConnectionSingleResponse>;
    },
    connect: async (payload: {
      provider: 'google' | 'slack' | 'microsoft365';
      scopes?: string[];
    }): Promise<AppConnectionSingleResponse> => {
      return api.appConnection.connect(payload) as Promise<AppConnectionSingleResponse>;
    },
    disconnect: async (connectionId: string): Promise<AppConnectionDisconnectResponse> => {
      return api.appConnection.disconnect(connectionId) as Promise<AppConnectionDisconnectResponse>;
    },
  };
}
