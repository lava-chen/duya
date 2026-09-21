/**
 * services/recorder/hook-worker.ts — hook-worker child process lifecycle
 * (plan 556 Phase 1).
 *
 * The uiohook-napi worker runs as an isolated Node subprocess
 * (design decision D2) using the SAME spawn/heartbeat/restart pipeline
 * as the computer-use daemon: `createComputerUseDaemon` with
 * `ELECTRON_RUN_AS_NODE` and a 90s dead-man timer. The uiohook prebuild
 * is N-API (`prebuildify --napi`), so it loads under the embedded Node
 * without any electron-rebuild.
 *
 * Restart policy (design §5): exactly ONE automatic restart on crash or
 * heartbeat timeout — the daemon's backoff loop is capped by watching
 * `restartCount` and stopping the daemon on the second failure, after
 * which the recording degrades (recorder-service keeps running with no
 * input events, UI surfaces the state).
 *
 * Command surface: owned entirely by computer-use-daemon.ts (fixed pair
 * `<runtime> <entry from the build layout>`, no shell). This module only
 * parses stdout lines and enforces the restart cap.
 */

import { createComputerUseDaemon, type ComputerUseDaemon } from '../computer-use-daemon.js';
import { getLogger, LogComponent } from '../../logging/logger.js';
import { existsSync } from 'node:fs';
import path from 'node:path';

import { parseWorkerLine, type WorkerEvent } from '@duya/computer-use';

const logger = getLogger();

/** Worker heartbeat cadence is 30s; 90s of silence ⇒ dead (daemon parity). */
export const HEARTBEAT_TIMEOUT_MS = 90_000;

const WORKER_ENTRY_BASENAME = 'hook-worker-entry.js';

export type HookWorkerState =
  | 'idle'
  | 'starting'
  | 'running'
  | 'failed';

export interface HookWorkerCallbacks {
  onEvent: (event: WorkerEvent) => void;
  /** Terminal failure after the one allowed restart was spent. */
  onFailed: (reason: string) => void;
  /** Unexpected exit while the parent still wants the worker running. */
  onCrash: (info: { code: number | null; signal: string | null }) => void;
}

export interface HookWorkerOptions {
  entryPath?: string;
  heartbeatTimeoutMs?: number;
  /** Test hook: forwarded to the daemon's spawnFn. */
  spawnFn?: Parameters<typeof createComputerUseDaemon>[0]['spawnFn'];
}

/**
 * Resolve the compiled worker entry from the build layout only
 * (packaged `resources/computer-use/` vs dev workspace dist). No env or
 * config input feeds this path.
 */
export function resolveHookWorkerPath(): string {
  const isPackaged = !!process.resourcesPath && !process.defaultApp;
  if (isPackaged) {
    const bundled = path.join(process.resourcesPath, 'computer-use', WORKER_ENTRY_BASENAME);
    if (existsSync(bundled)) return bundled;
  }
  return path.join(process.cwd(), 'packages', 'computer-use', 'dist', 'recorder', WORKER_ENTRY_BASENAME);
}

export class RecorderHookWorker {
  private daemon: ComputerUseDaemon | null = null;
  private state: HookWorkerState = 'idle';
  private stopping = false;
  /** Highest restartCount already acted on (health patches replay it). */
  private seenRestarts = 0;
  private terminal = false;
  private readonly callbacks: HookWorkerCallbacks;
  private readonly opts: {
    entryPath: string;
    heartbeatTimeoutMs: number;
    spawnFn?: HookWorkerOptions['spawnFn'];
  };

  constructor(callbacks: HookWorkerCallbacks, opts: HookWorkerOptions = {}) {
    this.callbacks = callbacks;
    this.opts = {
      entryPath: opts.entryPath ?? resolveHookWorkerPath(),
      heartbeatTimeoutMs: opts.heartbeatTimeoutMs ?? HEARTBEAT_TIMEOUT_MS,
      spawnFn: opts.spawnFn,
    };
  }

  get currentState(): HookWorkerState {
    return this.state;
  }

  get isRunning(): boolean {
    return this.daemon !== null && this.daemon.getHealth().running && !this.stopping;
  }

  /** Spawn the worker (uiohook attaches asynchronously; events prove liveness). */
  async start(): Promise<void> {
    if (this.daemon) {
      return;
    }
    this.stopping = false;
    if (!existsSync(this.opts.entryPath)) {
      this.state = 'failed';
      this.callbacks.onFailed(`hook worker entry not found: ${this.opts.entryPath}`);
      return;
    }
    this.state = 'starting';
    const daemon = createComputerUseDaemon({
      runtime: process.execPath,
      entry: this.opts.entryPath,
      env: { ELECTRON_RUN_AS_NODE: '1' },
      heartbeatTimeoutMs: this.opts.heartbeatTimeoutMs,
      // Parse our JSON-line protocol off the shared stdout pipe. Lines
      // that are not worker events (the daemon-facing heartbeat line,
      // garbage) are ignored here; the daemon's own dead-man timer
      // consumes the heartbeats.
      onStdoutLine: (line) => this.handleLine(line),
      spawnFn: this.opts.spawnFn,
    });
    this.daemon = daemon;
    daemon.onHealth((health) => {
      if (this.stopping || !this.daemon) {
        return;
      }
      // Health patches carry forward the last restartCount, so only
      // react to increases. The design wants exactly ONE automatic
      // restart; the next increment stops everything.
      if (health.restartCount <= this.seenRestarts) {
        return;
      }
      this.seenRestarts = health.restartCount;
      if (health.restartCount === 1) {
        this.callbacks.onCrash({ code: null, signal: null });
        return;
      }
      if (!this.terminal) {
        this.terminal = true;
        this.state = 'failed';
        const reason = health.lastError ?? 'hook worker restart limit reached';
        logger.warn('recorder hook-worker failed after restart', { reason }, LogComponent.ComputerUse);
        void daemon.stop().catch(() => undefined);
        this.daemon = null;
        this.callbacks.onFailed(reason);
      }
    });
    await daemon.start();
    logger.info('recorder hook-worker starting', { entry: this.opts.entryPath }, LogComponent.ComputerUse);
  }

  /** Stop: SIGTERM the worker and wait for exit. */
  async stop(): Promise<void> {
    this.stopping = true;
    const daemon = this.daemon;
    this.daemon = null;
    if (!daemon) {
      this.state = 'idle';
      return;
    }
    await daemon.stop();
    this.state = 'idle';
  }

  /** Dispose without restart semantics (app teardown). */
  async dispose(): Promise<void> {
    await this.stop();
  }

  private handleLine(line: string): void {
    // The daemon-facing heartbeat ({"type":"heartbeat"}) drives the
    // shared dead-man timer inside computer-use-daemon; skip it here.
    if (line.includes('"heartbeat"')) {
      if (this.state === 'starting') {
        this.state = 'running';
      }
      return;
    }
    const event = parseWorkerLine(line);
    if (event === null) {
      logger.debug('recorder hook-worker unparseable line', { line: line.slice(0, 200) }, LogComponent.ComputerUse);
      return;
    }
    if (this.state === 'starting') {
      this.state = 'running';
    }
    this.callbacks.onEvent(event);
  }
}
