/**
 * computer-use-daemon.ts — long-running daemon lifecycle.
 *
 * Spawns the `computer-use-demo` v0.4 daemon as a child process
 * (Node.js + TypeScript source; runs via `tsx` in dev, via compiled
 * entry in production). Watches stdout for JSON heartbeats, stderr
 * for panic logs, and exit codes for crash recovery.
 *
 * Restart policy:
 *   - Exponential backoff: 1s, 2s, 4s, 8s, 16s, 32s, capped at 60s.
 *   - Each successful heartbeat resets the backoff to 1s.
 *   - Consecutive restart count is unbounded but the cap is enforced.
 *
 * Health broadcast:
 *   - `onHealth(callback)` subscribers receive `{ running, schemaVersion,
 *     lastError }`. The UI uses this to render "Context Source Offline"
 *     when the daemon dies.
 *
 * Env contract:
 *   - `DUYA_COMPUTER_USE_CONTEXT_DIR` overrides the watch directory
 *     (defaults to `~/.duya/context/`).
 *
 * Plan 453 Task D.
 */

import { spawn, type ChildProcess, type StdioOptions } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { homedir } from 'node:os';
import path from 'node:path';

import { getLogger, LogComponent } from '../logging/logger.js';

const logger = getLogger();

/** Heartbeat interval the daemon emits (30s, per plan §5 Task D). */
const HEARTBEAT_TIMEOUT_MS = 90_000;

/** Initial backoff. */
const BACKOFF_INITIAL_MS = 1000;

/** Backoff cap. */
const BACKOFF_MAX_MS = 60_000;

/** Backoff multiplier. */
const BACKOFF_MULTIPLIER = 2;

/** Health snapshot shape exposed to listeners + IPC. */
export interface ComputerUseHealth {
  running: boolean;
  /** PID of the daemon child process, or null when not running. */
  pid: number | null;
  /** Schema version reported by the most recent heartbeat, or null. */
  schemaVersion: string | null;
  /** Last error message (parse failure / exit / spawn failure). */
  lastError: string | null;
  /** ISO timestamp of the last heartbeat (or spawn success). */
  lastHeartbeatAt: string | null;
  /** Number of times the daemon has been restarted in this lifecycle. */
  restartCount: number;
  /** Current backoff (ms) before next restart attempt. */
  nextRestartInMs: number | null;
}

export interface ComputerUseDaemonOptions {
  /** Node runtime to use. Defaults to `process.execPath`. */
  runtime?: string;
  /** Entry point to spawn (path to daemon .js or .ts). */
  entry: string;
  /** Working directory of the daemon process. */
  cwd?: string;
  /** Override context directory (the daemon writes here). */
  contextDir?: string;
  /** Extra environment merged over process.env for the child. */
  env?: NodeJS.ProcessEnv;
  /**
   * Observe every trimmed stdout line before the daemon's own
   * heartbeat handling. Lets second consumers (e.g. the plan 556
   * recorder hook worker, which reuses this spawn pipeline) parse
   * their own JSON-line protocol off the same pipe.
   */
  onStdoutLine?: (line: string) => void;
  /** Override heartbeat timeout (default 90s). */
  heartbeatTimeoutMs?: number;
  /** Override initial backoff (default 1000ms). */
  backoffInitialMs?: number;
  /** Override backoff cap (default 60000ms). */
  backoffMaxMs?: number;
  /** Override backoff multiplier (default 2). */
  backoffMultiplier?: number;
  /** Inject a spawn fn (tests use this to bypass child_process). */
  spawnFn?: (cmd: string, args: string[], opts: {
    stdio: StdioOptions;
    env: NodeJS.ProcessEnv;
    cwd?: string;
  }) => ChildProcess;
}

export type ComputerUseDaemonListener = (health: ComputerUseHealth) => void;

export interface ComputerUseDaemon {
  start(): Promise<void>;
  stop(): Promise<void>;
  ensureRunning(): Promise<void>;
  onHealth(listener: ComputerUseDaemonListener): () => void;
  getHealth(): ComputerUseHealth;
  /** Test-only: replace the singleton. */
  __setForTest(replacement: ComputerUseDaemon | null): void;
}

const DEFAULT_HEALTH: ComputerUseHealth = {
  running: false,
  pid: null,
  schemaVersion: null,
  lastError: null,
  lastHeartbeatAt: null,
  restartCount: 0,
  nextRestartInMs: null,
};

class ComputerUseDaemonImpl implements ComputerUseDaemon {
  private proc: ChildProcess | null = null;
  private emitter = new EventEmitter();
  private health: ComputerUseHealth = { ...DEFAULT_HEALTH };
  private currentBackoffMs: number;
  private restartTimer: NodeJS.Timeout | null = null;
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private stopping = false;
  private stopped = false;
  private readonly opts: Required<Pick<ComputerUseDaemonOptions,
    'runtime' | 'entry' | 'cwd' | 'contextDir' | 'heartbeatTimeoutMs' |
    'backoffInitialMs' | 'backoffMaxMs' | 'backoffMultiplier'>>;
  private readonly spawnFn: ((cmd: string, args: string[], opts: {
    stdio: StdioOptions;
    env: NodeJS.ProcessEnv;
    cwd?: string;
  }) => ChildProcess) | undefined;
  private readonly extraEnv: NodeJS.ProcessEnv | undefined;
  private readonly onStdoutLine: ((line: string) => void) | undefined;

  constructor(opts: ComputerUseDaemonOptions) {
    this.opts = {
      runtime: opts.runtime ?? process.execPath,
      entry: opts.entry,
      cwd: opts.cwd ?? process.cwd(),
      contextDir: opts.contextDir ?? path.join(homedir(), '.duya', 'context'),
      heartbeatTimeoutMs: opts.heartbeatTimeoutMs ?? HEARTBEAT_TIMEOUT_MS,
      backoffInitialMs: opts.backoffInitialMs ?? BACKOFF_INITIAL_MS,
      backoffMaxMs: opts.backoffMaxMs ?? BACKOFF_MAX_MS,
      backoffMultiplier: opts.backoffMultiplier ?? BACKOFF_MULTIPLIER,
    };
    this.spawnFn = opts.spawnFn;
    this.extraEnv = opts.env;
    this.onStdoutLine = opts.onStdoutLine;
    this.currentBackoffMs = this.opts.backoffInitialMs;
  }

  async start(): Promise<void> {
    if (this.stopped) {
      throw new Error('daemon has been stopped; create a new instance');
    }
    if (this.proc) return; // idempotent
    this.stopping = false;
    logger.info(
      'ComputerUseDaemon starting',
      { entry: this.opts.entry, contextDir: this.opts.contextDir },
      LogComponent.ComputerUseDaemon,
    );
    await this.spawnOnce();
  }

  async stop(): Promise<void> {
    this.stopping = true;
    this.stopped = true;
    if (this.restartTimer) {
      clearTimeout(this.restartTimer);
      this.restartTimer = null;
    }
    if (this.heartbeatTimer) {
      clearTimeout(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    if (!this.proc) return;
    const proc = this.proc;
    logger.info(
      'ComputerUseDaemon stopping',
      { pid: proc.pid ?? null },
      LogComponent.ComputerUseDaemon,
    );
    return new Promise<void>((resolve) => {
      const killTimer = setTimeout(() => {
        try {
          proc.kill('SIGKILL');
        } catch {
          // ignore
        }
      }, 5000);
      proc.once('exit', () => {
        clearTimeout(killTimer);
        resolve();
      });
      try {
        proc.kill('SIGTERM');
      } catch {
        clearTimeout(killTimer);
        resolve();
      }
    });
  }

  async ensureRunning(): Promise<void> {
    if (this.proc) return;
    if (this.stopping || this.stopped) return;
    await this.spawnOnce();
  }

  onHealth(listener: ComputerUseDaemonListener): () => void {
    this.emitter.on('health', listener);
    // Fire immediately with current state so consumers don't have to
    // poll for "what's the state right now".
    try {
      listener(this.health);
    } catch {
      // swallow listener errors
    }
    return () => {
      this.emitter.off('health', listener);
    };
  }

  getHealth(): ComputerUseHealth {
    return { ...this.health };
  }

  __setForTest(_replacement: ComputerUseDaemon | null): void {
    // singleton hook — see getComputerUseDaemon
  }

  private async spawnOnce(): Promise<void> {
    return new Promise<void>((resolve) => {
      try {
        const env: NodeJS.ProcessEnv = {
          ...process.env,
          DUYA_COMPUTER_USE_CONTEXT_DIR: this.opts.contextDir,
          ...this.extraEnv,
        };
        const args = [this.opts.entry];
        const stdio: StdioOptions = ['ignore', 'pipe', 'pipe'];
        const cwd = this.opts.cwd;
        const spawn = this.spawnFn ?? defaultSpawn;
        const proc = spawn(this.opts.runtime, args, { stdio, env, cwd });

        this.proc = proc;
        this.updateHealth({
          running: true,
          pid: proc.pid ?? null,
          lastError: null,
          lastHeartbeatAt: new Date().toISOString(),
          nextRestartInMs: null,
        });

        proc.stdout?.on('data', (chunk: Buffer) => {
          this.handleStdout(chunk);
        });
        proc.stderr?.on('data', (chunk: Buffer) => {
          this.handleStderr(chunk);
        });
        proc.once('exit', (code: number | null, signal: NodeJS.Signals | null) => {
          this.handleExit(code, signal);
          resolve();
        });
        proc.on('error', (err: Error) => {
          this.health.lastError = err.message;
          this.updateHealth({ running: false, pid: null });
          this.scheduleRestart(err.message);
          resolve();
        });

        // Heartbeat timer: if we don't see a heartbeat within
        // `heartbeatTimeoutMs`, kill the process and let the restart
        // path bring it back.
        this.resetHeartbeatTimer();
        resolve();
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        this.health.lastError = msg;
        this.updateHealth({ running: false, pid: null });
        logger.error(
          'ComputerUseDaemon spawn failed',
          err instanceof Error ? err : new Error(msg),
          undefined,
          LogComponent.ComputerUseDaemon,
        );
        this.scheduleRestart(msg);
        resolve();
      }
    });
  }

  private handleStdout(chunk: Buffer): void {
    const text = chunk.toString('utf-8');
    // Heartbeats are line-delimited JSON; we split defensively.
    for (const line of text.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      // Second consumers first: they may parse a different protocol off
      // the same pipe (recorder hook worker, plan 556).
      if (this.onStdoutLine) {
        try {
          this.onStdoutLine(trimmed);
        } catch {
          // observer errors must not disturb the daemon loop
        }
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(trimmed);
      } catch {
        // not JSON — log as info, not as error
        logger.debug(
          'ComputerUseDaemon non-JSON stdout line',
          { line: trimmed.slice(0, 200) },
          LogComponent.ComputerUseDaemon,
        );
        continue;
      }
      if (
        parsed &&
        typeof parsed === 'object' &&
        (parsed as { type?: unknown }).type === 'heartbeat'
      ) {
        const schemaVersion = (parsed as { schemaVersion?: unknown })
          .schemaVersion;
        if (typeof schemaVersion === 'string') {
          this.health.schemaVersion = schemaVersion;
        }
        this.health.lastHeartbeatAt = new Date().toISOString();
        // Successful heartbeat: reset backoff.
        this.currentBackoffMs = this.opts.backoffInitialMs;
        this.updateHealth({ schemaVersion: this.health.schemaVersion });
        this.resetHeartbeatTimer();
      }
    }
  }

  private handleStderr(chunk: Buffer): void {
    const text = chunk.toString('utf-8');
    for (const line of text.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      logger.error(
        'ComputerUseDaemon stderr',
        new Error(trimmed),
        undefined,
        LogComponent.ComputerUseDaemon,
      );
    }
  }

  private handleExit(code: number | null, signal: NodeJS.Signals | null): void {
    if (this.stopping) {
      logger.info(
        'ComputerUseDaemon exited cleanly',
        { code, signal },
        LogComponent.ComputerUseDaemon,
      );
      this.updateHealth({ running: false, pid: null });
      return;
    }
    const reason = `exit code=${code ?? 'null'} signal=${signal ?? 'null'}`;
    logger.warn(
      'ComputerUseDaemon crashed',
      { reason },
      LogComponent.ComputerUseDaemon,
    );
    this.health.lastError = reason;
    this.proc = null;
    this.updateHealth({ running: false, pid: null });
    this.scheduleRestart(reason);
  }

  private scheduleRestart(reason: string): void {
    if (this.stopping || this.stopped) return;
    const delay = this.currentBackoffMs;
    this.health.restartCount += 1;
    this.health.nextRestartInMs = delay;
    this.updateHealth({
      restartCount: this.health.restartCount,
      nextRestartInMs: delay,
      lastError: reason,
    });
    // A health listener may have called stop() synchronously (the
    // recorder restart cap does exactly that) — re-check before arming.
    if (this.stopping || this.stopped) return;
    logger.info(
      'ComputerUseDaemon scheduling restart',
      { delayMs: delay, restartCount: this.health.restartCount },
      LogComponent.ComputerUseDaemon,
    );
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null;
      void this.spawnOnce();
    }, delay);
    // Exponentially grow for next time.
    this.currentBackoffMs = Math.min(
      this.opts.backoffMaxMs,
      Math.floor(this.currentBackoffMs * this.opts.backoffMultiplier),
    );
  }

  private resetHeartbeatTimer(): void {
    if (this.heartbeatTimer) clearTimeout(this.heartbeatTimer);
    this.heartbeatTimer = setTimeout(() => {
      logger.warn(
        'ComputerUseDaemon heartbeat timeout',
        { timeoutMs: this.opts.heartbeatTimeoutMs },
        LogComponent.ComputerUseDaemon,
      );
      this.health.lastError = 'heartbeat timeout';
      if (this.proc) {
        try {
          this.proc.kill('SIGTERM');
        } catch {
          // ignore
        }
      }
    }, this.opts.heartbeatTimeoutMs);
  }

  private updateHealth(patch: Partial<ComputerUseHealth>): void {
    this.health = { ...this.health, ...patch };
    for (const listener of this.emitter.listeners('health')) {
      try {
        (listener as ComputerUseDaemonListener)(this.health);
      } catch {
        // swallow listener errors
      }
    }
  }
}

function defaultSpawn(
  cmd: string,
  args: string[],
  opts: { stdio: StdioOptions; env: NodeJS.ProcessEnv; cwd?: string },
): ChildProcess {
  return spawn(cmd, args, opts);
}

let _singleton: ComputerUseDaemon | null = null;

/**
 * Create a standalone daemon instance (not the app singleton) for a
 * second consumer of the same spawn/heartbeat/restart pipeline —
 * currently the plan 556 recorder hook worker.
 */
export function createComputerUseDaemon(
  opts: ComputerUseDaemonOptions,
): ComputerUseDaemon {
  return new ComputerUseDaemonImpl(opts);
}

export function getComputerUseDaemon(): ComputerUseDaemon {
  if (!_singleton) {
    throw new Error(
      'ComputerUseDaemon not initialized; call setComputerUseDaemonOptions first',
    );
  }
  return _singleton;
}

/**
 * Initialize the singleton with the resolved options. Must be called
 * once at app boot (main.ts) before getComputerUseDaemon() works.
 */
export function setComputerUseDaemonOptions(
  opts: ComputerUseDaemonOptions,
): ComputerUseDaemon {
  if (_singleton) {
    throw new Error('ComputerUseDaemon singleton already initialized');
  }
  _singleton = new ComputerUseDaemonImpl(opts);
  return _singleton;
}

/** Test-only: reset the singleton. */
export function __resetComputerUseDaemon(): void {
  _singleton = null;
}