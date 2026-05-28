import { app } from 'electron';
import * as path from 'path';
import * as os from 'os';
import { initLogger, getLogger, LogComponent } from '../logging/logger';

const logger = initLogger({ level: 'WARN' });

export const isDev = !app.isPackaged;
export const isPreviewMode = process.env.DUYA_PREVIEW_MODE === 'true';
export const DEBUG_IPC = process.env.DUYA_DEBUG_IPC === 'true';

export function debugLog(...args: unknown[]): void {
  if (DEBUG_IPC) {
    logger.debug(args.join(' '), { source: 'Main' });
  }
}

// =============================================================================
// Environment Diagnostic — logs key paths and mode at startup
// =============================================================================

export function logEnvironmentDiagnostic(): void {
  const resPath = app.isPackaged ? process.resourcesPath : process.cwd();
  const userDataPath = app.getPath('userData');
  const exePath = process.execPath;

  const log = getLogger();
  log.info('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━', undefined, LogComponent.Main);
  log.info('DUYA Environment Diagnostic', undefined, LogComponent.Main);
  log.info('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━', undefined, LogComponent.Main);
  log.info(`  Mode:         ${app.isPackaged ? 'PACKAGED' : isPreviewMode ? 'PREVIEW' : 'DEVELOPMENT'}`, undefined, LogComponent.Main);
  log.info(`  Platform:     ${process.platform} ${os.arch()}`, undefined, LogComponent.Main);
  log.info(`  Electron:     ${process.versions.electron}`, undefined, LogComponent.Main);
  log.info(`  Node:         ${process.versions.node}`, undefined, LogComponent.Main);
  log.info(`  ExecPath:     ${exePath}`, undefined, LogComponent.Main);
  log.info(`  Resources:    ${resPath}`, undefined, LogComponent.Main);
  log.info(`  UserData:     ${userDataPath}`, undefined, LogComponent.Main);
  log.info(`  CWD:          ${process.cwd()}`, undefined, LogComponent.Main);
  log.info(`  ENV VITE:     VITE_DEV_SERVER_URL=${process.env.VITE_DEV_SERVER_URL || 'unset'}`, undefined, LogComponent.Main);
  log.info(`  ENV LOG_LEVEL: ${process.env.LOG_LEVEL || 'unset'}`, undefined, LogComponent.Main);
  log.info('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━', undefined, LogComponent.Main);
}

// =============================================================================
// Development Mode: Use isolated userData directory
// =============================================================================

export function setupDevMode(): void {
  if (isDev && !isPreviewMode) {
    const originalUserData = app.getPath('userData');
    const devUserData = path.join(originalUserData, 'duya-dev');
    app.setPath('userData', devUserData);
    getLogger().info(`Dev mode: using isolated userData at ${devUserData}`, undefined, LogComponent.Main);
  }
}

// =============================================================================
// Global Error Handlers
// =============================================================================

export function initGlobalErrorHandlers(): void {
  process.on('uncaughtException', (error) => {
    logger.error('Uncaught Exception', error, undefined, LogComponent.Main);
  });

  process.on('unhandledRejection', (reason) => {
    logger.error('Unhandled Rejection', reason instanceof Error ? reason : new Error(String(reason)), undefined, LogComponent.Main);
  });
}

// =============================================================================
// Step 0: Single Instance Lock
// =============================================================================

export function acquireSingleInstanceLock(): boolean {
  const gotTheLock = app.requestSingleInstanceLock();
  if (!gotTheLock) {
    app.quit();
    return false;
  }
  return true;
}

export function setupSecondInstanceHandler(onSecondInstance: () => void): void {
  app.on('second-instance', onSecondInstance);
}
