/**
 * services/voice/stt-worker.ts — isolated STT subprocess wrapper.
 *
 * Spawns the @duya/voice worker entry on a **Node** runtime (via `fork`),
 * isolating whisper.cpp's native ABI from Electron (same pattern as the
 * agent-bundle / better-sqlite3 split). Communicates over stdio JSON lines.
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
  | { type: 'push'; payload?: { chunk: ArrayBuffer } }
  | { type: 'finalize' }
  | { type: 'reset' }
  | { type: 'dispose' };

type WorkerResponse =
  | { ok: true; kind: 'ready' }
  | { ok: true; kind: 'init_result'; ready: boolean }
  | { ok: true; kind: 'interim' | 'final'; text: string }
  | { ok: true; kind: 'resumed' }
  | { ok: true; kind: 'disposed' }
  | { ok: false; kind: 'error'; message: string; code?: string };

export interface SttWorkerCallbacks {
  onInterim: (text: string) => void;
  onFinal: (text: string) => void;
  onError: (message: string, code?: string) => void;
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
  private pending = '';
  private ready = false;
  private readonly callbacks: SttWorkerCallbacks;
  private readonly logger = getLogger();

  constructor(callbacks: SttWorkerCallbacks) {
    this.callbacks = callbacks;
  }

  get isRunning(): boolean {
    return this.child !== null && this.child.exitCode === null;
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
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
      execPath: process.execPath,
    });
    this.child = child;
    this.pending = '';

    child.stdout?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => this.onData(chunk));
    child.stderr?.on('data', (data: Buffer) => {
      const line = data.toString().trim();
      if (line) this.logger.warn('STT worker stderr', { line }, LogComponent.Voice);
    });
    child.on('exit', (code, signal) => {
      this.logger.info('STT worker exited', { code, signal }, LogComponent.Voice);
      this.child = null;
      this.ready = false;
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
    this.send({ type: 'push', payload: { chunk: chunk.buffer } });
  }

  finalize(): void {
    this.send({ type: 'finalize' });
  }

  reset(): void {
    this.send({ type: 'reset' });
  }

  dispose(): void {
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

  private onData(chunk: string): void {
    this.pending += chunk;
    let idx: number;
    while ((idx = this.pending.indexOf('\n')) >= 0) {
      const line = this.pending.slice(0, idx);
      this.pending = this.pending.slice(idx + 1);
      if (!line.trim()) continue;
      let resp: WorkerResponse;
      try {
        resp = JSON.parse(line) as WorkerResponse;
      } catch {
        continue;
      }
      this.handleResponse(resp);
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
    if (!this.child || this.child.stdin?.writable === false) {
      throw new Error('STT worker is not running');
    }
    this.child.stdin.write(`${JSON.stringify(req)}\n`);
  }
}