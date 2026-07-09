import * as http from 'http';
import { SessionManager } from './session-store';
import { WorkerManager } from './worker-manager';
import { CheckpointBatcher } from './checkpoint-batcher';
// @deprecated (plan 221 Phase 7) ConductorService is retained for legacy
// HTTP/SSE routes but no longer the primary execution path.
import { ConductorService } from './conductor-service';
import { logger, httpLogger, sessionLogger, workerLogger } from './logger';
import { createHandleRequest, RouterDeps } from './router';
import { InteragentRouter } from './interagent-router';

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
    if (workerChild) {
      // H5: Always delete the entry, even if the worker has exited
      workerDbRequests.delete(msg.id);
      if (!workerChild.killed) {
        workerChild.send(msg);
      }
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
    return;
  }

  if (msg.type === 'conductor:executor:rpc:response' && typeof msg.requestId === 'string') {
    const key = `rpc:${msg.requestId}`;
    const workerChild = workerDbRequests.get(key);
    if (workerChild) {
      // H5: Always delete the entry, even if the worker has exited
      workerDbRequests.delete(key);
      if (!workerChild.killed) {
        workerChild.send(msg);
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

// @deprecated (plan 221 Phase 7) ConductorService is retained for legacy
// HTTP/SSE routes but no longer the primary execution path. The main chat
// agent now drives conductor mode via injection.
const conductorService = new ConductorService(workerManager, dbRequest);

const interagentRouter = new InteragentRouter({
  workerManager,
  sessionManager,
  dbRequest,
  workerDbRequests,
});

workerManager.setMessageHandler((sessionId, msg) => {
  if (msg.type === 'interagent:invoke') {
    // Fire and forget — errors are handled internally and sent as chat:error
    void interagentRouter.handleInvoke({
      id: msg.id as string,
      callerSessionId: msg.callerSessionId as string,
      callerAgentName: msg.callerAgentName as string,
      targetSessionId: msg.targetSessionId as string,
      message: msg.message as string,
      mode: msg.mode as 'minimal' | 'full',
      timeout: msg.timeout as number,
    }).catch((err) => {
      workerLogger.error('Interagent invoke failed', err instanceof Error ? err : new Error(String(err)), { invokeId: msg.id as string });
      // Send synthetic error to caller
      workerManager.sendCommand(msg.callerSessionId as string, {
        type: 'interagent:event',
        id: msg.id as string,
        event: {
          type: 'chat:error',
          sessionId: msg.targetSessionId as string,
          message: `interagent invoke failed: ${err instanceof Error ? err.message : String(err)}`,
          code: 'invoke_failed',
        },
      });
    });
  }
});

let isShuttingDown = false;
const activeConnections = new Set<http.ServerResponse>();

/**
 * Hydrate SessionManager with placeholder entries for every existing chat session
 * in the DB. This prevents "Session not found" 404s for endpoints that look up
 * sessions by id (status, compact, permission, …) when the Agent Server has
 * just started and has no in-memory record of historical sessions.
 *
 * Placeholders are created as IDLE (no worker). Endpoints that require a live
 * worker (chat, compact-without-pre-warmup) will still fail with a specific
 * error if `workerManager.hasWorker(id)` is false.
 */
async function hydrateSessionsFromDb(): Promise<void> {
  try {
    const rows = (await dbRequest('session:list', {})) as Array<{ id: string }> | undefined;
    if (!Array.isArray(rows)) {
      logger.warn('hydrateSessionsFromDb: session:list returned non-array', { type: typeof rows });
      return;
    }
    let created = 0;
    for (const row of rows) {
      if (!row?.id) continue;
      if (sessionManager.getSession(row.id)) continue;
      try {
        sessionManager.createSession(row.id);
        created++;
      } catch (err) {
        // createSession throws on duplicate id; safe to ignore here.
        const msg = err instanceof Error ? err.message : String(err);
        if (!msg.includes('already exists')) {
          logger.warn('hydrateSessionsFromDb: createSession failed', { sessionId: row.id, error: msg });
        }
      }
    }
    logger.info('Session hydration complete', { total: rows.length, created, preExisting: rows.length - created });
  } catch (err) {
    logger.warn('Session hydration failed', err instanceof Error ? err : new Error(String(err)));
  }
}

// Run hydration in the background so the server can start listening immediately.
// Endpoints tolerate a session not being pre-loaded: handlePostChat already
// autocreates, and the no-worker guard still produces a specific 404.
void hydrateSessionsFromDb();

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