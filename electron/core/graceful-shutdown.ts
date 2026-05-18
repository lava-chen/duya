import { app, BrowserWindow } from 'electron';
import { getLogger, LogComponent } from '../logging/logger';
import { stopAgentServer } from '../agents/agent-server-lifecycle';
import { getAgentProcessPool } from '../agents/process-pool/agent-process-pool';
import { getChannelManager } from '../messaging/port-manager';
import { getPerformanceMonitor } from '../services/performance-monitor';
import { stopGatewayProcess } from '../gateway/index';
import { getSessionManager } from '../agents/session-manager';
import { stopBrowserDaemon } from '../services/browser/daemon';
import { getAutomationScheduler } from '../automation/Scheduler';
import { getDocumentParser } from '../services/document-parser/index';
import { getConfigManager } from '../config/manager';
import { getDatabase } from '../ipc/db-handlers';
import { cleanupUpdater } from '../services/updater';

let isShuttingDown = false;

export function getIsShuttingDown(): boolean {
  return isShuttingDown;
}

export async function performGracefulShutdown(): Promise<void> {
  if (isShuttingDown) return;
  isShuttingDown = true;

  const logger = getLogger();
  logger.info('Starting graceful shutdown...', undefined, 'Main');

  // 0. Stop Agent Server
  try {
    await stopAgentServer();
  } catch (err) {
    logger.error('Error stopping agent server', err instanceof Error ? err : new Error(String(err)), undefined, LogComponent.Main);
  }

  // 1. Stop all Agent processes
  try {
    const agentPool = getAgentProcessPool();
    await agentPool.shutdown();
  } catch (err) {
    logger.error('Error shutting down agent pool', err instanceof Error ? err : new Error(String(err)), undefined, LogComponent.Main);
  }

  // 2. Shutdown channel manager
  try {
    const channelMgr = getChannelManager();
    channelMgr.shutdown();
  } catch (err) {
    logger.error('Error shutting down channel manager', err instanceof Error ? err : new Error(String(err)), undefined, LogComponent.Main);
  }

  // 3. Stop performance monitor
  try {
    getPerformanceMonitor().shutdown();
  } catch (err) {
    logger.error('Error shutting down performance monitor', err instanceof Error ? err : new Error(String(err)), undefined, LogComponent.Main);
  }

  // 4. Stop gateway process
  try {
    await stopGatewayProcess();
  } catch (err) {
    logger.error('Error stopping gateway process', err instanceof Error ? err : new Error(String(err)), undefined, LogComponent.Main);
  }

  // 5. Shutdown session manager
  try {
    getSessionManager().shutdown();
  } catch (err) {
    logger.error('Error shutting down session manager', err instanceof Error ? err : new Error(String(err)), undefined, LogComponent.Main);
  }

  // 6. Stop Browser Daemon
  try {
    await stopBrowserDaemon();
    logger.info('Browser Daemon stopped', undefined, 'Main');
  } catch {}

  // 6.5 Stop automation scheduler
  try {
    getAutomationScheduler()?.shutdown();
  } catch {}

  // 6.55 Stop document parser
  try {
    const docParser = getDocumentParser();
    if (docParser) {
      await docParser.stop();
    }
  } catch {}

  // 6.6 Cleanup updater
  try {
    cleanupUpdater();
  } catch {}

  // 7. Shutdown config manager
  try {
    getConfigManager().shutdown();
  } catch {}

  // 8. Close database connection (last step)
  try {
    const database = getDatabase();
    if (database) {
      database.close();
      logger.info('Database connection closed', undefined, 'Main');
    }
  } catch (error) {
    logger.error('Failed to close database', error instanceof Error ? error : new Error(String(error)), undefined, 'Main');
  }

  logger.info('Graceful shutdown complete', undefined, 'Main');
}

export function setupShutdownHandlers(): void {
  const logger = getLogger();

  app.on('window-all-closed', async () => {
    if (getIsShuttingDown()) return;

    const SHUTDOWN_TIMEOUT_MS = 10000;
    const shutdownPromise = performGracefulShutdown();

    const forceQuitTimeout = setTimeout(() => {
      logger.warn('window-all-closed shutdown timeout exceeded, forcing quit', undefined, 'Main');
      app.exit(0);
    }, SHUTDOWN_TIMEOUT_MS);

    try {
      await shutdownPromise;
      clearTimeout(forceQuitTimeout);
    } catch (err) {
      logger.error('Graceful shutdown failed in window-all-closed', err instanceof Error ? err : new Error(String(err)), undefined, 'Main');
      clearTimeout(forceQuitTimeout);
      app.exit(1);
    }

    if (process.platform !== 'darwin') {
      app.quit();
    }
  });

  app.on('before-quit', (event) => {
    if (!isShuttingDown) {
      event.preventDefault();
      const SHUTDOWN_TIMEOUT_MS = 10000;
      const shutdownPromise = performGracefulShutdown();

      const forceQuitTimeout = setTimeout(() => {
        logger.warn('Global shutdown timeout exceeded, forcing quit', undefined, 'Main');
        app.exit(0);
      }, SHUTDOWN_TIMEOUT_MS);

      shutdownPromise.then(() => {
        clearTimeout(forceQuitTimeout);
        app.quit();
      }).catch((err) => {
        logger.error('Graceful shutdown failed', err instanceof Error ? err : new Error(String(err)), undefined, 'Main');
        clearTimeout(forceQuitTimeout);
        app.exit(1);
      });
    }
  });
}
