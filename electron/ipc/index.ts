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
import { registerDuyaLinkHandlers } from './duya-link-handlers';
import { registerAgentServerHandlers } from './agent-server-handlers';
import { registerRecapHandlers } from './recap-handlers';
import { registerPluginHandlers } from './plugin-handlers';
import { registerProjectDatabaseHandlers } from './project-database-handlers';
import { registerGitHandlers } from './git-handlers';
import { registerMemoryWakeupHandlers } from './memory-wakeup';
import {
  registerMemoryListHandlers,
  registerMemorySystemLogHandlers,
  registerMemoryRagRebuildHandler,
} from './memory-handlers';
import { registerHooksHandlers } from './hooks-handlers';
import { registerMcpReloadIpcHandler } from './mcp-handlers';
import { registerComputerUseHandlers } from './computer-use';
import {
  registerSidebarSectionsHandlers,
} from './db-handlers';

export {
  registerSystemHandlers,
  registerSettingsHandlers,
  registerSkillsHandlers,
  registerFilesHandlers,
  registerLoggerHandlers,
  registerUpdaterHandlers,
  registerDbHandlers,
  registerConductorHandlers,
  registerSidebarSectionsHandlers,
  registerMailboxHandlers,
  registerAgentHandlers,
  registerNetHandlers,
  registerDuyaLinkHandlers,
  registerAgentServerHandlers,
  registerRecapHandlers,
  registerPluginHandlers,
  registerProjectDatabaseHandlers,
  registerGitHandlers,
  registerMemoryWakeupHandlers,
  registerMemoryListHandlers,
  registerMemorySystemLogHandlers,
  registerMemoryRagRebuildHandler,
  registerHooksHandlers,
  registerMcpReloadIpcHandler,
  registerComputerUseHandlers,
};
