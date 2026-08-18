/**
 * services/voice/stt-worker.ts — isolated STT subprocess wrapper.
 *
 * Spawns the @duya/voice worker entry on a **Node** runtime (via `fork`),
 * isolating whisper.cpp's native ABI from Electron (same pattern as the
 * agent-bundle / better-sqlite3 split). Communicates over the fork IPC
 * channel with v8 advanced serialization (`serialization: 'advanced'`), so
 * PCM chunks (Int16Array) are transferred natively — JSON serialization
 * silently turns an ArrayBuffer into `{}`, which is what previously severed
 * this pipeline. stderr stays piped for diagnostics.
 */
import { fork, ChildProcess } from 'child_process';
import { join } from 'path';
import { existsSync } from 'fs';
import { getLogger, LogComponent } from '../../logging/logger';

export interface SttWorkerInitPayload {
  kind?: 'local' | 'cloud';
  binaryPath?: string;
  modelPath?: string;
  language?: string;
  baseUrl?: string;
  apiKey?: string;
  model?: string;
}

type WorkerRequest =
  | { type: 'init'; payload?: SttWorkerInitPayload }
  | { type: 'push'; payload?: { chunk?: Int16Array } }
  | { type: 'finalize' }
  | { type: 'reset' }
  | { type: 'dispose' };

type WorkerResponse =
  | { ok: true; kind: 'init_result'; ready: boolean }
  | { ok: true; kind: 'interim' | 'final'; text: string }
  | { ok: true; kind: 'resumed' }
  | { ok: true; kind: 'disposed' }
  | { ok: false; kind: 'error'; message: string; code?: string };

export interface SttWorkerCallbacks {
  onInterim: (text: string) => void;
  onFinal: (text: string) => void;
  onError: (message: string, code?: string) => void;
  /** Fired when the subprocess dies unexpectedly (not via dispose). */
  onExit?: () => void;
}

/** Resolve the worker entry path (packaged vs dev). */
export function resolveSttWorkerPath(): string {
  const isPackaged = !!process.resourcesPath && !process.defaultApp;
  if (isPackaged) {
    const bundled = join(process.resourcesPath, 'voice', 'worker.js');
    if (existsSync(bundled)) return bundled;
  }
  const devDist = join(process.cwd(), 'packages', 'voice', 'dist', 'worker.js');
  return devDist;
}

export class SttWorker {
  private child: ChildProcess | null = null;
  private ready = false;
  private disposed = false;
  private readonly callbacks: SttWorkerCallbacks;
  private readonly logger = getLogger();

  constructor(callbacks: SttWorkerCallbacks) {
    this.callbacks = callbacks;
  }

  get isRunning(): boolean {
    return this.child !== null && this.child.exitCode === null && !this.disposed;
  }

  /** Spawn the subprocess and wait for it to come alive. */
  async spawn(): Promise<void> {
    if (this.isRunning) return;
    const workerPath = resolveSttWorkerPath();
    if (!existsSync(workerPath)) {
      throw new Error(`STT worker entry not found: ${workerPath}`);
    }

    const child = fork(workerPath, [], {
      stdio: ['pipe', 'pipe', 'pipe', 'ipc'],
      // 'advanced' = v8 structured clone: Int16Array survives IPC natively.
      serialization: 'advanced',
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
      execPath: process.execPath,
    });
    this.child = child;
    this.disposed = false;

    child.stdout?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => {
      const line = chunk.trim();
      if (line) this.logger.debug('STT worker stdout', { line }, LogComponent.Voice);
    });
    child.stderr?.on('data', (data: Buffer) => {
      const line = data.toString().trim();
      if (line) this.logger.warn('STT worker stderr', { line }, LogComponent.Voice);
    });
    child.on('message', (resp: WorkerResponse) => this.handleResponse(resp));
    child.on('exit', (code, signal) => {
      this.logger.info('STT worker exited', { code, signal }, LogComponent.Voice);
      this.child = null;
      this.ready = false;
      const pendingInit = this.pendingInit;
      this.pendingInit = null;
      if (pendingInit) {
        pendingInit.reject(new Error('STT worker exited before init completed'));
      }
      if (!this.disposed) this.callbacks.onExit?.();
    });

    this.logger.info('STT worker spawned', { pid: child.pid, workerPath }, LogComponent.Voice);
  }

  init(payload: SttWorkerInitPayload): Promise<boolean> {
    return new Promise((resolve, reject) => {
      this.pendingInit = { resolve, reject };
      try {
        this.send({ type: 'init', payload });
      } catch (err) {
        this.pendingInit = null;
        reject(err);
      }
    });
  }

  push(chunk: Int16Array): void {
    if (chunk.length === 0) return;
    this.send({ type: 'push', payload: { chunk } });
  }

  finalize(): void {
    this.send({ type: 'finalize' });
  }

  reset(): void {
    this.send({ type: 'reset' });
  }

  dispose(): void {
    this.disposed = true;
    try {
      this.send({ type: 'dispose' });
    } catch {
      // Process may already be gone.
    }
    const child = this.child;
    if (child) {
      setTimeout(() => {
        if (child.exitCode === null) child.kill();
      }, 500).unref();
    }
  }

  private pendingInit: {
    resolve: (ready: boolean) => void;
    reject: (err: Error) => void;
  } | null = null;

  private handleResponse(resp: WorkerResponse): void {
    if (resp.kind === 'init_result') {
      const pending = this.pendingInit;
      this.pendingInit = null;
      if (pending) {
        this.ready = resp.ok && resp.ready;
        pending.resolve(this.ready);
      }
      return;
    }

    if (!resp.ok) {
      this.callbacks.onError(resp.message, resp.code);
      return;
    }
    switch (resp.kind) {
      case 'interim':
        this.callbacks.onInterim(resp.text);
        break;
      case 'final':
        this.callbacks.onFinal(resp.text);
        break;
      default:
        break;
    }
  }

  private send(req: WorkerRequest): void {
    if (!this.child || !this.child.connected) {
      throw new Error('STT worker is not running');
    }
    this.child.send(req);
  }
}