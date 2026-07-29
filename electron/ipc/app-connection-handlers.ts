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
import { getLogger, LogComponent } from '../logging/logger';
import {
  getAppConnectionService,
} from '../services/app-connections/app-connection-service';
import { FlowError } from '../services/app-connections/oauth/flow';
import type {
  AppConnectionStatusDTO,
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

export interface AppConnectionSingleResponse {
  success: boolean;
  data?: AppConnectionStatusDTO;
  error?: string;
  /** Structured error code for the renderer to map to UX. */
  errorCode?: string;
}

export function registerAppConnectionHandlers(): void {
  const logger = getLogger();
  const service = getAppConnectionService();
  service.setReloadHook(notifyAgentServerAppConnectionReload);

  // --- appConnection:list ---
  ipcMain.handle(
    'appConnection:list',
    async (): Promise<AppConnectionListResponse> => {
      try {
        const list = service.list();
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

  // --- appConnection:status ---
  ipcMain.handle(
    'appConnection:status',
    async (_event, connectionId: string): Promise<AppConnectionSingleResponse> => {
      if (typeof connectionId !== 'string' || !connectionId) {
        return { success: false, error: 'connectionId is required' };
      }
      try {
        const dto = service.getStatus(connectionId);
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
    ): Promise<AppConnectionSingleResponse> => {
      if (!payload || typeof payload.provider !== 'string') {
        return { success: false, error: 'provider is required' };
      }
      const provider = payload.provider as ProviderId;
      if (provider !== 'google' && provider !== 'slack' && provider !== 'microsoft365') {
        return { success: false, error: `Unsupported provider: ${provider}`, errorCode: 'unsupported_provider' };
      }
      try {
        const dto = await service.connect(provider, payload.scopes);
        return { success: true, data: dto };
      } catch (err) {
        const errorCode = err instanceof FlowError ? err.code : 'internal';
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

  // --- appConnection:disconnect ---
  ipcMain.handle(
    'appConnection:disconnect',
    async (_event, connectionId: string): Promise<{ success: boolean; data?: { disconnected: boolean }; error?: string }> => {
      if (typeof connectionId !== 'string' || !connectionId) {
        return { success: false, error: 'connectionId is required' };
      }
      try {
        const disconnected = await service.disconnect(connectionId);
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
