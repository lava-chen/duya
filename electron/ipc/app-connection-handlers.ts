/**
 * ipc/app-connection-handlers.ts — App Connection IPC handlers.
 *
 * Plan 312 Phase 2. Mirrors the shape of `plugin-handlers.ts`:
 *   - registerAppConnectionHandlers() installs all `appConnection:*` channels
 *   - state mutations (connect/disconnect) trigger the agent-reload
 *     broadcast so connector tools come online / go offline
 *
 * Hard boundary: every channel returns ONLY the renderer-safe
 * {@link AppConnectionStatusDTO}. Tokens never cross IPC.
 */

import { ipcMain } from 'electron';
import * as http from 'http';
import { getDatabase } from '../db/connection';
import { getLogger, LogComponent } from '../logging/logger';
import {
  getAppConnectionService,
} from '../services/app-connections/app-connection-service';
import { FlowError } from '../services/app-connections/oauth/flow';
import { isKnownProvider } from '../services/app-connections/providers/registry';
import type {
  AppConnectionStatusDTO,
  AppConnectionProviderDTO,
  ProviderId,
} from '../services/app-connections/types';

const COMPONENT = 'AppConnectionHandlers' as LogComponent;

let cachedAgentServerUrl: string | null = null;

async function getAgentServerUrl(): Promise<string | null> {
  if (cachedAgentServerUrl) return cachedAgentServerUrl;
  try {
    const { getAgentServerPort } = await import('../agents/agent-server-lifecycle');
    const port = getAgentServerPort();
    if (port) {
      cachedAgentServerUrl = `http://127.0.0.1:${port}`;
    }
    return cachedAgentServerUrl;
  } catch {
    return null;
  }
}

/** Notify the agent server that tools should be re-collected. */
async function notifyAgentServerAppConnectionReload(): Promise<void> {
  const url = await getAgentServerUrl();
  if (!url) return;
  try {
    await new Promise<void>((resolve) => {
      const req = http.request(`${url}/plugins/reload`, { method: 'POST' }, (res) => {
        res.resume();
        resolve();
      });
      req.on('error', () => resolve());
      req.setTimeout(2000, () => {
        req.destroy();
        resolve();
      });
      req.end();
    });
  } catch {
    // Silently ignore - agent server may not be running
  }
}

export interface AppConnectionListResponse {
  success: boolean;
  data?: AppConnectionStatusDTO[];
  error?: string;
}

export interface AppConnectionProviderListResponse {
  success: boolean;
  data?: AppConnectionProviderDTO[];
  error?: string;
}

export interface AppConnectionProviderResponse {
  success: boolean;
  data?: AppConnectionProviderDTO;
  error?: string;
  errorCode?: string;
}

export interface AppConnectionSingleResponse {
  success: boolean;
  data?: AppConnectionStatusDTO;
  error?: string;
  /** Structured error code for the renderer to map to UX. */
  errorCode?: string;
}

/**
 * Resolve the connection service only after the boot database is ready.
 *
 * IPC handlers are registered while Electron is still booting, before
 * `initDatabaseFromBoot()` completes. Constructing the singleton during
 * registration used to capture a null database permanently, so every later
 * `appConnection:list` request failed even though boot had completed.
 */
function getReadyAppConnectionService() {
  if (!getDatabase()) {
    throw new Error('App connection database is not ready');
  }
  const service = getAppConnectionService();
  service.setReloadHook(notifyAgentServerAppConnectionReload);
  return service;
}

function getErrorCode(error: unknown): string {
  if (error instanceof FlowError) return error.code;
  if (
    error &&
    typeof error === 'object' &&
    'code' in error &&
    typeof (error as { code?: unknown }).code === 'string'
  ) {
    return (error as { code: string }).code;
  }
  return 'internal';
}

export function registerAppConnectionHandlers(): void {
  const logger = getLogger();

  // --- appConnection:list ---
  ipcMain.handle(
    'appConnection:list',
    async (): Promise<AppConnectionListResponse> => {
      try {
        const list = getReadyAppConnectionService().list();
        return { success: true, data: list };
      } catch (err) {
        logger.error(
          'appConnection:list failed',
          err instanceof Error ? err : new Error(String(err)),
          undefined,
          COMPONENT,
        );
        return { success: false, error: 'Failed to list app connections' };
      }
    },
  );

  // --- appConnection:providers ---
  ipcMain.handle(
    'appConnection:providers',
    async (): Promise<AppConnectionProviderListResponse> => {
      try {
        return { success: true, data: getReadyAppConnectionService().listProviders() };
      } catch (err) {
        logger.error(
          'appConnection:providers failed',
          err instanceof Error ? err : new Error(String(err)),
          undefined,
          COMPONENT,
        );
        return { success: false, error: 'Failed to list app connection providers' };
      }
    },
  );

  // --- appConnection:status ---
  ipcMain.handle(
    'appConnection:status',
    async (_event, connectionId: string): Promise<AppConnectionSingleResponse> => {
      if (typeof connectionId !== 'string' || !connectionId) {
        return { success: false, error: 'connectionId is required' };
      }
      try {
        const dto = getReadyAppConnectionService().getStatus(connectionId);
        return dto ? { success: true, data: dto } : { success: false, error: 'Connection not found', errorCode: 'connection_not_found' };
      } catch (err) {
        logger.error(
          'appConnection:status failed',
          err instanceof Error ? err : new Error(String(err)),
          { connectionId },
          COMPONENT,
        );
        return { success: false, error: 'Failed to get connection status' };
      }
    },
  );

  // --- appConnection:connect ---
  ipcMain.handle(
    'appConnection:connect',
    async (
      _event,
      payload: { provider: ProviderId; scopes?: string[] },
    ): Promise<AppConnectionProviderResponse> => {
      if (!payload || typeof payload.provider !== 'string') {
        return { success: false, error: 'provider is required' };
      }
      if (!isKnownProvider(payload.provider)) {
        return { success: false, error: `Unsupported provider: ${payload.provider}`, errorCode: 'unsupported_provider' };
      }
      const provider = payload.provider;
      try {
        const dto = await getReadyAppConnectionService().connect(provider, payload.scopes);
        return { success: true, data: dto };
      } catch (err) {
        const errorCode = getErrorCode(err);
        const message = err instanceof Error ? err.message : String(err);
        logger.warn(
          'appConnection:connect failed',
          err instanceof Error ? err : new Error(String(err)),
          { provider, code: errorCode },
          COMPONENT,
        );
        return {
          success: false,
          error: message,
          errorCode,
        };
      }
    },
  );

  // --- appConnection:configureProvider ---
  ipcMain.handle(
    'appConnection:configureProvider',
    async (
      _event,
      payload: { provider: ProviderId; clientId: string; clientSecret?: string },
    ): Promise<AppConnectionSingleResponse> => {
      if (!payload || typeof payload.provider !== 'string' || typeof payload.clientId !== 'string') {
        return { success: false, error: 'provider and clientId are required' };
      }
      if (!isKnownProvider(payload.provider)) {
        return { success: false, error: `Unsupported provider: ${payload.provider}`, errorCode: 'unsupported_provider' };
      }
      const provider = payload.provider;
      if (payload.clientId.length > 2048 || (payload.clientSecret?.length ?? 0) > 4096) {
        return { success: false, error: 'OAuth client configuration exceeds the allowed length' };
      }
      try {
        const providerState = getReadyAppConnectionService().configureProvider(provider, {
          clientId: payload.clientId,
          clientSecret: payload.clientSecret,
        });
        if (!providerState.configured) {
          return {
            success: false,
            error: providerState.configurationHint ?? 'OAuth provider is not configured',
            errorCode: 'provider_not_configured',
          };
        }
        return { success: true, data: providerState };
      } catch (err) {
        return {
          success: false,
          error: err instanceof Error ? err.message : String(err),
          errorCode: getErrorCode(err),
        };
      }
    },
  );

  // --- appConnection:disconnect ---
  ipcMain.handle(
    'appConnection:disconnect',
    async (_event, connectionId: string): Promise<{ success: boolean; data?: { disconnected: boolean }; error?: string }> => {
      if (typeof connectionId !== 'string' || !connectionId) {
        return { success: false, error: 'connectionId is required' };
      }
      try {
        const disconnected = await getReadyAppConnectionService().disconnect(connectionId);
        return { success: true, data: { disconnected } };
      } catch (err) {
        logger.error(
          'appConnection:disconnect failed',
          err instanceof Error ? err : new Error(String(err)),
          { connectionId },
          COMPONENT,
        );
        return { success: false, error: 'Failed to disconnect' };
      }
    },
  );
}
