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
 *                    (plan 562): warm walks run 1500ms inside the probe
 *                    with a 3s main-side race; a window's FIRST scan
 *                    (cache miss) runs the cold tier instead — 8s walk
 *                    / 10s race — because the first UIA touch of a
 *                    Chromium/Electron window also spins up its
 *                    accessibility engine. Partial trees survive budget
 *                    hits (truncated:true). (hwnd,title) caching keeps
 *                    an unchanged application from being re-scanned.
 *   invoke(hwnd, i)  → structural act op (plan 564): resolve a 1-based
 *                    element from the probe's last enumerate cache for
 *                    the hwnd and dispatch a UIA pattern (Invoke /
 *                    Toggle / ExpandCollapse / SelectionItem / Value /
 *                    SetFocus). A `stale-tree` answer triggers ONE
 *                    auto-recovery (fresh enumerate + retry) before the
 *                    error is surfaced — the caller re-runs tree when it
 *                    still fails.
 *
 * Failure policy (design §5 + plan 562 D5, perf-fixed):
 *   - global-op timeout     → consecutive counter; LIMIT consecutive
 *                             stalls ⇒ the probe is considered hung:
 *                             recycled once, degraded if it happens again
 *   - target-op timeout     → per-hwnd counter; LIMIT stalls on the SAME
 *                             hwnd ⇒ that window is QUARANTINED for
 *                             UIA_TARGET_QUARANTINE_MS (reason
 *                             'target-unresponsive') instead of recycling
 *                             the process — one heavy target must not
 *                             take the shared probe down
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
 * Cold-window enumerate tier: the FIRST scan of a hwnd must absorb UIA
 * COM activation plus the target's own accessibility-engine spin-up
 * (Chromium/Electron start their renderer a11y lazily — 1-3s alone), so
 * the walk budget and the main-side race both widen for cache-miss
 * scans. Warm re-scans keep the tight budgets above.
 */
export const UIA_ENUMERATE_COLD_TOTAL_MS = 8_000;
export const UIA_ENUMERATE_COLD_TIMEOUT_MS = 10_000;
/** Main-side race for invoke(): the probe's internal budget is 1000ms. */
export const UIA_INVOKE_TIMEOUT_MS = 2_500;

/**
 * Quarantine for a window whose structural requests keep timing out
 * (plan 562 perf fix): after LIMIT consecutive timeouts on the SAME
 * hwnd the client stops walking that window for the cooldown window
 * and answers with reason 'target-unresponsive' instead. One heavy or
 * wedged target must not recycle the probe (and take every other
 * application's structural channel down with it) — the process-wide
 * recycle stays reserved for global-op stalls and crash budgets.
 */
export const UIA_TARGET_QUARANTINE_MS = 60_000;
/** Stable reason string for a quarantined target (mirrors the renderer hint). */
export const UIA_TARGET_UNRESPONSIVE = 'target-unresponsive';

/**
 * Stable invoke failure reasons the probe can return (mirrored in
 * packages/computer-use uia-probe-protocol.ts UIA_INVOKE_FAILURE_REASONS).
 * Duplicated as string literals here so the electron tree does not have
 * to import the package at module-load time in tests.
 */
export const UIA_INVOKE_ERRORS = {
  STALE_TREE: 'stale-tree',
  NO_ELEMENT: 'no-element',
  NO_PATTERN: 'no-pattern',
  BAD_INDEX: 'bad-index',
  NO_WINDOW: 'no-window',
} as const;

/** Structural methods the probe's invoke op understands. */
export type UiaInvokeMethod =
  | 'auto'
  | 'invoke'
  | 'toggle'
  | 'expand'
  | 'collapse'
  | 'select'
  | 'focus'
  | 'setValue';

/** invoke() outcome — `null` means the probe could not answer at all. */
export interface UiaInvokeOutcome {
  /** True when the structural action dispatched successfully. */
  ok: boolean;
  /** Failure reason (stale-tree / no-element / no-pattern / ...). */
  reason?: string;
  /** The structural method that actually ran (auto may downgrade to focus). */
  method?: string;
  /** UIA pattern used ("InvokePattern", null for SetFocus). */
  pattern?: string | null;
  /** ValuePattern read-back after setValue (null otherwise). */
  value?: string | null;
  /** Post-action element JSON (provenance stamped downstream). */
  element?: ElementDescriptor | null;
}

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
  /**
   * Per-entry TTL override. Empty trees get a SHORT one: an empty scan is
   * exactly the transient case — a minimized / mid-restore window reports
   * every element offscreen (and a minimized subtree is walked without
   * offscreen pruning since plan 576, but restore races still exist) —
   * and caching that emptiness for the full TTL pinned the recorder
   * overlay to "no frames" after the window came back (2026-09-29 bug).
   */
  ttlMs?: number;
}

export interface UiaProbeClientOptions {
  scriptPath?: string;
  probeTimeoutMs?: number;
  readUrlTimeoutMs?: number;
  fgTimeoutMs?: number;
  enumerateTimeoutMs?: number;
  /** Cold-window walk budget sent to the probe (first scan of a hwnd). */
  enumerateColdTotalMs?: number;
  /** Cold-window main-side race (first scan of a hwnd). */
  enumerateColdTimeoutMs?: number;
  invokeTimeoutMs?: number;
  readyTimeoutMs?: number;
  idleRecycleMs?: number;
  consecutiveTimeoutLimit?: number;
  /** Degraded auto-retry window (plan 562 D5). */
  degradedRetryMs?: number;
  /** Per-target quarantine cooldown after consecutive same-hwnd stalls. */
  targetQuarantineMs?: number;
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
  /** Stall-accounting key ('global', or `h:<hwnd>` for target ops). */
  stallKey?: string;
}

/** Cache TTL default (plan 562 D5): re-scan after 5min even if unchanged. */
const ENUMERATE_CACHE_TTL_MS = 5 * 60_000;

/** TTL for cached EMPTY trees — see EnumerateCacheEntry.ttlMs. */
const ENUMERATE_EMPTY_CACHE_TTL_MS = 2_000;

export class UiaProbeClient {
  private daemon: ComputerUseDaemon | null = null;
  private state: UiaProbeState = 'idle';
  private pending = new Map<number, PendingRequest>();
  private nextId = 1;
  private startInFlight: Promise<void> | null = null;
  private readyWaiters: Array<() => void> = [];
  private recycledOnce = false;
  private consecutiveTimeouts = 0;
  /** Consecutive timeouts per target hwnd (`h:<hwnd>` keys; see request()). */
  private stallsByTarget = new Map<number, number>();
  /** hwnd → quarantine start (0 never). A quarantined target is skipped. */
  private quarantinedAt = new Map<number, number>();
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
    enumerateColdTotalMs: number;
    enumerateColdTimeoutMs: number;
    invokeTimeoutMs: number;
    readyTimeoutMs: number;
    idleRecycleMs: number;
    consecutiveTimeoutLimit: number;
    degradedRetryMs: number;
    targetQuarantineMs: number;
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
      enumerateColdTotalMs: opts.enumerateColdTotalMs ?? UIA_ENUMERATE_COLD_TOTAL_MS,
      enumerateColdTimeoutMs: opts.enumerateColdTimeoutMs ?? UIA_ENUMERATE_COLD_TIMEOUT_MS,
      invokeTimeoutMs: opts.invokeTimeoutMs ?? UIA_INVOKE_TIMEOUT_MS,
      readyTimeoutMs: opts.readyTimeoutMs ?? READY_TIMEOUT_MS,
      idleRecycleMs: opts.idleRecycleMs ?? IDLE_RECYCLE_MS,
      consecutiveTimeoutLimit: opts.consecutiveTimeoutLimit ?? CONSECUTIVE_TIMEOUT_LIMIT,
      degradedRetryMs: opts.degradedRetryMs ?? DEGRADED_RETRY_MS,
      targetQuarantineMs: opts.targetQuarantineMs ?? UIA_TARGET_QUARANTINE_MS,
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
    const response = await this.request(
      (id) => ({ id, op: 'readUrl', hwnd }),
      this.opts.readUrlTimeoutMs,
      { stallKey: `h:${hwnd}` },
    );
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
   * reason 'elevated' = UIPI skip, reason 'target-unresponsive' = the
   * window is quarantined after consecutive stalls, truncated:true =
   * partial tree kept.
   *
   * `opts.totalMs` overrides the probe-side walk budget for THIS
   * request (the cold tier in enumerateCached uses it); `opts.raceMs`
   * widens the main-side race to match.
   */
  async enumerate(
    hwnd: number,
    opts: { maxNodes?: number; maxDepth?: number; totalMs?: number; raceMs?: number } = {},
  ): Promise<UiaEnumerateResult | null> {
    if (this.isQuarantined(hwnd)) {
      return { elements: [], truncated: true, reason: UIA_TARGET_UNRESPONSIVE };
    }
    const response = await this.request(
      (id) => ({
        id,
        op: 'enumerate',
        hwnd,
        ...(opts.maxNodes !== undefined ? { maxNodes: opts.maxNodes } : {}),
        ...(opts.maxDepth !== undefined ? { maxDepth: opts.maxDepth } : {}),
        ...(opts.totalMs !== undefined ? { totalMs: opts.totalMs } : {}),
      }),
      opts.raceMs ?? this.opts.enumerateTimeoutMs,
      { stallKey: `h:${hwnd}` },
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
   * `ttlMs` overrides the client-level cache TTL for this call (plan
   * 564: the SOM capture path uses a short TTL so clicking targets are
   * real coordinates that are never very stale).
   *
   * Budget tiers: a cache MISS for a hwnd we have never scanned runs
   * the cold tier (raised walk budget + race) — the first UIA touch of
   * a Chromium/Electron window also spins its accessibility engine up,
   * which alone can outlast the warm budget. Re-scans of known
   * windows (title change / TTL expiry) stay warm.
   */
  async enumerateCached(
    hwnd: number,
    title: string,
    opts: { maxNodes?: number; maxDepth?: number; ttlMs?: number } = {},
  ): Promise<UiaEnumerateResult | null> {
    const ttl = opts.ttlMs ?? this.opts.enumerateCacheTtlMs;
    const cached = this.enumerateCache.get(hwnd);
    const fresh = cached && Date.now() - cached.at < (cached.ttlMs ?? ttl);
    if (cached && fresh && cached.title === title && title.length > 0) {
      return cached.result;
    }
    const cold = !cached;
    const result = await this.enumerate(
      hwnd,
      cold
        ? {
            ...(opts.maxNodes !== undefined ? { maxNodes: opts.maxNodes } : {}),
            ...(opts.maxDepth !== undefined ? { maxDepth: opts.maxDepth } : {}),
            totalMs: this.opts.enumerateColdTotalMs,
            raceMs: this.opts.enumerateColdTimeoutMs,
          }
        : opts,
    );
    if (result === null) {
      // Keep any previous entry: a failed scan must not flush a good tree.
      return null;
    }
    this.enumerateCache.set(
      hwnd,
      result.elements.length === 0
        ? { title, result, at: Date.now(), ttlMs: ENUMERATE_EMPTY_CACHE_TTL_MS }
        : { title, result, at: Date.now() },
    );
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

  /**
   * Structural act op (plan 564): dispatch a UIA pattern against the
   * 1-based element index of the probe's last enumerate cache for
   * `hwnd`. Never throws; `null` = the probe could not answer
   * (timeout/degraded). A `stale-tree` answer triggers ONE auto-
   * recovery — a fresh enumerate re-populates the probe's element
   * cache, then the invoke is retried with the same slot; if the
   * staleness guard (name/controlType) still mismatches the caller
   * gets the error back and must re-run its tree listing.
   */
  async invoke(
    hwnd: number,
    opts: { index: number; method?: UiaInvokeMethod; value?: string; name?: string; controlType?: string },
  ): Promise<UiaInvokeOutcome | null> {
    if (this.isQuarantined(hwnd)) {
      return { ok: false, reason: UIA_TARGET_UNRESPONSIVE };
    }
    const attempt = (): Promise<UiaProbeResponse | null> =>
      this.request(
        (id) => ({
          id,
          op: 'invoke',
          hwnd,
          index: opts.index,
          ...(opts.method !== undefined ? { method: opts.method } : {}),
          ...(opts.value !== undefined ? { value: opts.value } : {}),
          ...(opts.name !== undefined ? { name: opts.name } : {}),
          ...(opts.controlType !== undefined ? { controlType: opts.controlType } : {}),
        }),
        this.opts.invokeTimeoutMs,
        { stallKey: `h:${hwnd}` },
      );

    const response = await attempt();
    if (response === null || response.kind !== 'response') {
      return null;
    }
    if (!response.ok) {
      if (response.reason !== UIA_INVOKE_ERRORS.STALE_TREE) {
        return { ok: false, reason: response.reason };
      }
      // Auto-recovery: re-enumerate (bypasses the main-side cache — the
      // probe's OWN element cache is what went stale) and retry once.
      const refreshed = await this.enumerate(hwnd);
      if (refreshed === null) {
        return { ok: false, reason: UIA_INVOKE_ERRORS.STALE_TREE };
      }
      const retry = await attempt();
      if (retry === null || retry.kind !== 'response') {
        return null;
      }
      if (!retry.ok) {
        return { ok: false, reason: retry.reason };
      }
      return {
        ok: true,
        method: retry.method ?? undefined,
        pattern: retry.pattern,
        value: retry.value,
        element: retry.element,
      };
    }
    return {
      ok: true,
      method: response.method ?? undefined,
      pattern: response.pattern,
      value: response.value,
      element: response.element,
    };
  }

  /**
   * CUA list_apps (plan 575): processes with a visible main window, plus
   * which one is foreground. Returns null on timeout / probe unavailable.
   */
  async listApps(): Promise<
    Array<{ pid: number; exe: string | null; title: string; active: boolean }> | null
  > {
    const response = await this.request((id) => ({ id, op: 'apps' as const }), 4_000);
    if (response === null || response.kind !== 'response' || !response.ok) {
      return null;
    }
    return response.apps;
  }

  /**
   * CUA list_windows (plan 575): top-level windows (optionally one pid)
   * with geometry, minimized and DWM-cloaked state.
   */
  async listWindows(
    pid = 0,
  ): Promise<
    Array<{
      hwnd: number;
      pid: number;
      title: string;
      rect: { x: number; y: number; w: number; h: number } | null;
      minimized: boolean;
      cloaked: boolean;
    }> | null
  > {
    const response = await this.request((id) => ({ id, op: 'windows' as const, pid }), 4_000);
    if (response === null || response.kind !== 'response' || !response.ok) {
      return null;
    }
    return response.windows;
  }

  /**
   * CUA select_text (plan 575): locate text inside the cached element's
   * TextPattern range and select it. Mirrors invoke()'s stale-tree
   * auto-recovery: re-enumerate and retry once.
   */
  async selectText(
    hwnd: number,
    opts: { index: number; text: string; name?: string; controlType?: string },
  ): Promise<{ ok: boolean; reason?: string; pattern?: string | null; element?: unknown } | null> {
    if (this.isQuarantined(hwnd)) {
      return { ok: false, reason: UIA_TARGET_UNRESPONSIVE };
    }
    const attempt = (): Promise<UiaProbeResponse | null> =>
      this.request(
        (id) => ({
          id,
          op: 'selectText' as const,
          hwnd,
          index: opts.index,
          text: opts.text,
          ...(opts.name !== undefined ? { name: opts.name } : {}),
          ...(opts.controlType !== undefined ? { controlType: opts.controlType } : {}),
        }),
        this.opts.invokeTimeoutMs,
        { stallKey: `h:${hwnd}` },
      );

    const response = await attempt();
    if (response === null || response.kind !== 'response') {
      return null;
    }
    if (!response.ok) {
      if (response.reason !== UIA_INVOKE_ERRORS.STALE_TREE) {
        return { ok: false, reason: response.reason };
      }
      const refreshed = await this.enumerate(hwnd);
      if (refreshed === null) {
        return { ok: false, reason: UIA_INVOKE_ERRORS.STALE_TREE };
      }
      const retry = await attempt();
      if (retry === null || retry.kind !== 'response') {
        return null;
      }
      if (!retry.ok) {
        return { ok: false, reason: retry.reason };
      }
      return { ok: true, pattern: retry.pattern, element: retry.element };
    }
    return { ok: true, pattern: response.pattern, element: response.element };
  }

  /** Stop the probe process and tear down timers. */
  async dispose(): Promise<void> {
    if (this.idleTimer) {
      clearInterval(this.idleTimer);
      this.idleTimer = null;
    }
    this.failAllPending('disposed');
    this.enumerateCache.clear();
    this.stallsByTarget.clear();
    this.quarantinedAt.clear();
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
    this.clearStall(pending.stallKey);
    this.lastActivityAt = Date.now();
    pending.resolve(parsed);
  }

  /** True while the hwnd sits in its post-stall quarantine window. */
  private isQuarantined(hwnd: number): boolean {
    const at = this.quarantinedAt.get(hwnd);
    if (at === undefined) {
      return false;
    }
    if (Date.now() - at >= this.opts.targetQuarantineMs) {
      this.quarantinedAt.delete(hwnd);
      return false;
    }
    return true;
  }

  private clearStall(key?: string): void {
    if (key === undefined) {
      return;
    }
    if (key === 'global') {
      this.consecutiveTimeouts = 0;
      return;
    }
    const hwnd = Number(key.slice(2));
    if (Number.isFinite(hwnd)) {
      this.stallsByTarget.delete(hwnd);
    }
  }

  /** Account one timed-out request under its stall key (plan 562 perf fix). */
  private async accountStall(key: string | undefined): Promise<void> {
    if (key === undefined || key === 'global') {
      // No hwnd on the wire: a hung op wedges the shared dispatcher, so
      // the process-wide recycle policy applies as before.
      this.consecutiveTimeouts += 1;
      logger.debug(
        'uia probe request timed out',
        { consecutive: this.consecutiveTimeouts },
        LogComponent.ComputerUse,
      );
      if (this.consecutiveTimeouts >= this.opts.consecutiveTimeoutLimit) {
        await this.recycleOnStall();
      }
      return;
    }
    const hwnd = Number(key.slice(2));
    if (!Number.isFinite(hwnd)) {
      return;
    }
    const count = (this.stallsByTarget.get(hwnd) ?? 0) + 1;
    this.stallsByTarget.set(hwnd, count);
    logger.debug(
      'uia probe target request timed out',
      { hwnd, consecutive: count },
      LogComponent.ComputerUse,
    );
    if (count >= this.opts.consecutiveTimeoutLimit) {
      // Quarantine the TARGET, not the process: one heavy or wedged
      // window must not recycle the probe and take every other
      // application's structural channel down with it.
      this.stallsByTarget.delete(hwnd);
      this.quarantinedAt.set(hwnd, Date.now());
      logger.warn(
        'uia probe target quarantined after consecutive stalls',
        { hwnd, quarantineMs: this.opts.targetQuarantineMs },
        LogComponent.ComputerUse,
      );
    }
  }

  private async request(
    build: (id: number) => UiaProbeRequest,
    timeoutMs: number,
    opts: { countsTowardStall?: boolean; stallKey?: string } = {},
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
      this.pending.set(id, { resolve, timer, stallKey: opts.stallKey });
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
      await this.accountStall(opts.stallKey ?? 'global');
    }
    return response;
  }

  /**
   * The probe looks hung (global-op consecutive timeouts / never became
   * ready). Recycle once; the second stall degrades the client for good —
   * element-less recording is the designed fallback (design §5).
   * Per-target stalls do NOT land here: they quarantine the window.
   */
  private async recycleOnStall(): Promise<void> {
    this.consecutiveTimeouts = 0;
    this.stallsByTarget.clear();
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
 * Shared singleton accessor (plan 564): the computer-use backend's
 * structural providers (tree / invoke) ride the SAME persistent probe
 * process the recorder uses — one Add-Type compile, one spawn, one
 * lifecycle. Lazily creates the client on first use.
 */
export function getSharedUiaProbeClient(): UiaProbeClient {
  if (!_shared) {
    _shared = new UiaProbeClient();
  }
  return _shared;
}

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
