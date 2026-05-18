import { app } from 'electron';
import * as path from 'path';
import { initLogger, LogComponent } from '../logging/logger';

const logger = initLogger({ level: 'WARN' });

export const isDev = !app.isPackaged;
export const DEBUG_IPC = process.env.DUYA_DEBUG_IPC === 'true';

export function debugLog(...args: unknown[]): void {
  if (DEBUG_IPC) {
    logger.debug(args.join(' '), { source: 'Main' });
  }
}

// =============================================================================
// Development Mode: Use isolated userData directory
// =============================================================================

export function setupDevMode(): void {
  if (isDev) {
    const originalUserData = app.getPath('userData');
    const devUserData = path.join(originalUserData, 'duya-dev');
    app.setPath('userData', devUserData);
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
