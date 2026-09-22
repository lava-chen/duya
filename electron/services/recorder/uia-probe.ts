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
 *   enumerate(hwnd) → full interactive-element tree with real rects
 *                    (plan 562): 1500ms walk budget inside the probe,
 *                    3s main-side race; partial trees survive budget
 *                    hits (truncated:true). (hwnd,title) caching keeps
 *                    an unchanged application from being re-scanned.
 *
 * Failure policy (design §5 + plan 562 D5):
 *   - per-request timeout   → consecutive counter; LIMIT consecutive
 *                             stalls ⇒ the probe is considered hung:
 *                             recycled once, degraded if it happens again
 *   - probe crash           → the daemon restarts once; a second crash
 *                             ⇒ degraded (element-less recording)
 *   - idle 5min             ⇒ process recycled; next use respawns
 *   - degraded              ⇒ probe()/readUrl() short-circuit, BUT the
 *                             degrade is no longer permanent (562 D5):
 *                             after DEGRADED_RETRY_MS the next call
 *                             respawns the probe instead of short-
 *                             circuiting — a transient UIA stall must
 *                             not disable enumeration for the session.
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
  type EnumeratedElementDescriptor,
  type UiaProbeRequest,
  type UiaProbeResponse,
} from '@duya/computer-use';

const logger = getLogger();

/** Main-side race for probe(): above the probe's internal 200ms budget. */
export const UIA_PROBE_TIMEOUT_MS = 400;
/** Main-side race for readUrl(): the probe's internal budget is 500ms. */
export const UIA_READURL_TIMEOUT_MS = 800;
/**
 * Main-side race for fg(): a warm process answers in ~1ms; the budget
 * only bounds queueing behind an in-flight enumerate (fg is best-effort
 * and does NOT count toward the stall/recycle counter).
 */
export const UIA_FG_TIMEOUT_MS = 1200;
/** Main-side race for enumerate(): the probe's internal walk budget is 1500ms. */
export const UIA_ENUMERATE_TIMEOUT_MS = 3_000;

/**
 * Degraded auto-retry window (plan 562 D5): after this long in the
 * degraded state the next call respawns the probe instead of short-
 * circuiting, so a transient UIA stall cannot disable enumeration for
 * the rest of the session.
 */
export const DEGRADED_RETRY_MS = 60_000;

/** {"ready":true} must arrive within this window (Add-Type compile). */
const READY_TIMEOUT_MS = 15_000;
/** Consecutive timed-out requests before the probe is treated as hung. */
const CONSECUTIVE_TIMEOUT_LIMIT = 3;
/** Idle recycle (design: 5min; next use respawns). */
const IDLE_RECYCLE_MS = 5 * 60_000;

const SCRIPT_BASENAME = 'uia-probe.ps1';

export type UiaProbeState = 'idle' | 'starting' | 'running' | 'degraded';

/** enumerate() outcome — `null` (from the caller's view) is a value, not a throw. */
export interface UiaEnumerateResult {
  elements: EnumeratedElementDescriptor[];
  /** True when a node/time budget hit ended the walk early (partial tree). */
  truncated: boolean;
  /** Success qualifier, e.g. "elevated" (UIPI skip — the window is unreadable). */
  reason: string | null;
}

/** fg() outcome — foreground window snapshot (shape-compatible with ForegroundWindowInfo). */
export interface UiaForegroundInfo {
  hwnd: number;
  pid: number;
  processName: string;
  title: string;
}

/** Cache entry for enumerateCached (plan 562 D5: unchanged app → no re-scan). */
interface EnumerateCacheEntry {
  title: string;
  result: UiaEnumerateResult;
  at: number;
}

export interface UiaProbeClientOptions {
  scriptPath?: string;
  probeTimeoutMs?: number;
  readUrlTimeoutMs?: number;
  fgTimeoutMs?: number;
  enumerateTimeoutMs?: number;
  readyTimeoutMs?: number;
  idleRecycleMs?: number;
  consecutiveTimeoutLimit?: number;
  /** Degraded auto-retry window (plan 562 D5). */
  degradedRetryMs?: number;
  /** Enumerate cache TTL (ms); an older entry is re-scanned. */
  enumerateCacheTtlMs?: number;
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

/** Cache TTL default (plan 562 D5): re-scan after 5min even if unchanged. */
const ENUMERATE_CACHE_TTL_MS = 5 * 60_000;

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
  /** When the client entered the degraded state (0 = never). */
  private degradedAt = 0;
  private readonly enumerateCache = new Map<number, EnumerateCacheEntry>();
  private readonly opts: {
    scriptPath: string;
    probeTimeoutMs: number;
    readUrlTimeoutMs: number;
    fgTimeoutMs: number;
    enumerateTimeoutMs: number;
    readyTimeoutMs: number;
    idleRecycleMs: number;
    consecutiveTimeoutLimit: number;
    degradedRetryMs: number;
    enumerateCacheTtlMs: number;
    spawnFn?: UiaProbeClientOptions['spawnFn'];
  };

  constructor(opts: UiaProbeClientOptions = {}) {
    this.opts = {
      scriptPath: opts.scriptPath ?? resolveUiaProbeScriptPath(),
      probeTimeoutMs: opts.probeTimeoutMs ?? UIA_PROBE_TIMEOUT_MS,
      readUrlTimeoutMs: opts.readUrlTimeoutMs ?? UIA_READURL_TIMEOUT_MS,
      fgTimeoutMs: opts.fgTimeoutMs ?? UIA_FG_TIMEOUT_MS,
      enumerateTimeoutMs: opts.enumerateTimeoutMs ?? UIA_ENUMERATE_TIMEOUT_MS,
      readyTimeoutMs: opts.readyTimeoutMs ?? READY_TIMEOUT_MS,
      idleRecycleMs: opts.idleRecycleMs ?? IDLE_RECYCLE_MS,
      consecutiveTimeoutLimit: opts.consecutiveTimeoutLimit ?? CONSECUTIVE_TIMEOUT_LIMIT,
      degradedRetryMs: opts.degradedRetryMs ?? DEGRADED_RETRY_MS,
      enumerateCacheTtlMs: opts.enumerateCacheTtlMs ?? ENUMERATE_CACHE_TTL_MS,
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
   * Spawn the probe if needed and wait for {"ready":true}. Idempotent.
   * A degraded client short-circuits — but only for DEGRADED_RETRY_MS
   * (plan 562 D5): after that the next call re-arms the lifecycle and
   * tries a fresh spawn, so a transient stall cannot disable the probe
   * for the whole session.
   */
  async ensureStarted(): Promise<void> {
    if (this.state === 'degraded') {
      if (Date.now() - this.degradedAt < this.opts.degradedRetryMs) {
        return;
      }
      // Retry window elapsed: give the probe one more lifecycle.
      this.state = 'idle';
      this.recycledOnce = false;
      this.consecutiveTimeouts = 0;
      logger.info('uia probe degraded retry window elapsed; respawning', undefined, LogComponent.ComputerUse);
    }
    if (this.state === 'running') {
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

  /**
   * Foreground window snapshot via the persistent probe (plan 562
   * phase 5). One line on an already-warm process — replaces the
   * focus tracker's per-poll powershell spawn + Add-Type compile that
   * measured ~3.4s per query and swallowed short-lived foreground
   * states. Best-effort: timeouts do NOT count toward the stall
   * counter (an fg racing an in-flight enumerate must not recycle
   * the probe); callers fall back to the spawn query on null.
   */
  async foreground(): Promise<UiaForegroundInfo | null> {
    const response = await this.request((id) => ({ id, op: 'fg' }), this.opts.fgTimeoutMs, {
      countsTowardStall: false,
    });
    if (response === null || response.kind !== 'response' || !response.ok || !response.fg) {
      return null;
    }
    return response.fg;
  }

  /**
   * Enumerate the interactive-element tree of a window with real
   * BoundingRectangles (plan 562 Phase 1). Never throws: null = the
   * probe could not answer (timeout/degraded), an empty result with
   * reason 'elevated' = UIPI skip, truncated:true = partial tree kept.
   */
  async enumerate(hwnd: number, opts: { maxNodes?: number; maxDepth?: number } = {}): Promise<UiaEnumerateResult | null> {
    const response = await this.request(
      (id) => ({
        id,
        op: 'enumerate',
        hwnd,
        ...(opts.maxNodes !== undefined ? { maxNodes: opts.maxNodes } : {}),
        ...(opts.maxDepth !== undefined ? { maxDepth: opts.maxDepth } : {}),
      }),
      this.opts.enumerateTimeoutMs,
    );
    if (response === null || response.kind !== 'response' || !response.ok) {
      return null;
    }
    return {
      elements: response.elements ?? [],
      truncated: response.truncated,
      reason: response.reason,
    };
  }

  /**
   * enumerate() with the (hwnd, title) cache from plan 562 D5: while
   * the window handle AND title are unchanged, the cached tree is
   * returned without touching the probe. A title change or an expired
   * entry triggers a re-scan. Pass title='' to force a scan.
   */
  async enumerateCached(hwnd: number, title: string, opts: { maxNodes?: number; maxDepth?: number } = {}): Promise<UiaEnumerateResult | null> {
    const cached = this.enumerateCache.get(hwnd);
    const fresh = cached && Date.now() - cached.at < this.opts.enumerateCacheTtlMs;
    if (cached && fresh && cached.title === title && title.length > 0) {
      return cached.result;
    }
    const result = await this.enumerate(hwnd, opts);
    if (result === null) {
      // Keep any previous entry: a failed scan must not flush a good tree.
      return null;
    }
    this.enumerateCache.set(hwnd, { title, result, at: Date.now() });
    if (this.enumerateCache.size > 16) {
      // Bounded: drop the oldest entry (insertion-ordered Map).
      const oldest = this.enumerateCache.keys().next();
      if (!oldest.done) {
        this.enumerateCache.delete(oldest.value);
      }
    }
    return result;
  }

  /** Test/IPC: drop cached enumerate results (e.g. after a forced refresh). */
  clearEnumerateCache(): void {
    this.enumerateCache.clear();
  }

  /** Stop the probe process and tear down timers. */
  async dispose(): Promise<void> {
    if (this.idleTimer) {
      clearInterval(this.idleTimer);
      this.idleTimer = null;
    }
    this.failAllPending('disposed');
    this.enumerateCache.clear();
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
    opts: { countsTowardStall?: boolean } = {},
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
      if (opts.countsTowardStall === false) {
        return response;
      }
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
    this.degradedAt = Date.now();
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
  /** Plan 562: full interactive-tree enumeration with (hwnd,title) caching. */
  enumerate(hwnd: number, title: string): Promise<UiaEnumerateResult | null>;
  /** Plan 562 phase 5: foreground snapshot from the persistent process. */
  foreground(): Promise<UiaForegroundInfo | null>;
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
    enumerate: (hwnd, title) => client.enumerateCached(hwnd, title),
    foreground: () => client.foreground(),
  };
}

/** Test-only: drop the shared client. */
export function __resetSharedUiaProbe(): void {
  _shared = null;
}
