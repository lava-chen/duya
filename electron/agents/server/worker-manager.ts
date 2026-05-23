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

  constructor(sessionManager: SessionManager) {
    this.sessionManager = sessionManager;
  }

  setCrashHandler(handler: (sessionId: string) => void): void {
    this.onWorkerCrash = handler;
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
      NODE_OPTIONS: `--max-old-space-size=${maxMemoryMB}`,
    };

    const child = fork(workerPath, [], {
      stdio: ['pipe', 'pipe', 'pipe', 'ipc'] as any,
      env,
    });

    const workerPid = child.pid;
    workerLogger.info('Worker spawned', { sessionId, pid: workerPid, workerPath, maxMemoryMB });

    this.sessionManager.transitionState(sessionId, SessionState.STREAMING);

    // Register new worker BEFORE killing old one, so workers map never goes empty for this session
    this.workers.set(sessionId, child);

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

      if (exitedCleanly) {
        workerLogger.info('Worker exited normally', { sessionId, pid: workerPid });
      } else if (exitedBySignal) {
        workerLogger.info('Worker terminated by signal', { sessionId, pid: workerPid, signal });
      } else {
        workerLogger.warn('Worker exited with error code', { sessionId, pid: workerPid, exitCode: code, signal });
      }

      const session = this.sessionManager.getSession(sessionId);
      if (session) {
        const isRealCrash = typeof code === 'number' && code > 0 && session.state !== SessionState.COMPLETED;
        if (isRealCrash) {
          this.sessionManager.transitionState(sessionId, SessionState.CRASHED);
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

  // Internal kill that accepts the child directly, used by spawnWorker during replace
  private killWorkerImpl(sessionId: string, child: ChildProcess): void {
    workerLogger.info('Killing worker', { sessionId, pid: child.pid });

    if (process.platform === 'win32') {
      child.kill();
    } else {
      child.kill('SIGTERM');

      const timeout = setTimeout(() => {
        if (!child.killed) {
          workerLogger.warn('Worker did not exit gracefully, force killing', { sessionId, pid: child.pid });
          child.kill('SIGKILL');
        }
      }, 3000);

      child.on('exit', () => {
        clearTimeout(timeout);
        if (this.workers.get(sessionId) === child) {
          this.workers.delete(sessionId);
          workerLogger.info('Worker terminated', { sessionId });
        }
      });
      return;
    }

    child.on('exit', () => {
      if (this.workers.get(sessionId) === child) {
        this.workers.delete(sessionId);
        workerLogger.info('Worker terminated', { sessionId });
      }
    });
  }

  sendCommand(sessionId: string, cmd: Record<string, unknown>): boolean {
    const child = this.workers.get(sessionId);
    if (!child || child.killed || !child.stdin) {
      workerLogger.warn('Worker not available for command', { sessionId, commandType: cmd.type, hasWorker: !!child, killed: child?.killed, hasStdin: !!child?.stdin });
      return false;
    }

    workerLogger.debug('Sending command to worker', { sessionId, commandType: cmd.type });
    child.stdin.write(JSON.stringify(cmd) + '\n');
    return true;
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
    // Check if running in bundled Electron app
    const isBundled = process.resourcesPath && !process.env.NODE_ENV;

    if (isBundled) {
      // In packaged app, worker is in resources
      const bundled = path.join(
        process.resourcesPath,
        'packages',
        'agent',
        'dist',
        'process',
        'agent-process-entry.js'
      );
      if (fs.existsSync(bundled)) {
        return bundled;
      }

      // Alternative path structure
      const alt = path.join(
        process.resourcesPath,
        'app',
        'packages',
        'agent',
        'dist',
        'process',
        'agent-process-entry.js'
      );
      if (fs.existsSync(alt)) {
        return alt;
      }
    }

    // Development mode: use project source
    return path.join(process.cwd(), 'packages', 'agent', 'dist', 'process', 'agent-process-entry.js');
  }

  killAll(): void {
    workerLogger.info('Killing all workers', { count: this.workers.size });
    for (const [sessionId] of this.workers) {
      this.killWorker(sessionId);
    }
  }
}