import * as http from 'http';
import { SessionManager } from './session-store';
import { WorkerManager } from './worker-manager';
import { CheckpointBatcher } from './checkpoint-batcher';
import { ConductorService } from './conductor-service';
import { logger, httpLogger, sessionLogger } from './logger';
import { createHandleRequest, RouterDeps } from './router';

const PORT = 0;
const HOST = '127.0.0.1';

const sessionManager = new SessionManager();
const workerManager = new WorkerManager(sessionManager);
const checkpointBatcher = new CheckpointBatcher(sessionManager);

checkpointBatcher.setFlushHandler((batch) => {
  for (const cp of batch) {
    logger.info('Batched checkpoint flushed', { sessionId: cp.sessionId, batchSize: batch.length });
  }
});
checkpointBatcher.start();

workerManager.setCrashHandler((sessionId) => {
  logger.error('Worker crash handler invoked', undefined, { sessionId });
  checkpointBatcher.flush();
});

const pendingDbRequests = new Map<string, {
  resolve: (value: unknown) => void;
  reject: (reason: unknown) => void;
  timer: ReturnType<typeof setTimeout>;
}>();

const workerDbRequests = new Map<string, import('child_process').ChildProcess>();

process.on('message', (msg: Record<string, unknown>) => {
  if (msg.type === 'db:response' && typeof msg.id === 'string') {
    const workerChild = workerDbRequests.get(msg.id);
    if (workerChild && !workerChild.killed) {
      workerDbRequests.delete(msg.id);
      workerChild.send(msg);
      return;
    }

    const pending = pendingDbRequests.get(msg.id);
    if (pending) {
      clearTimeout(pending.timer);
      pendingDbRequests.delete(msg.id);
      if (msg.success) {
        logger.debug('DB response received', { requestId: msg.id, success: true });
        pending.resolve(msg.result);
      } else {
        logger.warn('DB response error', { requestId: msg.id, error: msg.error });
        pending.reject(new Error(typeof msg.error === 'string' ? msg.error : 'DB request failed'));
      }
    }
  }
});

function dbRequest(action: string, payload: Record<string, unknown>): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const id = `db-${Date.now()}-${Math.random().toString(36).substring(2, 8)}`;
    const timer = setTimeout(() => {
      pendingDbRequests.delete(id);
      logger.warn('DB request timeout', { requestId: id, action });
      reject(new Error(`DB request timeout: ${action}`));
    }, 30000);

    pendingDbRequests.set(id, { resolve, reject, timer });

    if (process.send) {
      process.send({ type: 'db:request', id, action, payload });
    } else {
      clearTimeout(timer);
      pendingDbRequests.delete(id);
      reject(new Error('process.send not available — not running as child_process'));
    }
  });
}

const conductorService = new ConductorService(workerManager, dbRequest);

let isShuttingDown = false;
const activeConnections = new Set<http.ServerResponse>();

const deps: RouterDeps = {
  sessionManager,
  workerManager,
  checkpointBatcher,
  conductorService,
  logger,
  httpLogger,
  sessionLogger,
  dbRequest,
};

const handleRequest = createHandleRequest(deps, workerDbRequests, activeConnections, () => isShuttingDown);

const server = http.createServer(handleRequest);

server.listen(PORT, HOST, () => {
  const addr = server.address();
  if (addr && typeof addr === 'object') {
    const actualPort = addr.port;
    process.stdout.write(JSON.stringify({ port: actualPort }) + '\n');
  }
});

function gracefulShutdown(): void {
  if (isShuttingDown) return;
  isShuttingDown = true;

  logger.info('Starting graceful shutdown', { sessionCount: sessionManager.getSessionCount(), workerCount: workerManager.workerCount });

  checkpointBatcher.stop();
  conductorService.destroyAll();
  workerManager.killAll();

  server.close(() => {
    logger.info('HTTP server closed, exiting');
    process.exit(0);
  });

  setTimeout(() => {
    logger.warn('Graceful shutdown timeout, force exiting');
    process.exit(0);
  }, 5000).unref();
}

process.on('SIGTERM', gracefulShutdown);
process.on('SIGINT', gracefulShutdown);

process.on('uncaughtException', (error) => {
  logger.error('Uncaught exception', error, {});
  process.exit(1);
});

process.on('unhandledRejection', (reason) => {
  logger.error('Unhandled rejection', reason instanceof Error ? reason : new Error(String(reason)), {});
});