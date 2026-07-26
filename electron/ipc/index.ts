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
import { registerDbHandlers, registerConductorHandlers, registerMailboxHandlers } from './db-handlers';
import { registerAgentHandlers } from '../agents/agent-communicator';
import { registerNetHandlers } from './net-handlers';
import { registerAgentServerHandlers } from './agent-server-handlers';
import { registerRecapHandlers } from './recap-handlers';
import { registerWikiAgentHandlers } from './wiki-agent-handlers';
import { registerPluginHandlers } from './plugin-handlers';
import { registerProjectDatabaseHandlers } from './project-database-handlers';
import { registerGitHandlers } from './git-handlers';
import { registerMemoryWakeupHandlers } from './memory-wakeup';

export {
  registerSystemHandlers,
  registerSettingsHandlers,
  registerSkillsHandlers,
  registerFilesHandlers,
  registerLoggerHandlers,
  registerUpdaterHandlers,
  registerDbHandlers,
  registerConductorHandlers,
  registerMailboxHandlers,
  registerAgentHandlers,
  registerNetHandlers,
  registerAgentServerHandlers,
  registerRecapHandlers,
  registerWikiAgentHandlers,
  registerPluginHandlers,
  registerProjectDatabaseHandlers,
  registerGitHandlers,
  registerMemoryWakeupHandlers,
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
  registerMailboxHandlers();
  registerAgentHandlers();
  registerNetHandlers();
  registerAgentServerHandlers();
  registerPluginHandlers();
  registerProjectDatabaseHandlers();
  registerGitHandlers();
  registerMemoryWakeupHandlers();
}
