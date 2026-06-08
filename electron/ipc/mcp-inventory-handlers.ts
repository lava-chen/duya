import { ipcMain } from 'electron';

import { getLogger, LogComponent } from '../logging/logger';
import { getMCPInventoryService } from '../services/mcp-inventory-service';

export function registerMCPInventoryHandlers(): void {
  const logger = getLogger();
  const service = getMCPInventoryService();

  ipcMain.handle('mcp:inventory:snapshot', async () => {
    try {
      const snapshot = await service.buildSnapshot();
      return { success: true, data: snapshot };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error(
        LogComponent.Main,
        `mcp:inventory:snapshot failed: ${message}`,
      );
      return { success: false, error: message };
    }
  });
}
