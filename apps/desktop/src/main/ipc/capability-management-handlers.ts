/**
 * capability-management-handlers.ts
 *
 * Plan 83b Phase 1A — IPC handler exposing the read-only
 * capability-management snapshot to the renderer.
 *
 * Single channel: `capability-management:snapshot` → CapabilityManagementSnapshot
 *
 * No mutation. No SSE. No `lastMCPLoadResult`. No `evaluateMcpToolPermission`.
 */

import { ipcMain } from 'electron';

import { getLogger, LogComponent } from '../logging/logger';
import { getCapabilityManagementService } from '../services/capability-management';
import type { IpcRegistrar } from './lazy-ipc-registry';

export function registerCapabilityManagementHandlers(
  register: IpcRegistrar = (channel, handler) => ipcMain.handle(channel, handler),
): void {
  const logger = getLogger();
  const service = getCapabilityManagementService();

  register('capability-management:snapshot', async () => {
    try {
      const snapshot = await service.buildSnapshot();
      return { success: true, data: snapshot };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error(
        `capability-management:snapshot failed: ${message}`,
        error instanceof Error ? error : new Error(message),
        undefined,
        LogComponent.Main,
      );
      return { success: false, error: message };
    }
  });
}
