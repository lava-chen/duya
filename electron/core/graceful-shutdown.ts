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
import { stopWalCheckpoint } from '../db/connection';
import { cleanupUpdater } from '../services/updater';
import { shutdownProjectDatabaseService } from '../project-database/service';

let isShuttingDown = false;

export function getIsShuttingDown(): boolean {
  return isShuttingDown;
}

export async function performGracefulShutdown(): Promise<void> {
  if (isShuttingDown) return;
  isShuttingDown = true;

  const logger = getLogger();
  logger.info('Starting graceful shutdown...', undefined, 'Main');

  // 0. Stop CLI API server (Phase 0) — runs first so we don't accept new
  // requests after other subsystems begin tearing down.
  try {
    const { stopCliApiServer } = await import('../cli/cli-api-server');
    await stopCliApiServer();
    logger.info('CLI API server stopped', undefined, 'Main');
  } catch (err) {
    logger.error(
      'Error stopping CLI API server',
      err instanceof Error ? err : new Error(String(err)),
      undefined,
      LogComponent.Main,
    );
  }

  // 0.5 Stop Agent Server
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
  } catch (err) {
    logger.error('Error stopping Browser Daemon', err instanceof Error ? err : new Error(String(err)), undefined, LogComponent.Main);
  }

  // 6.5 Stop automation scheduler
  try {
    getAutomationScheduler()?.shutdown();
  } catch (err) {
    logger.error('Error shutting down automation scheduler', err instanceof Error ? err : new Error(String(err)), undefined, LogComponent.Main);
  }

  // 6.55 Stop document parser
  try {
    const docParser = getDocumentParser();
    if (docParser) {
      await docParser.stop();
    }
  } catch (err) {
    logger.error('Error stopping document parser', err instanceof Error ? err : new Error(String(err)), undefined, LogComponent.Main);
  }

  // 6.6 Cleanup updater
  try {
    cleanupUpdater();
  } catch (err) {
    logger.error('Error cleaning up updater', err instanceof Error ? err : new Error(String(err)), undefined, LogComponent.Main);
  }

  // 7. Shutdown config manager
  try {
    getConfigManager().shutdown();
  } catch (err) {
    logger.error('Error shutting down config manager', err instanceof Error ? err : new Error(String(err)), undefined, LogComponent.Main);
  }

  // 7.5 Stop WAL checkpoint scheduler
  try {
    stopWalCheckpoint();
  } catch (err) {
    logger.error('Error stopping WAL checkpoint scheduler', err instanceof Error ? err : new Error(String(err)), undefined, LogComponent.Main);
  }

  // 7.6 Checkpoint and close project-local database connections.
  try {
    await shutdownProjectDatabaseService();
  } catch (err) {
    logger.error('Error shutting down project database service', err instanceof Error ? err : new Error(String(err)), undefined, LogComponent.DB);
  }

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
