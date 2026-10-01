import { ipcMain } from 'electron';
import { getLogger, LogComponent } from '../logging/logger';
import { requestNextSteps } from '../services/next-step/next-step-service';

const logger = getLogger();

export function registerNextStepHandlers(): void {
  ipcMain.handle('nextSteps:request', async (_event, sessionId: string) => {
    try {
      if (typeof sessionId !== 'string' || !sessionId) {
        return { success: false, suggestions: [], error: 'Invalid session id' };
      }
      const suggestions = await requestNextSteps(sessionId);
      return { success: true, suggestions };
    } catch (error) {
      logger.warn(
        'Next-step suggestion request failed',
        { error: error instanceof Error ? error.message : String(error) },
        LogComponent.Main,
      );
      return { success: false, suggestions: [], error: 'Suggestion generation failed' };
    }
  });
}
