/**
 * ipc/agent-server-handlers.ts - Agent Server IPC handlers
 *
 * Exposes Agent Server connection info to Renderer via IPC.
 */

import { ipcMain } from 'electron';
import { getLogger, LogComponent } from '../logging/logger';
import { getAgentServerPort } from '../agents/agent-server-lifecycle';

export function registerAgentServerHandlers(): void {
  const logger = getLogger();

  ipcMain.handle('agent-server:getPort', () => {
    return getAgentServerPort();
  });

  ipcMain.handle('agent-server:getUrl', () => {
    const port = getAgentServerPort();
    if (!port) {
      return null;
    }
    return `http://127.0.0.1:${port}`;
  });

  logger.info('Agent Server IPC handlers registered', { port: getAgentServerPort() }, LogComponent.Main);
}