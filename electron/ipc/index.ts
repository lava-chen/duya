/**
 * ipc/index.ts - IPC handler registration exports
 *
 * Central export for all IPC handlers.
 */

import { registerSystemHandlers } from './system-handlers';
import { registerSettingsHandlers } from './settings-handlers';
import { registerSkillsHandlers } from './skills-handlers';
import { registerFilesHandlers } from './files-handlers';
import { registerLoggerHandlers } from './logger-handlers';
import { registerUpdaterHandlers } from './updater-handlers';
import { registerDbHandlers, registerConductorHandlers } from './db-handlers';
import { registerAgentHandlers } from '../agents/agent-communicator';
import { registerNetHandlers } from './net-handlers';
import { registerAgentServerHandlers } from './agent-server-handlers';

export {
  registerSystemHandlers,
  registerSettingsHandlers,
  registerSkillsHandlers,
  registerFilesHandlers,
  registerLoggerHandlers,
  registerUpdaterHandlers,
  registerDbHandlers,
  registerConductorHandlers,
  registerAgentHandlers,
  registerNetHandlers,
  registerAgentServerHandlers,
};

/**
 * Register all IPC handlers
 */
export function registerAllIpcHandlers(): void {
  registerSystemHandlers();
  registerSettingsHandlers();
  registerSkillsHandlers();
  registerFilesHandlers();
  registerLoggerHandlers();
  registerUpdaterHandlers();
  registerDbHandlers();
  registerConductorHandlers();
  registerAgentHandlers();
  registerNetHandlers();
}