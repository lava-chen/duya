import { ipcMain } from 'electron';
import type { RecapService } from '../services/recap/recap-service';
import { getLogger, LogComponent } from '../logging/logger';

const logger = getLogger();

export function registerRecapHandlers(recapService: RecapService): void {
  ipcMain.handle('recap:request', async (_event, sessionId: string) => {
    try {
      const recap = await recapService.requestManualRecap(sessionId);
      return { success: true, recap };
    } catch (error) {
      logger.warn(
        'Manual recap request failed',
        { error: error instanceof Error ? error.message : String(error) },
        LogComponent.Main,
      );
      return { success: false, error: 'Recap generation failed' };
    }
  });

  ipcMain.handle('recap:setActiveSession', (_event, sessionId: string) => {
    recapService.setActiveSession(sessionId);
  });

  ipcMain.handle('recap:getSettings', () => {
    return {
      enabled: recapService.isEnabled(),
      inactivityThreshold: recapService.getInactivityThreshold(),
    };
  });

  ipcMain.handle('recap:setSettings', (_event, settings: { enabled?: boolean; inactivityThreshold?: number }) => {
    if (typeof settings.enabled === 'boolean') {
      recapService.setEnabled(settings.enabled);
    }
    if (typeof settings.inactivityThreshold === 'number') {
      recapService.setInactivityThreshold(settings.inactivityThreshold);
    }
  });
}