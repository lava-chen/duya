import * as fs from 'fs';
import * as path from 'path';
import {
  WorkerManager as HostWorkerManager,
  type WorkerManagerLogger,
} from '@duya/host/worker-manager';
import { SessionManager } from './session-store';
import { SessionState } from './types';
import { workerLogger } from './logger';

export { createWorkerEnvironment } from '@duya/host/worker-limits';
export type { WorkerInterrupt } from '@duya/host/worker-manager';

const hostLogger: WorkerManagerLogger = workerLogger;

export function resolveDesktopWorkerPath(): string {
  const isPackaged = !!process.resourcesPath && !process.defaultApp;

  if (isPackaged) {
    const bundled = path.join(process.resourcesPath, 'harness-bundle', 'worker-entry.js');
    if (fs.existsSync(bundled)) return bundled;
  }

  // Prefer the esbuild bundle over tsc-compiled dist.
  const devBundle = path.join(process.cwd(), 'packages', 'host', 'bundle', 'worker-entry.js');
  if (fs.existsSync(devBundle)) return devBundle;

  return devBundle;
}

function resolveDesktopBetterSqlite3Path(): string {
  const isPackaged = !!process.resourcesPath && !process.defaultApp;
  if (isPackaged) return path.join(process.resourcesPath, 'better-sqlite3');
  return path.join(process.cwd(), 'node_modules', 'better-sqlite3');
}

/** Desktop adapter for the Host-owned worker process supervisor. */
export class WorkerManager extends HostWorkerManager {
  constructor(sessionManager: SessionManager) {
    super({
      getState: (sessionId) => sessionManager.getSession(sessionId)?.state,
      transitionToStreaming: (sessionId) => {
        sessionManager.transitionState(sessionId, SessionState.STREAMING);
      },
      transitionToCrashed: (sessionId) => {
        sessionManager.transitionState(sessionId, SessionState.CRASHED);
      },
    }, {
      logger: hostLogger,
      resolveWorkerPath: resolveDesktopWorkerPath,
      resolveBetterSqlite3Path: resolveDesktopBetterSqlite3Path,
    });
  }
}
