import { BrowserWindow, ipcMain } from 'electron';
import { ProjectDatabaseRequestSchema, type ProjectDatabaseChangeEvent } from '../../packages/conductor/src/database/types';
import { getLogger, LogComponent } from '../logging/logger';
import { getProjectDatabaseService, ProjectDatabaseServiceError } from '../project-database/service';

let registered = false;

export function registerProjectDatabaseHandlers(): void {
  if (registered) return;
  registered = true;
  const service = getProjectDatabaseService();
  service.on('change', (event: ProjectDatabaseChangeEvent) => {
    for (const window of BrowserWindow.getAllWindows()) {
      if (!window.isDestroyed()) window.webContents.send('project-database:changed', event);
    }
  });

  ipcMain.handle('project-database:invoke', async (_event, rawRequest: unknown) => {
    const request = ProjectDatabaseRequestSchema.parse(rawRequest);
    try {
      return await service.invoke(request);
    } catch (error) {
      if (error instanceof ProjectDatabaseServiceError) {
        return { success: false, error: error.message, code: error.code, details: error.details };
      }
      getLogger().error(
        'Project database request failed',
        error instanceof Error ? error : new Error(String(error)),
        undefined,
        LogComponent.DB,
      );
      throw error;
    }
  });
}
