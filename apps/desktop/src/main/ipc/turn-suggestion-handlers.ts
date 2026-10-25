import { ipcMain } from 'electron';
import { getLogger, LogComponent } from '../logging/logger';
import { getDesktopHostLocalTurnSuggestionApi } from '../cli/desktop-host-api';

const logger = getLogger();

/**
 * Read the end-of-turn suggestion the worker predicted for a session.
 *
 * The prediction itself happens in the worker, on the model's own client; this
 * handler only reads the row back, so the Desktop, the Web and the TUI all
 * show the same suggestion.
 */
export function registerTurnSuggestionHandlers(): void {
  ipcMain.handle('turnSuggestions:latest', async (_event, sessionId: string) => {
    try {
      if (typeof sessionId !== 'string' || !sessionId) {
        return { success: false, suggestion: null, error: 'Invalid session id' };
      }
      const api = getTurnSuggestionApiOrNull();
      if (!api) {
        return { success: false, suggestion: null, error: 'Turn suggestions are unavailable' };
      }
      const suggestion = await api.getLatestTurnSuggestion(sessionId);
      return { success: true, suggestion };
    } catch (error) {
      logger.warn(
        'Turn suggestion request failed',
        { error: error instanceof Error ? error.message : String(error) },
        LogComponent.Main,
      );
      return { success: false, suggestion: null, error: 'Suggestion read failed' };
    }
  });
}

function getTurnSuggestionApiOrNull() {
  try {
    return getDesktopHostLocalTurnSuggestionApi();
  } catch {
    return null;
  }
}
