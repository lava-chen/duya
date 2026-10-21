/**
 * services/recorder/ax-helper.ts — macOS AX helper client (plan 572).
 *
 * Owns the persistent Swift helper process (resources/ax-helper/) through
 * the shared computer-use daemon pipeline and multiplexes JSON-line
 * requests onto it. Mirrors the UiaProbeClient failure policy:
 *
 *   - per-request timeout   → consecutive counter; LIMIT consecutive
 *                             stalls ⇒ recycled once, then degraded
 *   - helper crash          → the daemon restarts once; a second crash
 *                             ⇒ degraded (until the retry window elapses)
 *   - idle 5min             ⇒ process recycled; next use respawns
 *   - degraded              ⇒ calls short-circuit, but after
 *                             DEGRADED_RETRY_MS the next call respawns
 *
 * The helper itself bounds every AX call with
 * AXUIElementSetMessagingTimeout (0.5s global at startup), so a wedged
 * target app cannot hang the helper — the main-side races are queue
 * insurance, not the primary defense.
 *
 * Ops: probe(x,y) / enumerate(pid) / action / setValue / readUrl /
 * fg / apps / windows / permissions / secureInput / manualAccessibility /
 * keyToPid / scrollToPid / activate / screenshotWindow.
 */

import { createComputerUseDaemon, type ComputerUseDaemon } from '../computer-use-daemon.js';
import { getLogger, LogComponent } from '../../logging/logger.js';
import { existsSync } from 'node:fs';
import path from 'node:path';

import {
  axElementToDescriptor,
  axEnumeratedToDescriptor,
  buildAxRequestLine,
  parseAxHelperLine,
  type AxForegroundInfo,
  type AxAppInfo,
  type AxEnumeratedElement,
  type AxHelperErrorCode,
  type AxHelperRequest,
  type AxHelperResponse,
  type AxPermissionSnapshot,
  type AxWindowInfo,
  type ElementDescriptor,
} from '@duya/computer-use';

const logger = getLogger();

/** Main-side race for probe(). The helper's own budget is 0.5s (messaging timeout). */
export const AX_PROBE_TIMEOUT_MS = 900;
/** Main-side race for readUrl() — osascript inside the helper gets 2s. */
export const AX_READURL_TIMEOUT_MS = 3_000;
/** Main-side race for fg() — best-effort, never counts toward stalls. */
export const AX_FG_TIMEOUT_MS = 1_200;
/** Main-side race for enumerate() — the helper's walk budget is 1.5s. */
export const AX_ENUMERATE_TIMEOUT_MS = 3_000;
/** Main-side race for action / setValue / activate / key / scroll / secureInput. */
export const AX_ACTION_TIMEOUT_MS = 1_500;
/** Main-side race for permissions / apps / windows / manualAccessibility. */
export const AX_QUERY_TIMEOUT_MS = 1_500;

/** Degraded auto-retry window (plan 562 D5 semantics). */
export const AX_DEGRADED_RETRY_MS = 60_000;
/** {"ready":true} must arrive within this window. */
const READY_TIMEOUT_MS = 10_000;
/** Consecutive timed-out requests before the helper is treated as hung. */
const CONSECUTIVE_TIMEOUT_LIMIT = 3;
/** Idle recycle: 5min. */
const IDLE_RECYCLE_MS = 5 * 60_000;

const HELPER_BASENAME = 'ax-helper';

export type AxHelperState = 'idle' | 'starting' | 'running' | 'degraded';

export interface AxEnumerateResult {
  elements: AxEnumeratedElement[];
  truncated: boolean;
  reason: string | null;
}

/**
 * Resolve the helper binary from the build layout: packaged
 * `resources/ax-helper/ax-helper`, dev repo `resources/ax-helper/bin/`.
 */
export function resolveAxHelperPath(): string {
  const basename =
    process.platform === 'win32' ? `${HELPER_BASENAME}.exe` : HELPER_BASENAME;
  const isPackaged = !!process.resourcesPath && !process.defaultApp;
  if (isPackaged) {
    const bundled = path.join(process.resourcesPath, 'ax-helper', basename);
    if (existsSync(bundled)) return bundled;
  }
  const devCandidates = [
    path.join(process.cwd(), 'resources', 'ax-helper', 'bin', basename),
    path.join(process.cwd(), 'resources', 'ax-helper', basename),
  ];
  for (const candidate of devCandidates) {
    if (existsSync(candidate)) return candidate;
  }
  return devCandidates[0]!;
}

interface PendingRequest {
  resolve: (response: AxHelperResponse | null) => void;
  timer: NodeJS.Timeout;
}

export class AxHelperClient {
  private daemon: ComputerUseDaemon | null = null;
  private state: AxHelperState = 'idle';
  private pending = new Map<number, PendingRequest>();
  private nextId = 1;
  private startInFlight: Promise<void> | null = null;
  private readyWaiters: Array<() => void> = [];
  private recycledOnce = false;
  private consecutiveTimeouts = 0;
  private lastActivityAt = 0;
  private idleTimer: NodeJS.Timeout | null = null;
  private degradedAt = 0;
  /** (pid) → enumerate snapshot cache keyed by pid; title dedupe is the caller's job. */
  private readonly enumerateCache = new Map<number, { result: AxEnumerateResult; at: number }>();
  private readonly opts: {
    helperPath: string;
    probeTimeoutMs: number;
    readUrlTimeoutMs: number;
    fgTimeoutMs: number;
    enumerateTimeoutMs: number;
    actionTimeoutMs: number;
    queryTimeoutMs: number;
    readyTimeoutMs: number;
    idleRecycleMs: number;
    consecutiveTimeoutLimit: number;
    degradedRetryMs: number;
    enumerateCacheTtlMs: number;
    spawnFn?: Parameters<typeof createComputerUseDaemon>[0]['spawnFn'];
  };

  constructor(opts: Partial<Record<string, unknown>> = {}) {
    this.opts = {
      helperPath: (opts.helperPath as string) ?? resolveAxHelperPath(),
      probeTimeoutMs: (opts.probeTimeoutMs as number) ?? AX_PROBE_TIMEOUT_MS,
      readUrlTimeoutMs: (opts.readUrlTimeoutMs as number) ?? AX_READURL_TIMEOUT_MS,
      fgTimeoutMs: (opts.fgTimeoutMs as number) ?? AX_FG_TIMEOUT_MS,
      enumerateTimeoutMs: (opts.enumerateTimeoutMs as number) ?? AX_ENUMERATE_TIMEOUT_MS,
      actionTimeoutMs: (opts.actionTimeoutMs as number) ?? AX_ACTION_TIMEOUT_MS,
      queryTimeoutMs: (opts.queryTimeoutMs as number) ?? AX_QUERY_TIMEOUT_MS,
      readyTimeoutMs: (opts.readyTimeoutMs as number) ?? READY_TIMEOUT_MS,
      idleRecycleMs: (opts.idleRecycleMs as number) ?? IDLE_RECYCLE_MS,
      consecutiveTimeoutLimit: (opts.consecutiveTimeoutLimit as number) ?? CONSECUTIVE_TIMEOUT_LIMIT,
      degradedRetryMs: (opts.degradedRetryMs as number) ?? AX_DEGRADED_RETRY_MS,
      enumerateCacheTtlMs: (opts.enumerateCacheTtlMs as number) ?? 5 * 60_000,
      spawnFn: opts.spawnFn as Parameters<typeof createComputerUseDaemon>[0]['spawnFn'],
    };
  }

  get currentState(): AxHelperState {
    return this.state;
  }

  get isDegraded(): boolean {
    return this.state === 'degraded';
  }

  /** Spawn the helper if needed and wait for {"ready":true}. Idempotent. */
  async ensureStarted(): Promise<void> {
    if (this.state === 'degraded') {
      if (Date.now() - this.degradedAt < this.opts.degradedRetryMs) {
        return;
      }
      this.state = 'idle';
      this.recycledOnce = false;
      this.consecutiveTimeouts = 0;
      logger.info('ax helper degraded retry window elapsed; respawning', undefined, LogComponent.ComputerUse);
    }
    if (this.state === 'running') return;
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

  /** Resolve the AX element under a global screen point. Never throws. */
  async probe(x: number, y: number): Promise<ElementDescriptor> {
    const response = await this.request((id) => ({ id, op: 'probe', x, y }), this.opts.probeTimeoutMs);
    if (response === null || response.kind !== 'response' || !response.ok) {
      return { source: 'none' };
    }
    return axElementToDescriptor(response.data.element);
  }

  /**
   * Enumerate the interactive-element tree of an app (AXUIElementCreate-
   * Application(pid) walk). Never throws; null = the helper could not
   * answer, empty elements + reason = readable skip.
   */
  async enumerate(
    pid: number,
    opts: { maxNodes?: number; maxDepth?: number; roles?: string[] } = {},
  ): Promise<AxEnumerateResult | null> {
    const response = await this.request(
      (id) => ({
        id,
        op: 'enumerate',
        pid,
        ...(opts.maxNodes !== undefined ? { maxNodes: opts.maxNodes } : {}),
        ...(opts.maxDepth !== undefined ? { maxDepth: opts.maxDepth } : {}),
        ...(opts.roles !== undefined ? { roles: opts.roles } : {}),
      }),
      this.opts.enumerateTimeoutMs,
    );
    if (response === null || response.kind !== 'response' || !response.ok) {
      return null;
    }
    return {
      elements: response.data.elements ?? [],
      truncated: response.data.truncated,
      reason: response.data.reason,
    };
  }

  /** enumerate() with a pid cache: unchanged app within TTL → cached tree. */
  async enumerateCached(pid: number, title: string, opts: { maxNodes?: number; maxDepth?: number } = {}): Promise<AxEnumerateResult | null> {
    const cached = this.enumerateCache.get(pid);
    const fresh = cached && Date.now() - cached.at < this.opts.enumerateCacheTtlMs;
    if (cached && fresh && title.length > 0) {
      return cached.result;
    }
    const result = await this.enumerate(pid, opts);
    if (result === null) {
      return null;
    }
    this.enumerateCache.set(pid, { result, at: Date.now() });
    if (this.enumerateCache.size > 16) {
      const oldest = this.enumerateCache.keys().next();
      if (!oldest.done) this.enumerateCache.delete(oldest.value);
    }
    return result;
  }

  /** Test/IPC: drop cached enumerate results. */
  clearEnumerateCache(): void {
    this.enumerateCache.clear();
  }

  /** Perform an AX action on a snapshot handle. Returns the error code or null on success. */
  async performAction(pid: number, handle: string, action: string): Promise<AxHelperErrorCode | null> {
    const response = await this.request(
      (id) => ({ id, op: 'action', pid, handle, action }),
      this.opts.actionTimeoutMs,
    );
    if (response === null) return 'timeout';
    if (response.kind !== 'response' || !response.ok) {
      return (response as { error?: AxHelperError }).error?.code ?? 'error';
    }
    return response.data.performed ? null : 'error';
  }

  /** AX-set the value of a snapshot handle. null on success. */
  async setValue(pid: number, handle: string, value: string): Promise<AxHelperErrorCode | null> {
    const response = await this.request(
      (id) => ({ id, op: 'setValue', pid, handle, value }),
      this.opts.actionTimeoutMs,
    );
    if (response === null) return 'timeout';
    if (response.kind !== 'response' || !response.ok) {
      return (response as { error?: AxHelperError }).error?.code ?? 'error';
    }
    return response.data.set ? null : 'not-settable';
  }

  /** Set AXManualAccessibility on a (Chromium/Electron) app so it builds its tree. */
  async manualAccessibility(pid: number): Promise<boolean> {
    const response = await this.request(
      (id) => ({ id, op: 'manualAccessibility', pid }),
      this.opts.queryTimeoutMs,
    );
    return response !== null && response.kind === 'response' && response.ok && response.data.manualAccessibility === true;
  }

  /** Read the active-tab URL via the per-browser AppleScript dictionary. */
  async readUrl(pid: number, app: string): Promise<string | null> {
    const response = await this.request(
      (id) => ({ id, op: 'readUrl', pid, app }),
      this.opts.readUrlTimeoutMs,
    );
    if (response === null || response.kind !== 'response' || !response.ok) {
      return null;
    }
    return response.data.url;
  }

  /** Foreground snapshot (NSWorkspace + CGWindowList). Best-effort. */
  async foreground(): Promise<AxForegroundInfo | null> {
    const response = await this.request((id) => ({ id, op: 'fg' }), this.opts.fgTimeoutMs, {
      countsTowardStall: false,
    });
    if (response === null || response.kind !== 'response' || !response.ok) {
      return null;
    }
    return response.data.fg;
  }

  /** Running regular apps (NSWorkspace.runningApplications). */
  async apps(): Promise<AxAppInfo[]> {
    const response = await this.request((id) => ({ id, op: 'apps' }), this.opts.queryTimeoutMs);
    if (response === null || response.kind !== 'response' || !response.ok) {
      return [];
    }
    return response.data.apps ?? [];
  }

  /** On-screen layer-0 windows of one pid. */
  async windows(pid: number): Promise<AxWindowInfo[]> {
    const response = await this.request((id) => ({ id, op: 'windows', pid }), this.opts.queryTimeoutMs);
    if (response === null || response.kind !== 'response' || !response.ok) {
      return [];
    }
    return response.data.windows ?? [];
  }

  /** TCC + Secure Input snapshot. null = helper unavailable. */
  async permissions(): Promise<AxPermissionSnapshot | null> {
    const response = await this.request((id) => ({ id, op: 'permissions' }), this.opts.queryTimeoutMs);
    if (response === null || response.kind !== 'response' || !response.ok) {
      return null;
    }
    return response.data.permissions;
  }

  /** Secure Input state (kCGSSessionSecureInputPID). */
  async secureInput(): Promise<{ enabled: boolean; pid: number | null } | null> {
    const response = await this.request((id) => ({ id, op: 'secureInput' }), this.opts.queryTimeoutMs);
    if (response === null || response.kind !== 'response' || !response.ok) {
      return null;
    }
    return response.data.secureInput;
  }

  /** Post a keyboard event (kVK code + flags) to one pid without activation. */
  async keyToPid(pid: number, vk: number, flags: string[] = []): Promise<boolean> {
    const response = await this.request(
      (id) => ({ id, op: 'keyToPid', pid, vk, flags }),
      this.opts.actionTimeoutMs,
    );
    return response !== null && response.kind === 'response' && response.ok && response.data.performed === true;
  }

  /** Post a scroll gesture to one pid without activation. */
  async scrollToPid(pid: number, ticks: number, direction: 'up' | 'down'): Promise<boolean> {
    const response = await this.request(
      (id) => ({ id, op: 'scrollToPid', pid, ticks, direction }),
      this.opts.actionTimeoutMs,
    );
    return response !== null && response.kind === 'response' && response.ok && response.data.performed === true;
  }

  /** Activate (foreground) an app — NSRunningApplication.activate + AXRaise. */
  async activate(pid: number): Promise<boolean> {
    const response = await this.request((id) => ({ id, op: 'activate', pid }), this.opts.actionTimeoutMs);
    return response !== null && response.kind === 'response' && response.ok && response.data.activated === true;
  }

  /** ScreenCaptureKit single-window capture (macOS 14+; null otherwise). */
  async screenshotWindow(windowId: number): Promise<{ png: string; width: number; height: number } | null> {
    const response = await this.request(
      (id) => ({ id, op: 'screenshotWindow', windowId }),
      5_000,
    );
    if (response === null || response.kind !== 'response' || !response.ok) {
      return null;
    }
    if (!response.data.png) return null;
    return {
      png: response.data.png,
      width: response.data.width ?? 0,
      height: response.data.height ?? 0,
    };
  }

  /** Stop the helper process and tear down timers. */
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
    if (!existsSync(this.opts.helperPath)) {
      logger.warn('ax helper binary not found', { path: this.opts.helperPath }, LogComponent.ComputerUse);
      this.state = 'degraded';
      return;
    }
    this.state = 'starting';
    const readyPromise = new Promise<void>((resolve) => {
      this.readyWaiters.push(resolve);
    });
    const daemon = createComputerUseDaemon({
      runtime: this.opts.helperPath,
      entry: '',
      args: [],
      stdio: ['pipe', 'pipe', 'pipe'],
      // The helper emits {"type":"heartbeat"} every 30s from its own
      // timer — the standard dead-man applies.
      onStdoutLine: (line) => this.handleLine(line),
      spawnFn: this.opts.spawnFn,
    });
    this.daemon = daemon;
    let seenRestarts = 0;
    daemon.onHealth((health) => {
      if (!this.daemon || health.restartCount <= seenRestarts) {
        return;
      }
      seenRestarts = health.restartCount;
      if (health.restartCount >= 2) {
        void this.handleFatal('ax helper restart budget spent');
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
      await this.recycleOnStall();
      return;
    }
    if (this.daemon !== daemon) {
      return;
    }
    this.state = 'running';
    logger.info('ax helper ready', undefined, LogComponent.ComputerUse);
  }

  private handleLine(line: string): void {
    const parsed = parseAxHelperLine(line);
    if (parsed === null) {
      logger.debug('ax helper unparseable line', { line: line.slice(0, 200) }, LogComponent.ComputerUse);
      return;
    }
    if (parsed.kind === 'ready') {
      const waiters = this.readyWaiters;
      this.readyWaiters = [];
      for (const resolve of waiters) resolve();
      return;
    }
    if (parsed.kind === 'heartbeat') {
      return;
    }
    const pending = this.pending.get(parsed.id);
    if (!pending) return;
    this.pending.delete(parsed.id);
    clearTimeout(pending.timer);
    this.consecutiveTimeouts = 0;
    this.lastActivityAt = Date.now();
    pending.resolve(parsed);
  }

  private async request(
    build: (id: number) => AxHelperRequest,
    timeoutMs: number,
    opts: { countsTowardStall?: boolean } = {},
  ): Promise<AxHelperResponse | null> {
    await this.ensureStarted();
    if (this.state !== 'running' || !this.daemon) {
      return null;
    }
    const id = this.nextId++;
    const response = await new Promise<AxHelperResponse | null>((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        resolve(null);
      }, timeoutMs);
      timer.unref?.();
      this.pending.set(id, { resolve, timer });
      const written = this.daemon?.writeStdin?.(buildAxRequestLine(build(id)) + '\n') ?? false;
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
        'ax helper request timed out',
        { consecutive: this.consecutiveTimeouts },
        LogComponent.ComputerUse,
      );
      if (this.consecutiveTimeouts >= this.opts.consecutiveTimeoutLimit) {
        await this.recycleOnStall();
      }
    }
    return response;
  }

  private async recycleOnStall(): Promise<void> {
    this.consecutiveTimeouts = 0;
    this.failAllPending('recycled');
    await this.stopDaemon();
    if (this.recycledOnce) {
      await this.handleFatal('ax helper stalled twice');
      return;
    }
    this.recycledOnce = true;
    this.state = 'idle';
    logger.warn('ax helper stalled; recycled once', undefined, LogComponent.ComputerUse);
  }

  private async handleFatal(reason: string): Promise<void> {
    this.failAllPending(reason);
    await this.stopDaemon();
    this.state = 'degraded';
    this.degradedAt = Date.now();
    logger.warn('ax helper degraded', { reason }, LogComponent.ComputerUse);
  }

  private failAllPending(reason: string): void {
    for (const [, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.resolve({ kind: 'response', id: -1, ok: false, error: { code: 'error', message: reason } });
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
    if (this.idleTimer) return;
    const checkEveryMs = Math.min(30_000, Math.max(100, Math.floor(this.opts.idleRecycleMs / 2)));
    this.idleTimer = setInterval(() => {
      if (this.state !== 'running' || !this.daemon) return;
      if (Date.now() - this.lastActivityAt < this.opts.idleRecycleMs) return;
      logger.info('ax helper idle; recycling', undefined, LogComponent.ComputerUse);
      this.consecutiveTimeouts = 0;
      this.recycledOnce = false;
      void this.stopDaemon().then(() => {
        this.state = 'idle';
      });
    }, checkEveryMs);
    this.idleTimer.unref?.();
  }
}

// --- shared singletons ------------------------------------------------------

let _sharedHelper: AxHelperClient | null = null;

/** Shared helper client for the Electron main process (lazy). */
export function getSharedAxHelperClient(): AxHelperClient {
  if (!_sharedHelper) {
    _sharedHelper = new AxHelperClient();
  }
  return _sharedHelper;
}

/** Test-only: drop the shared client. */
export function __resetSharedAxHelper(): void {
  _sharedHelper = null;
}

/**
 * Recorder probe adapter surface subset the mac adapter satisfies
 * (shape-compatible with RecorderProbeAdapter in uia-probe.ts).
 */
export interface AxRecorderProbeAdapter {
  at(x: number, y: number): Promise<ElementDescriptor>;
  warmup(): Promise<void>;
  readUrl(hwndOrPid: number): Promise<string | null>;
  enumerate(hwndOrPid: number, title: string): Promise<AxEnumerateResult | null>;
  foreground(): Promise<AxForegroundInfo | null>;
}

let _sharedAdapter: AxRecorderProbeAdapter | null = null;

/**
 * Recorder probe adapter for macOS: backs the RecorderService's
 * `probe` option with the AX helper instead of the PowerShell UIA
 * probe. `readUrl`/`enumerate` receive the recorder's current
 * "hwnd" slot, which on macOS carries the window id — the adapter
 * resolves the owning pid from the latest fg snapshot.
 */
export function createSharedAxRecorderAdapter(): AxRecorderProbeAdapter {
  if (!_sharedAdapter) {
    const client = getSharedAxHelperClient();
    let lastFg: AxForegroundInfo | null = null;
    _sharedAdapter = {
      at: (x, y) => client.probe(x, y),
      warmup: () => client.ensureStarted(),
      readUrl: async () => {
        const pid = lastFg?.pid;
        if (!pid) return null;
        return client.readUrl(pid, lastFg?.processName ?? '');
      },
      enumerate: async (_hwnd, title) => {
        const pid = lastFg?.pid;
        if (!pid) return null;
        return client.enumerateCached(pid, title);
      },
      foreground: async () => {
        const fg = await client.foreground();
        lastFg = fg;
        return fg;
      },
    };
  }
  return _sharedAdapter;
}

/** Test-only: drop the shared adapter. */
export function __resetSharedAxAdapter(): void {
  _sharedAdapter = null;
}
