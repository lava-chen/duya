/**
 * services/recorder/uia-probe.ts — UIA point-probe client (plan 556
 * phase 2, design §4.4).
 *
 * Owns the persistent PowerShell probe process (resources/recorder/
 * uia-probe.ps1) through the shared computer-use daemon pipeline and
 * multiplexes JSON-line requests onto it:
 *
 *   probe(x,y)    → ElementDescriptor (200ms budget inside the probe,
 *                    main-side race on top — the "double insurance");
 *                    every failure decodes to { source: 'none' } so the
 *                    recording pipeline is never blocked or thrown at.
 *   readUrl(hwnd) → address-bar value for supported browsers (zh/en
 *                    name match + first-Edit fallback, §4.3).
 *
 * Failure policy (design §5):
 *   - per-request timeout   → consecutive counter; LIMIT consecutive
 *                             stalls ⇒ the probe is considered hung:
 *                             recycled once, degraded if it happens again
 *   - probe crash           → the daemon restarts once; a second crash
 *                             ⇒ degraded (element-less recording)
 *   - idle 5min             ⇒ process recycled; next use respawns
 *   - degraded              ⇒ probe()/readUrl() short-circuit until the
 *                             idle recycle resets the client
 */

import { createComputerUseDaemon, type ComputerUseDaemon } from '../computer-use-daemon.js';
import { getLogger, LogComponent } from '../../logging/logger.js';
import { existsSync } from 'node:fs';
import path from 'node:path';

import {
  buildRequestLine,
  elementToDescriptor,
  parseUiaProbeLine,
  type ElementDescriptor,
  type UiaProbeRequest,
  type UiaProbeResponse,
} from '@duya/computer-use';

const logger = getLogger();

/** Main-side race for probe(): above the probe's internal 200ms budget. */
export const UIA_PROBE_TIMEOUT_MS = 400;
/** Main-side race for readUrl(): the probe's internal budget is 500ms. */
export const UIA_READURL_TIMEOUT_MS = 800;

/** {"ready":true} must arrive within this window (Add-Type compile). */
const READY_TIMEOUT_MS = 15_000;
/** Consecutive timed-out requests before the probe is treated as hung. */
const CONSECUTIVE_TIMEOUT_LIMIT = 3;
/** Idle recycle (design: 5min; next use respawns). */
const IDLE_RECYCLE_MS = 5 * 60_000;

const SCRIPT_BASENAME = 'uia-probe.ps1';

export type UiaProbeState = 'idle' | 'starting' | 'running' | 'degraded';

export interface UiaProbeClientOptions {
  scriptPath?: string;
  probeTimeoutMs?: number;
  readUrlTimeoutMs?: number;
  readyTimeoutMs?: number;
  idleRecycleMs?: number;
  consecutiveTimeoutLimit?: number;
  /** Test hook: forwarded to the daemon spawnFn. */
  spawnFn?: Parameters<typeof createComputerUseDaemon>[0]['spawnFn'];
}

/**
 * Resolve the probe script from the build layout only (packaged
 * `resources/recorder/` vs dev repo `resources/`).
 */
export function resolveUiaProbeScriptPath(): string {
  const isPackaged = !!process.resourcesPath && !process.defaultApp;
  if (isPackaged) {
    const bundled = path.join(process.resourcesPath, 'recorder', SCRIPT_BASENAME);
    if (existsSync(bundled)) return bundled;
  }
  return path.join(process.cwd(), 'resources', 'recorder', SCRIPT_BASENAME);
}

interface PendingRequest {
  resolve: (response: UiaProbeResponse | null) => void;
  timer: NodeJS.Timeout;
}

export class UiaProbeClient {
  private daemon: ComputerUseDaemon | null = null;
  private state: UiaProbeState = 'idle';
  private pending = new Map<number, PendingRequest>();
  private nextId = 1;
  private startInFlight: Promise<void> | null = null;
  private readyWaiters: Array<() => void> = [];
  private recycledOnce = false;
  private consecutiveTimeouts = 0;
  private lastActivityAt = 0;
  private idleTimer: NodeJS.Timeout | null = null;
  private readonly opts: {
    scriptPath: string;
    probeTimeoutMs: number;
    readUrlTimeoutMs: number;
    readyTimeoutMs: number;
    idleRecycleMs: number;
    consecutiveTimeoutLimit: number;
    spawnFn?: UiaProbeClientOptions['spawnFn'];
  };

  constructor(opts: UiaProbeClientOptions = {}) {
    this.opts = {
      scriptPath: opts.scriptPath ?? resolveUiaProbeScriptPath(),
      probeTimeoutMs: opts.probeTimeoutMs ?? UIA_PROBE_TIMEOUT_MS,
      readUrlTimeoutMs: opts.readUrlTimeoutMs ?? UIA_READURL_TIMEOUT_MS,
      readyTimeoutMs: opts.readyTimeoutMs ?? READY_TIMEOUT_MS,
      idleRecycleMs: opts.idleRecycleMs ?? IDLE_RECYCLE_MS,
      consecutiveTimeoutLimit: opts.consecutiveTimeoutLimit ?? CONSECUTIVE_TIMEOUT_LIMIT,
      spawnFn: opts.spawnFn,
    };
  }

  get currentState(): UiaProbeState {
    return this.state;
  }

  get isDegraded(): boolean {
    return this.state === 'degraded';
  }

  /**
   * Spawn the probe if needed and wait for {"ready":true}. Idempotent;
   * a degraded client returns immediately (callers get source:'none').
   */
  async ensureStarted(): Promise<void> {
    if (this.state === 'degraded' || this.state === 'running') {
      return;
    }
    if (this.startInFlight) {
      await this.startInFlight;
      return;
    }
    this.startInFlight = this.doStart();
    try {
      await this.startInFlight;
    } finally {
      this.startInFlight = null;
    }
  }

  /** Resolve the UIA element under a screen point. Never throws. */
  async probe(x: number, y: number): Promise<ElementDescriptor> {
    const response = await this.request((id) => ({ id, op: 'probe', x, y }), this.opts.probeTimeoutMs);
    if (response === null || response.kind !== 'response' || !response.ok) {
      return { source: 'none' };
    }
    return elementToDescriptor(response.element);
  }

  /** Read the address-bar value of a browser window. Never throws. */
  async readUrl(hwnd: number): Promise<string | null> {
    const response = await this.request((id) => ({ id, op: 'readUrl', hwnd }), this.opts.readUrlTimeoutMs);
    if (response === null || response.kind !== 'response' || !response.ok) {
      return null;
    }
    return response.url;
  }

  /** Stop the probe process and tear down timers. */
  async dispose(): Promise<void> {
    if (this.idleTimer) {
      clearInterval(this.idleTimer);
      this.idleTimer = null;
    }
    this.failAllPending('disposed');
    await this.stopDaemon();
    this.state = 'idle';
  }

  // --- internals ----------------------------------------------------------

  private async doStart(): Promise<void> {
    if (!existsSync(this.opts.scriptPath)) {
      logger.warn('uia probe script not found', { path: this.opts.scriptPath }, LogComponent.ComputerUse);
      this.state = 'degraded';
      return;
    }
    this.state = 'starting';
    const readyPromise = new Promise<void>((resolve) => {
      this.readyWaiters.push(resolve);
    });
    const daemon = createComputerUseDaemon({
      runtime: 'powershell.exe',
      entry: this.opts.scriptPath,
      args: ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', this.opts.scriptPath],
      stdio: ['pipe', 'pipe', 'pipe'],
      // The probe cannot emit heartbeats while blocked on stdin ReadLine;
      // liveness is per-request timeouts + the idle recycle instead.
      heartbeatTimeoutMs: 2 ** 31 - 1,
      onStdoutLine: (line) => this.handleLine(line),
      spawnFn: this.opts.spawnFn,
    });
    this.daemon = daemon;
    // Crash policy: the daemon restarts once on its own; the second
    // crash ends in a permanent degrade for this client lifetime.
    let seenRestarts = 0;
    daemon.onHealth((health) => {
      if (!this.daemon || health.restartCount <= seenRestarts) {
        return;
      }
      seenRestarts = health.restartCount;
      if (health.restartCount >= 2) {
        void this.handleFatal('uia probe restart budget spent');
      }
    });
    await daemon.start();
    this.lastActivityAt = Date.now();
    this.armIdleRecycle();

    const timeout = new Promise<never>((_, reject) => {
      const t = setTimeout(() => reject(new Error('ready timeout')), this.opts.readyTimeoutMs);
      t.unref?.();
    });
    try {
      await Promise.race([readyPromise, timeout]);
    } catch {
      // Treat a ready failure as a stall: one respawn allowed, then
      // degrade — a probe that cannot compile is not coming back.
      await this.recycleOnStall();
      return;
    }
    if (this.daemon !== daemon) {
      return; // fatal path already tore this instance down
    }
    this.state = 'running';
    logger.info('uia probe ready', undefined, LogComponent.ComputerUse);
  }

  private handleLine(line: string): void {
    const parsed = parseUiaProbeLine(line);
    if (parsed === null) {
      logger.debug('uia probe unparseable line', { line: line.slice(0, 200) }, LogComponent.ComputerUse);
      return;
    }
    if (parsed.kind === 'ready') {
      const waiters = this.readyWaiters;
      this.readyWaiters = [];
      for (const resolve of waiters) {
        resolve();
      }
      return;
    }
    const pending = this.pending.get(parsed.id);
    if (!pending) {
      return;
    }
    this.pending.delete(parsed.id);
    clearTimeout(pending.timer);
    this.consecutiveTimeouts = 0;
    this.lastActivityAt = Date.now();
    pending.resolve(parsed);
  }

  private async request(
    build: (id: number) => UiaProbeRequest,
    timeoutMs: number,
  ): Promise<UiaProbeResponse | null> {
    await this.ensureStarted();
    if (this.state !== 'running' || !this.daemon) {
      return null;
    }
    const id = this.nextId++;
    const response = await new Promise<UiaProbeResponse | null>((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        resolve(null);
      }, timeoutMs);
      timer.unref?.();
      this.pending.set(id, { resolve, timer });
      const written = this.daemon?.writeStdin?.(buildRequestLine(build(id)) + '\n') ?? false;
      if (!written) {
        this.pending.delete(id);
        clearTimeout(timer);
        resolve(null);
      }
    });
    if (response === null) {
      this.consecutiveTimeouts += 1;
      logger.debug(
        'uia probe request timed out',
        { consecutive: this.consecutiveTimeouts },
        LogComponent.ComputerUse,
      );
      if (this.consecutiveTimeouts >= this.opts.consecutiveTimeoutLimit) {
        await this.recycleOnStall();
      }
    }
    return response;
  }

  /**
   * The probe looks hung (consecutive timeouts / never became ready).
   * Recycle once; the second stall degrades the client for good —
   * element-less recording is the designed fallback (design §5).
   */
  private async recycleOnStall(): Promise<void> {
    this.consecutiveTimeouts = 0;
    this.failAllPending('recycled');
    await this.stopDaemon();
    if (this.recycledOnce) {
      await this.handleFatal('uia probe stalled twice');
      return;
    }
    this.recycledOnce = true;
    this.state = 'idle';
    logger.warn('uia probe stalled; recycled once', undefined, LogComponent.ComputerUse);
  }

  private async handleFatal(reason: string): Promise<void> {
    this.failAllPending(reason);
    await this.stopDaemon();
    this.state = 'degraded';
    logger.warn('uia probe degraded; element-less recording', { reason }, LogComponent.ComputerUse);
  }

  private failAllPending(reason: string): void {
    for (const [, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.resolve({ kind: 'response', id: -1, ok: false, reason });
    }
    this.pending.clear();
  }

  private async stopDaemon(): Promise<void> {
    const daemon = this.daemon;
    this.daemon = null;
    this.readyWaiters = [];
    if (daemon) {
      await daemon.stop().catch(() => undefined);
    }
    if (this.idleTimer) {
      clearInterval(this.idleTimer);
      this.idleTimer = null;
    }
  }

  private armIdleRecycle(): void {
    if (this.idleTimer) {
      return;
    }
    // Check at half the idle budget (bounded) so a short test budget or
    // a short production budget both recycle promptly after the idle
    // threshold, not a fixed 30s later.
    const checkEveryMs = Math.min(30_000, Math.max(100, Math.floor(this.opts.idleRecycleMs / 2)));
    this.idleTimer = setInterval(() => {
      if (this.state !== 'running' || !this.daemon) {
        return;
      }
      if (Date.now() - this.lastActivityAt < this.opts.idleRecycleMs) {
        return;
      }
      logger.info('uia probe idle; recycling', undefined, LogComponent.ComputerUse);
      this.consecutiveTimeouts = 0;
      this.recycledOnce = false;
      void this.stopDaemon().then(() => {
        this.state = 'idle';
      });
    }, checkEveryMs);
    this.idleTimer.unref?.();
  }
}

// --- shared adapter for the recorder service ------------------------------

export interface RecorderProbeAdapter {
  at(x: number, y: number): Promise<ElementDescriptor>;
  warmup(): Promise<void>;
  readUrl(hwnd: number): Promise<string | null>;
}

let _shared: UiaProbeClient | null = null;

/**
 * Probe adapter for `RecorderServiceOptions.probe`: lazily starts the
 * shared client on first use; warmup() is called by the service at
 * recording start so the (slow, first-time Add-Type) spawn lands
 * outside the click-attach budget.
 */
export function createSharedUiaProbeAdapter(): RecorderProbeAdapter {
  if (!_shared) {
    _shared = new UiaProbeClient();
  }
  const client = _shared;
  return {
    at: (x, y) => client.probe(x, y),
    warmup: () => client.ensureStarted(),
    readUrl: (hwnd) => client.readUrl(hwnd),
  };
}

/** Test-only: drop the shared client. */
export function __resetSharedUiaProbe(): void {
  _shared = null;
}
