import { fork, ChildProcess } from 'child_process';
import * as path from 'path';
import * as fs from 'fs';
import { SessionManager } from './session-store';
import { SessionState } from './types';
import { workerLogger } from './logger';

export class WorkerManager {
  private workers = new Map<string, ChildProcess>();
  private sessionManager: SessionManager;
  private onWorkerCrash: ((sessionId: string) => void) | null = null;
  private onWorkerMessage: ((sessionId: string, msg: Record<string, unknown>) => void) | null = null;
  // H6: Track intentionally killed workers so their exit is not misjudged as a crash
  private intentionalKills = new WeakSet<ChildProcess>();

  constructor(sessionManager: SessionManager) {
    this.sessionManager = sessionManager;
  }

  setCrashHandler(handler: (sessionId: string) => void): void {
    this.onWorkerCrash = handler;
  }

  setMessageHandler(handler: (sessionId: string, msg: Record<string, unknown>) => void): void {
    this.onWorkerMessage = handler;
  }

  spawnWorker(sessionId: string): ChildProcess {
    // Create new worker BEFORE killing old one, so workers map stays populated during transition
    const oldChild = this.workers.get(sessionId);
    const workerPath = this.resolveWorkerPath();

    if (!fs.existsSync(workerPath)) {
      throw new Error(`Worker entry not found: ${workerPath}`);
    }

    const maxMemoryMB = parseInt(process.env.DUYA_WORKER_MAX_MEMORY_MB || '2048', 10);

    const env: NodeJS.ProcessEnv = {
      ...process.env,
      SESSION_ID: sessionId,
      DUYA_AGENT_MODE: 'true',
      DUYA_AGENT_SERVER: 'true',
      DUYA_BETTER_SQLITE3_PATH: process.env.DUYA_BETTER_SQLITE3_PATH || this.resolveBetterSqlite3Path(),
      DUYA_CUSTOM_DB_PATH: process.env.DUYA_CUSTOM_DB_PATH,
      NODE_OPTIONS: `--max-old-space-size=${maxMemoryMB}`,
    };

    const child = fork(workerPath, [], {
      stdio: ['pipe', 'pipe', 'pipe', 'ipc'] as any,
      env: {
        ...env,
        ELECTRON_RUN_AS_NODE: '1',
      },
      execPath: process.execPath,
    });

    const workerPid = child.pid;
    workerLogger.info('Worker spawned', {
      sessionId,
      pid: workerPid,
      workerPath,
      maxMemoryMB,
      betterSqlite3Path: env.DUYA_BETTER_SQLITE3_PATH,
    });

    this.workers.set(sessionId, child);

    // C5: Transition state after worker is registered. The caller may have already
    // transitioned (e.g. handlePostChat uses transitionState as a concurrency lock),
    // so wrap in try/catch to avoid throwing if the transition is invalid.
    try {
      this.sessionManager.transitionState(sessionId, SessionState.STREAMING);
    } catch (err) {
      workerLogger.warn('transitionState(STREAMING) skipped', {
        sessionId,
        error: err instanceof Error ? err.message : String(err),
      });
    }

    // Now kill the old worker if it existed
    if (oldChild) {
      this.killWorkerImpl(sessionId, oldChild);
    }

    child.on('exit', (code, signal) => {
      // Only clean up if this child is still the current worker for this session
      const current = this.workers.get(sessionId);
      if (current !== child) {
        workerLogger.info('Worker exit ignored (stale, already replaced)', { sessionId, pid: workerPid });
        return;
      }
      this.workers.delete(sessionId);

      const exitedCleanly = code === 0;
      const exitedBySignal = code === null && signal !== null;
      // H6: Intentionally killed workers (e.g. via killWorker/interruptWorker) should
      // not be misjudged as crashes on Windows where child.kill() produces non-zero exit.
      const isIntentionalKill = this.intentionalKills.has(child);

      if (exitedCleanly) {
        workerLogger.info('Worker exited normally', { sessionId, pid: workerPid });
      } else if (exitedBySignal || isIntentionalKill) {
        workerLogger.info('Worker terminated by signal', { sessionId, pid: workerPid, signal, intentional: isIntentionalKill });
      } else {
        workerLogger.warn('Worker exited with error code', { sessionId, pid: workerPid, exitCode: code, signal });
      }

      const session = this.sessionManager.getSession(sessionId);
      if (session) {
        const isRealCrash = !isIntentionalKill && typeof code === 'number' && code > 0 && session.state !== SessionState.COMPLETED;
        if (isRealCrash) {
          try {
            this.sessionManager.transitionState(sessionId, SessionState.CRASHED);
          } catch {
            // State transition may be invalid if session already moved on
          }
          workerLogger.error('Worker crash detected', undefined, { sessionId, exitCode: code, signal });
          if (this.onWorkerCrash) {
            this.onWorkerCrash(sessionId);
          }
        }
      }
    });

    child.stderr!.on('data', (data: Buffer) => {
      const line = data.toString().trim();
      if (!line) return;

      // Direct output to console for debugging - this is from agent process
      console.error(`[worker:${sessionId.slice(0, 8)}] ${line}`);

      // Parse log level from message - worker uses [LEVEL] prefix
      if (line.startsWith('[ERROR]') || line.includes('Error:')) {
        workerLogger.error('Worker stderr', new Error(line), { sessionId, pid: workerPid });
      } else if (line.startsWith('[WARN]') || line.startsWith('[WARNING]')) {
        workerLogger.warn('Worker stderr', { sessionId, pid: workerPid, message: line });
      } else if (line.startsWith('[INFO]') || line.startsWith('[DEBUG]')) {
        workerLogger.info('Worker stderr', { sessionId, pid: workerPid, message: line });
      } else {
        // Unknown format - log as info to avoid false ERROR alerts
        workerLogger.info('Worker stderr', { sessionId, pid: workerPid, message: line });
      }
    });

    child.on('message', (msg: Record<string, unknown>) => {
      // db:request and conductor:executor:rpc are handled by the per-request
      // handlers in router.ts (they forward to main process). All other
      // messages go to the centralized handler (used by InteragentRouter).
      if (msg.type === 'db:request' || msg.type === 'conductor:executor:rpc') {
        return;
      }
      if (this.onWorkerMessage) {
        this.onWorkerMessage(sessionId, msg);
      }
    });

    child.on('error', (err) => {
      workerLogger.error('Worker process error', err, { sessionId, pid: workerPid });
    });
    return child;
  }

  killWorker(sessionId: string): void {
    const child = this.workers.get(sessionId);
    if (!child) return;
    this.killWorkerImpl(sessionId, child);
  }

  interruptWorker(sessionId: string, graceMs = 2000): boolean {
    const child = this.workers.get(sessionId);
    if (!child) return false;

    const sent = this.sendCommand(sessionId, { type: 'chat:interrupt', sessionId });
    workerLogger.info('Worker interrupt requested', {
      sessionId,
      pid: child.pid,
      sent,
      graceMs,
    });

    const timeout = setTimeout(() => {
      if (this.workers.get(sessionId) === child) {
        workerLogger.warn('Worker still present after interrupt grace period, terminating', {
          sessionId,
          pid: child.pid,
        });
        this.killWorkerImpl(sessionId, child);
      }
    }, graceMs);

    child.once('exit', () => {
      clearTimeout(timeout);
    });

    return true;
  }

  // Internal kill that accepts the child directly, used by spawnWorker during replace
  private killWorkerImpl(sessionId: string, child: ChildProcess): void {
    workerLogger.info('Killing worker', { sessionId, pid: child.pid });
    // H6: Mark this child as intentionally killed so the spawnWorker exit handler
    // does not misjudge it as a crash (especially on Windows).
    this.intentionalKills.add(child);
    let exited = false;
    const forceKillTimeout = setTimeout(() => {
      if (!exited) {
        workerLogger.warn('Worker did not exit after termination signal, force killing', {
          sessionId,
          pid: child.pid,
        });
        child.kill('SIGKILL');
      }
    }, 3000);

    // M11: Single once('exit') listener handles both timeout cleanup and map deletion
    child.once('exit', () => {
      exited = true;
      clearTimeout(forceKillTimeout);
      if (this.workers.get(sessionId) === child) {
        this.workers.delete(sessionId);
        workerLogger.info('Worker terminated', { sessionId });
      }
    });

    if (process.platform === 'win32') {
      child.kill();
    } else {
      child.kill('SIGTERM');
    }
  }

  sendCommand(sessionId: string, cmd: Record<string, unknown>): boolean {
    const child = this.workers.get(sessionId);
    if (!child || child.killed || !child.stdin) {
      workerLogger.warn('Worker not available for command', { sessionId, commandType: cmd.type, hasWorker: !!child, killed: child?.killed, hasStdin: !!child?.stdin });
      return false;
    }

    workerLogger.debug('Sending command to worker', { sessionId, commandType: cmd.type });
    try {
      child.stdin.write(JSON.stringify(cmd) + '\n');
    } catch (err) {
      // C2: stdin.write can throw if the pipe is closed (worker exiting)
      workerLogger.warn('Failed to write command to worker stdin', {
        sessionId,
        commandType: cmd.type,
        error: err instanceof Error ? err.message : String(err),
      });
      return false;
    }
    return true;
  }

  broadcastCommand(cmd: Record<string, unknown>): number {
    let count = 0;
    for (const [sessionId] of this.workers) {
      if (this.sendCommand(sessionId, cmd)) {
        count++;
      }
    }
    workerLogger.info('Broadcast command to workers', { commandType: cmd.type, workerCount: count });
    return count;
  }

  getWorker(sessionId: string): ChildProcess | undefined {
    return this.workers.get(sessionId);
  }

  hasWorker(sessionId: string): boolean {
    return this.workers.has(sessionId);
  }

  get workerCount(): number {
    return this.workers.size;
  }

  private resolveWorkerPath(): string {
    const isPackaged = !!process.resourcesPath && !process.defaultApp;

    if (isPackaged) {
      const bundled = path.join(process.resourcesPath, 'agent-bundle', 'agent-process-entry.js');
      if (fs.existsSync(bundled)) {
        return bundled;
      }

      const primary = path.join(process.resourcesPath, 'agent', 'process', 'agent-process-entry.js');
      if (fs.existsSync(primary)) {
        return primary;
      }

      const fallback = path.join(process.resourcesPath, 'agent', 'dist', 'process', 'agent-process-entry.js');
      if (fs.existsSync(fallback)) {
        return fallback;
      }
    }

    // Prefer the esbuild bundle over tsc-compiled dist.
    // The dist output is ESM with runtime imports that resolve to
    // @duya/plugin-core's "main": "src/index.ts", which Node.js
    // cannot load natively (ERR_UNKNOWN_FILE_EXTENSION).
    const devBundle = path.join(process.cwd(), 'packages', 'agent', 'bundle', 'agent-process-entry.js');
    if (fs.existsSync(devBundle)) {
      return devBundle;
    }

    const devDist = path.join(process.cwd(), 'packages', 'agent', 'dist', 'process', 'agent-process-entry.js');
    if (fs.existsSync(devDist)) {
      return devDist;
    }

    return devBundle;
  }

  private resolveBetterSqlite3Path(): string {
    const isPackaged = !!process.resourcesPath && !process.defaultApp;
    if (isPackaged) {
      return path.join(process.resourcesPath, 'better-sqlite3');
    }

    return path.join(process.cwd(), 'node_modules', 'better-sqlite3');
  }

  killAll(): void {
    workerLogger.info('Killing all workers', { count: this.workers.size });
    for (const [sessionId] of this.workers) {
      this.killWorker(sessionId);
    }
  }
}
