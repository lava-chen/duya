/**
 * services/cua/cua-service.ts — CUA tool service (plan 575).
 *
 * Implements the 14-tool system-level computer-use surface aligned with
 * the ZCode/Codex CUA contract, on duya's own primitives:
 *
 *   identity/windows  → uia-probe `apps` / `windows` / `fg` ops
 *   element tree      → uia-probe `enumerate` (plan 562/564 pipeline)
 *   element actions   → uia-probe `invoke` (patterns) / `selectText`
 *   pixel input       → @nut-tree-fork/nut-js (SendInput under the hood)
 *   clipboard         → injectable (Electron clipboard in production)
 *   screenshots       → injectable (desktopCapturer window sources)
 *
 * Contract alignment (plan 575 §2): window-scoped element indices with
 * fail-closed resolution (tokens.ts), snapshot diffing (diff.ts),
 * model-facing text (format.ts), and the error taxonomy with
 * action_sent / retry semantics (types.ts). Every failure is a typed
 * CuaError — never a bare throw — so the agent can decide between
 * re-observe / retry / give up without parsing prose.
 *
 * Coordinate targets are interpreted against the LAST screenshot this
 * service delivered for the session (implicit frame binding, ZCode
 * semantics): raster pixel → screen physical pixels via the remembered
 * window rect. No frame yet → fail-closed STALE_STATE.
 */

import { getLogger, LogComponent } from '../../logging/logger.js';
import type { UiaProbeClient } from '../recorder/uia-probe.js';
import { getSharedUiaProbeClient } from '../recorder/uia-probe.js';
import {
  adaptEnumerated,
  decideSnapshotMode,
  diffSnapshots,
  formatDiff,
  formatObservation,
  normalizeKeyChord,
  splitChord,
  CuaError,
  CuaSnapshotCache,
  CuaTokenLedger,
  type CuaActionReceipt,
  type CuaAppInfo,
  type CuaElement,
  type CuaObservation,
  type CuaTarget,
  type CuaWindowInfo,
} from '@duya/computer-use';

const logger = getLogger();

/** nut.js surface subset used here (matches backend win32.ts conventions). */
export interface CuaNutAdapter {
  mouse: {
    setPosition(point: { x: number; y: number }): Promise<void>;
    click(button?: number): Promise<void>;
    wheel(direction: 'UP' | 'DOWN' | 'LEFT' | 'RIGHT', amount: number): Promise<void>;
  };
  keyboard: {
    type(text: string, opts?: { delayMs?: number }): Promise<void>;
    pressKey(...keys: Array<string | number>): Promise<void>;
  };
  Key: Record<string, string | number>;
  Button: Record<string, string | number>;
}

/** Screenshot of one window (or the full screen when windowId is null). */
export interface CuaCaptureResult {
  base64: string;
  width: number;
  height: number;
  /**
   * True when the PNG is a uniform frame (stddev ≈ 0) — treated as
   * screenshot_blank: the pixels are discarded rather than bound to the
   * coordinate frame (plan 575 gap fix).
   */
  blank?: boolean;
}

/** app_ref — how the model names the target app/window (ZCode-aligned). */
export interface CuaAppRef {
  pid?: number;
  name?: string;
  windowId?: number;
}

export interface CuaServiceDeps {
  /** Shared UIA probe client (defaults to the singleton getter). */
  probeClient?: () => UiaProbeClient;
  /** Clipboard writer for paste (Electron clipboard in production). */
  writeClipboard?: (text: string) => void;
  /**
   * Window/screen capture. windowId=null captures the primary display.
   * `bounds` (physical px, when the window rect is known) lets the
   * provider request a native-resolution, aspect-exact thumbnail.
   */
  capture?: (
    windowId: number | null,
    bounds?: [number, number, number, number] | null,
  ) => Promise<CuaCaptureResult | null>;
  /**
   * User-confirmation gate for mutating tools (plan 575 red line:
   * click/drag/set_value/perform_action/paste ride the same approval
   * channel as the classic computer_use surface). Absent = no gate
   * (headless/test wiring); production wires the shared ApprovalBridge.
   */
  approval?: (tool: string, args: Record<string, unknown>) => Promise<{ ok: boolean; reason?: string }>;
  /** nut.js adapter override (tests); lazy require() when absent. */
  nut?: CuaNutAdapter | null;
  /** nut.js loader override factory — used once, then cached. */
  loadNut?: () => CuaNutAdapter | null;
}

/** Per-session state: ledger + snapshot cache + last frame + last trees. */
interface CuaSessionState {
  ledger: CuaTokenLedger;
  snapshots: CuaSnapshotCache;
  /** Last delivered screenshot frame for implicit coordinate binding. */
  frame: { imageWidth: number; imageHeight: number; windowRect: [number, number, number, number] | null } | null;
  /** Last observation's elements per hwnd (staleness-guard source). */
  elementsByHwnd: Map<number, CuaElement[]>;
  /** Last observation's window title per hwnd (app_ref name lookup). */
  titleByHwnd: Map<number, string>;
}

const MAX_SESSIONS = 32;

/**
 * Mutating CUA tools that require user confirmation (plan 575 §4 red
 * line: approval semantics are NOT relaxed — these ride the same
 * CONFIRM_REQUIRED channel as the classic computer_use surface; the
 * service-level `scroll` / `type` / `key` match that surface's gate set).
 */
const APPROVAL_REQUIRED_TOOLS: ReadonlySet<string> = new Set([
  'left_click',
  'left_click_drag',
  'set_value',
  'perform_action',
  'paste',
]);

const nutButtonNumber = (nut: CuaNutAdapter, button: 'left' | 'right' | 'middle'): number => {
  const upper = button.toUpperCase();
  const value = nut.Button?.[upper];
  if (typeof value === 'number') return value;
  return button === 'right' ? 2 : button === 'middle' ? 1 : 0;
};

/** UIA element JSON as the probe reads it back after an action. */
interface ProbeReadBack {
  name?: string | null;
  controlType?: string | null;
  value?: string | null;
}

export class CuaService {
  private readonly deps: CuaServiceDeps;
  private readonly sessions = new Map<string, CuaSessionState>();
  private nutCache: CuaNutAdapter | null | undefined;

  constructor(deps: CuaServiceDeps = {}) {
    this.deps = deps;
  }

  private probe(): UiaProbeClient {
    return this.deps.probeClient?.() ?? getSharedUiaProbeClient();
  }

  private session(sessionId: string | undefined): CuaSessionState {
    const key = sessionId ?? '(no-session)';
    let state = this.sessions.get(key);
    if (!state) {
      state = {
        ledger: new CuaTokenLedger(),
        snapshots: new CuaSnapshotCache(),
        frame: null,
        elementsByHwnd: new Map(),
        titleByHwnd: new Map(),
      };
      if (this.sessions.size >= MAX_SESSIONS) {
        const oldest = this.sessions.keys().next();
        if (!oldest.done) this.sessions.delete(oldest.value);
      }
      this.sessions.set(key, state);
    }
    return state;
  }

  private nut(): CuaNutAdapter | null {
    if (this.nutCache !== undefined) return this.nutCache;
    if (this.deps.nut !== undefined) {
      this.nutCache = this.deps.nut;
      return this.nutCache;
    }
    if (this.deps.loadNut) {
      this.nutCache = this.deps.loadNut();
      return this.nutCache;
    }
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const mod = require('@nut-tree-fork/nut-js') as Partial<CuaNutAdapter>;
      this.nutCache = mod as CuaNutAdapter;
    } catch (err) {
      logger.warn(
        'cua: nut-js unavailable — pixel input tools disabled',
        { error: err instanceof Error ? err.message : String(err) },
        LogComponent.ComputerUse,
      );
      this.nutCache = null;
    }
    return this.nutCache;
  }

  private requireNut(): CuaNutAdapter {
    const nut = this.nut();
    if (!nut) {
      throw new CuaError('pixel input is unavailable on this host (nut-js failed to load)', {
        code: 'ACTION_UNAVAILABLE',
      });
    }
    return nut;
  }

  /** True when the pid hosts several UWP windows under one process id. */
  private async isSharedHostPid(pid: number): Promise<boolean> {
    try {
      const rows = await this.probe().listApps();
      const row = rows?.find((r) => r.pid === pid);
      if (!row?.exe) return false;
      return /applicationframehost(\.exe)?$/i.test(row.exe);
    } catch {
      return false;
    }
  }

  /**
   * User-confirmation gate (plan 575 red line). Throws NOT_AUTHORIZED
   * with actionSent=false when the user denied / the request timed out —
   * nothing has been dispatched at that point.
   */
  private async requireApproval(tool: string, args: Record<string, unknown>): Promise<void> {
    if (!APPROVAL_REQUIRED_TOOLS.has(tool)) return;
    if (!this.deps.approval) return;
    const verdict = await this.deps.approval(tool, args);
    if (!verdict.ok) {
      throw new CuaError(
        `${tool} was not approved (${verdict.reason ?? 'denied'}) — nothing was dispatched; ask the user or adjust the plan`,
        { code: 'NOT_AUTHORIZED' },
      );
    }
  }

  // ────────────────────────────────────────────────────────────────────
  // 1. list_apps
  // ────────────────────────────────────────────────────────────────────

  async listApps(): Promise<CuaAppInfo[]> {
    const rows = await this.probe().listApps();
    if (rows === null) {
      throw new CuaError('list_apps: the UIA probe is unavailable or timed out', {
        code: 'TIMEOUT',
      });
    }
    return rows.map((row) => ({
      pid: row.pid,
      bundleId: row.exe,
      name: row.title,
      active: row.active,
      title: row.title,
    }));
  }

  // ────────────────────────────────────────────────────────────────────
  // 2. list_windows
  // ────────────────────────────────────────────────────────────────────

  async listWindows(pid?: number): Promise<CuaWindowInfo[]> {
    const rows = await this.probe().listWindows(pid ?? 0);
    if (rows === null) {
      throw new CuaError('list_windows: the UIA probe is unavailable or timed out', {
        code: 'TIMEOUT',
      });
    }
    return rows.map((row) => ({
      windowId: row.hwnd,
      pid: row.pid,
      title: row.title || null,
      bounds: row.rect ? [row.rect.x, row.rect.y, row.rect.w, row.rect.h] : null,
      minimized: row.minimized,
      cloaked: row.cloaked,
    }));
  }

  // ────────────────────────────────────────────────────────────────────
  // Window resolution (shared by get_app_state and element actions)
  // ────────────────────────────────────────────────────────────────────

  /**
   * Resolve an app_ref ({pid|name|window_id}) to one live window.
   * Alignment with ZCode: pid is cross-checked against the window list,
   * name matching is case-insensitive `contains` over visible,
   * non-cloaked windows; ambiguity and misses fail closed.
   */
  private async resolveWindow(appRef: CuaAppRef): Promise<{
    hwnd: number;
    pid: number;
    title: string;
    bounds: [number, number, number, number] | null;
  }> {
    const windows = (await this.probe().listWindows(0)) ?? [];
    const visible = windows.filter((w) => !w.cloaked && !w.minimized && (w.title || '').length > 0);

    if (appRef.windowId !== undefined) {
      const hit = visible.find((w) => w.hwnd === appRef.windowId);
      if (!hit) {
        throw new CuaError(
          `window ${appRef.windowId} is gone or not visible; call list_windows and pick a fresh window_id`,
          { code: 'STALE_STATE' },
        );
      }
      return this.toResolved(hit);
    }

    if (typeof appRef.pid === 'number' && appRef.pid > 0) {
      const hits = visible.filter((w) => w.pid === appRef.pid);
      if (hits.length === 0) {
        throw new CuaError(
          `pid ${appRef.pid} has no visible window — call list_apps / list_windows for a live identity`,
          { code: 'INVALID_APP' },
        );
      }
      // ApplicationFrameHost hosts every UWP window under ONE pid —
      // picking hits[0] silently would automate the wrong surface.
      // Refuse with disambiguation guidance (ZCode-aligned).
      if (hits.length > 1 && (await this.isSharedHostPid(appRef.pid))) {
        throw new CuaError(
          `pid ${appRef.pid} is ApplicationFrameHost — it hosts several UWP windows under one process id (${hits.length} visible here); call list_windows and target the exact window_id`,
          { code: 'INVALID_APP' },
        );
      }
      return this.toResolved(hits[0]);
    }

    if (typeof appRef.name === 'string' && appRef.name.trim()) {
      const wanted = appRef.name.trim().toLowerCase();
      const hits = visible.filter((w) => (w.title || '').toLowerCase().includes(wanted));
      if (hits.length === 0) {
        throw new CuaError(
          `no visible window title matches ${JSON.stringify(appRef.name)}; call list_apps for exact names`,
          { code: 'INVALID_APP' },
        );
      }
      if (hits.length > 1) {
        throw new CuaError(
          `app_ref name ${JSON.stringify(appRef.name)} matches ${hits.length} windows — disambiguate with pid or window_id`,
          { code: 'INVALID_APP' },
        );
      }
      return this.toResolved(hits[0]);
    }

    // No ref at all: fall back to the foreground window (ZCode semantics:
    // the main/key window is re-resolved per observation).
    const fg = await this.probe().foreground();
    if (fg === null) {
      throw new CuaError('no app_ref given and no foreground window could be resolved', {
        code: 'INVALID_APP',
      });
    }
    return { hwnd: fg.hwnd, pid: fg.pid, title: fg.title, bounds: null };
  }

  private toResolved(hit: {
    hwnd: number;
    pid: number;
    title: string;
    rect: { x: number; y: number; w: number; h: number } | null;
  }): { hwnd: number; pid: number; title: string; bounds: [number, number, number, number] | null } {
    return {
      hwnd: hit.hwnd,
      pid: hit.pid,
      title: hit.title,
      bounds: hit.rect ? [hit.rect.x, hit.rect.y, hit.rect.w, hit.rect.h] : null,
    };
  }

  // ────────────────────────────────────────────────────────────────────
  // 3. get_app_state
  // ────────────────────────────────────────────────────────────────────

  async getAppState(
    appRef: CuaAppRef & { includeScreenshot?: boolean; maxElements?: number },
    sessionId?: string,
  ): Promise<{ observation: CuaObservation; text: string; screenshot?: CuaCaptureResult }> {
    const state = this.session(sessionId);
    const win = await this.resolveWindow(appRef);

    const probed = await this.probe().enumerate(win.hwnd);
    if (probed === null) {
      throw new CuaError(
        `get_app_state: enumerating window ${win.hwnd} timed out — the target may be hung; retry once or pick another window`,
        { code: 'TIMEOUT' },
      );
    }
    if (probed.reason === 'elevated') {
      throw new CuaError(
        'the target window is elevated (UIPI): its UIA tree is unreadable from a non-elevated process',
        { code: 'PERMISSION_DENIED' },
      );
    }

    state.ledger.issueSnapshot(win.hwnd, probed.elements.length, win.pid);
    const elements: CuaElement[] = probed.elements.map((el, i) => ({
      // Opaque token aligned with the ZCode element payload: the slot
      // the ledger issued (hwnd + 1-based probe cache slot).
      native: `cua-${win.hwnd}:${i + 1}`,
      ...adaptEnumerated(el, i + 1, win.hwnd, win.pid),
    }));
    state.elementsByHwnd.set(win.hwnd, elements);
    state.titleByHwnd.set(win.hwnd, win.title);

    // Diff against the previous snapshot for the same pid+window.
    const previous = state.snapshots.get(win.pid, win.hwnd, win.bounds, win.title);
    const diff = diffSnapshots(
      previous?.elements ?? null,
      previous?.title ?? '',
      elements,
      win.title,
    );
    const snapshotMode = decideSnapshotMode(diff, {
      previousWindowTitle: previous?.title ?? '',
      newWindowTitle: win.title,
      previousWindowId: previous ? win.hwnd : -1,
      newWindowId: win.hwnd,
      previousWindowBounds: previous?.bounds ?? undefined,
      newWindowBounds: win.bounds ?? undefined,
      totalElements: elements.length,
    });
    const stateId = `cua-${win.pid}-${win.hwnd}-${state.ledger.currentEpoch(win.hwnd)}`;
    state.snapshots.set(win.pid, win.hwnd, win.bounds, win.title, { elements, stateId });

    // bundleId slot: Windows has no bundle id — the exe path fills it
    // (one cheap apps round-trip, best-effort).
    let bundleId: string | null = null;
    try {
      const appRows = await this.probe().listApps();
      bundleId = appRows?.find((r) => r.pid === win.pid)?.exe ?? null;
    } catch {
      bundleId = null;
    }

    const observation: CuaObservation = {
      stateId,
      snapshotMode: previous ? snapshotMode : 'full',
      app: { pid: win.pid, bundleId, name: win.title },
      window: { windowId: win.hwnd, title: win.title, bounds: win.bounds },
      elements,
      truncated: probed.truncated === true,
      changes: previous ? diff : undefined,
    };

    let text = formatObservation(observation, { maxElements: appRef.maxElements });
    const advisory = formatDiff(observation);
    if (advisory) text += `\n${advisory}`;
    if (probed.truncated === true) {
      text +=
        '\n[tree truncated: the element walk hit its budget — this list is PARTIAL; an absent element is not proof it does not exist, scroll or refine the window and re-observe]';
    }

    let screenshot: CuaCaptureResult | undefined;
    if (appRef.includeScreenshot === true) {
      const shot = this.deps.capture ? await this.deps.capture(win.hwnd, win.bounds) : null;
      if (!shot || shot.width <= 0 || shot.height <= 0) {
        text += '\n[screenshot unavailable: the window could not be captured (occluded or gone)]';
      } else if (shot.blank === true) {
        text +=
          '\n[screenshot_blank: the capture is a uniform frame (occluded / minimized / protected surface) — the pixels were discarded; do not use coordinate targets against them]';
      } else {
        const verified = await this.verifyCaptureSurface(win.hwnd, win.bounds);
        if (verified === 'changed') {
          text +=
            '\n[capture_surfaces_changed: the window moved/resized/was hidden between enumeration and capture — the frame was discarded; re-observe before coordinate clicks]';
        } else {
          screenshot = shot;
          state.frame = {
            imageWidth: shot.width,
            imageHeight: shot.height,
            windowRect: win.bounds,
          };
          if (verified === 'unverified') {
            text +=
              '\n[screenshot unverified: the post-capture window re-check could not be answered — coordinate targets bind to the pre-capture rect]';
          }
        }
      }
    }

    return { observation, text, screenshot };
  }

  /**
   * Screenshot trust check (plan 575 gap fix — ZCode's surface-fingerprint
   * comparison, degraded to a rect/visibility re-query): between the tree
   * enumeration and the capture the window may have moved, resized, been
   * minimized or cloaked — the frame would still bind to the OLD rect and
   * every coordinate click would land off-target. 'changed' discards the
   * frame; 'unverified' (probe could not answer) keeps it with a note.
   */
  private async verifyCaptureSurface(
    hwnd: number,
    bounds: [number, number, number, number] | null,
  ): Promise<'ok' | 'changed' | 'unverified'> {
    if (!bounds) return 'unverified';
    try {
      const rows = await this.probe().listWindows(0);
      if (rows === null) return 'unverified';
      const row = rows.find((w) => w.hwnd === hwnd);
      if (!row || row.cloaked || row.minimized || !row.rect) return 'changed';
      const r = row.rect;
      const same =
        Math.round(r.x) === bounds[0] &&
        Math.round(r.y) === bounds[1] &&
        Math.round(r.w) === bounds[2] &&
        Math.round(r.h) === bounds[3];
      return same ? 'ok' : 'changed';
    } catch {
      return 'unverified';
    }
  }

  // ────────────────────────────────────────────────────────────────────
  // Element target resolution (app_ref + index, fail-closed)
  // ────────────────────────────────────────────────────────────────────

  /**
   * Resolve an element target: the app_ref picks the window (ZCode
   * semantics — the index is scoped to the app's latest observation),
   * the ledger confirms the index was issued, and the last observation
   * supplies the probe's staleness guards.
   */
  private resolveElement(
    state: CuaSessionState,
    appRef: CuaAppRef,
    target: CuaTarget,
    hwndHint?: number,
  ): {
    hwnd: number;
    probeIndex: number;
    guards: { name?: string; controlType?: string };
    elements: CuaElement[];
  } {
    if (target.type !== 'element') {
      throw new CuaError('this action requires an element target (observe with get_app_state first)', {
        code: 'INVALID_APP',
      });
    }
    if (!Number.isInteger(target.index) || target.index < 0) {
      throw new CuaError(`element index must be a non-negative integer (got ${target.index})`, {
        code: 'INVALID_APP',
      });
    }
    return this.resolveIndex(state, appRef, target.index, hwndHint);
  }

  private resolveIndex(
    state: CuaSessionState,
    appRef: CuaAppRef,
    index: number,
    hwndHint?: number,
  ): {
    hwnd: number;
    probeIndex: number;
    guards: { name?: string; controlType?: string };
    elements: CuaElement[];
  } {
    // Element actions resolve the window synchronously from the last
    // observation when possible (list_windows round-trips only on a
    // name/pid ref that was never observed this session).
    const cached = this.findObservedWindow(state, appRef, hwndHint);
    const hwnd = cached ?? hwndHint;
    if (hwnd === undefined) {
      throw new CuaError(
        'no observation for this app_ref yet — run get_app_state first (element indices are scoped to it)',
        { code: 'ELEMENT_UNAVAILABLE' },
      );
    }
    // Model-facing indices are 0-based (the `[0]`-style rows in the
    // observation text); the probe cache is 1-based (plan 564).
    const probeIndex = index + 1;
    const identity = state.ledger.resolve(hwnd, probeIndex);
    if (identity === null) {
      throw new CuaError(
        `element index ${index} is not registered for window ${hwnd} — it was never issued in this session or superseded; re-run get_app_state and re-pick from the fresh tree`,
        { code: 'ELEMENT_UNAVAILABLE' },
      );
    }
    const elements = state.elementsByHwnd.get(hwnd) ?? [];
    const el = elements[index];
    const guards: { name?: string; controlType?: string } = {};
    if (el?.title) guards.name = el.title;
    if (el?.role) guards.controlType = el.role;
    return { hwnd, probeIndex, guards, elements };
  }

  /** Find the hwnd a previously-observed app_ref points at (sync). */
  private findObservedWindow(state: CuaSessionState, appRef: CuaAppRef, hwndHint?: number): number | undefined {
    if (appRef.windowId !== undefined) return appRef.windowId;
    if (hwndHint !== undefined) return hwndHint;
    if (typeof appRef.pid === 'number' && appRef.pid > 0) {
      for (const [hwnd, elements] of state.elementsByHwnd) {
        if (elements.length > 0 && elements[0]?.ownerPid === appRef.pid) return hwnd;
      }
    }
    if (typeof appRef.name === 'string' && appRef.name.trim()) {
      const wanted = appRef.name.trim().toLowerCase();
      for (const [hwnd, title] of state.titleByHwnd) {
        if (title.toLowerCase().includes(wanted)) return hwnd;
      }
    }
    return undefined;
  }

  // ────────────────────────────────────────────────────────────────────
  // Actions
  // ────────────────────────────────────────────────────────────────────

  /** Element-path dispatch through the probe's pattern channel. */
  private async invokeElement(
    state: CuaSessionState,
    appRef: CuaAppRef,
    target: CuaTarget,
    tool: CuaActionReceipt['tool'],
    opts: { method?: string; value?: string },
  ): Promise<CuaActionReceipt> {
    const resolved = this.resolveElement(state, appRef, target);
    const outcome = await this.probe().invoke(resolved.hwnd, {
      index: resolved.probeIndex,
      method: (opts.method as 'auto' | 'invoke' | 'toggle' | 'expand' | 'collapse' | 'select' | 'focus' | 'setValue') ?? 'auto',
      ...(opts.value !== undefined ? { value: opts.value } : {}),
      ...resolved.guards,
    });
    if (outcome === null) {
      throw new CuaError('the structural action timed out — the target may be hung', {
        code: 'TIMEOUT',
      });
    }
    if (!outcome.ok) {
      throw this.invokeFailureToError(outcome.reason ?? 'error');
    }
    const readBack = outcome.element as ProbeReadBack | null | undefined;
    return {
      tool,
      actionSent: true,
      dispatchStatus: 'accepted',
      targetVerificationStatus: 'matched',
      element: readBack
        ? {
            title: readBack.name ?? null,
            value: readBack.value ?? null,
            controlType: readBack.controlType ?? null,
          }
        : null,
    };
  }

  /** Map probe invoke failure reasons to the CUA error taxonomy. */
  private invokeFailureToError(reason: string): CuaError {
    switch (reason) {
      case 'stale-tree':
        return new CuaError(
          'the element moved on since the last observation (stale-tree) — re-run get_app_state and re-pick',
          { code: 'ELEMENT_UNAVAILABLE' },
        );
      case 'no-element':
      case 'bad-index':
        return new CuaError(
          'the element index is not in the probe cache — re-run get_app_state first',
          { code: 'ELEMENT_UNAVAILABLE' },
        );
      case 'no-pattern':
        return new CuaError(
          'the element carries no matching UIA pattern — fall back to the vision loop (coordinate click)',
          { code: 'ACTION_UNAVAILABLE' },
        );
      case 'no-window':
        return new CuaError('the owning window is gone', { code: 'STALE_STATE' });
      case 'timeout':
        return new CuaError('the structural action timed out', { code: 'TIMEOUT' });
      default:
        return new CuaError(`the structural action failed (${reason})`, { code: 'INTERNAL' });
    }
  }

  /**
   * left_click. Element target → UIA pattern chain (auto); coordinate
   * target → nut-js click on the resolved screen point.
   */
  async leftClick(
    args: { appRef?: CuaAppRef; target: CuaTarget; button?: 'left' | 'right' | 'middle'; clickCount?: number },
    sessionId?: string,
  ): Promise<CuaActionReceipt> {
    await this.requireApproval('left_click', args as Record<string, unknown>);
    const state = this.session(sessionId);
    if (args.target.type === 'element') {
      return this.invokeElement(state, args.appRef ?? {}, args.target, 'left_click', { method: 'auto' });
    }
    const nut = this.requireNut();
    const point = this.resolveCoordinate(state, args.target);
    await nut.mouse.setPosition(point);
    const button = nutButtonNumber(nut, args.button ?? 'left');
    const clicks = Math.max(1, Math.min(3, args.clickCount ?? 1));
    for (let i = 0; i < clicks; i += 1) {
      await nut.mouse.click(button);
    }
    return { tool: 'left_click', actionSent: true, dispatchStatus: 'possibly_sent' };
  }

  async leftClickDrag(
    args: { appRef?: CuaAppRef; from: CuaTarget; to: CuaTarget },
    sessionId?: string,
  ): Promise<CuaActionReceipt> {
    const state = this.session(sessionId);
    const nut = this.requireNut();
    const from =
      args.from.type === 'coordinate'
        ? this.resolveCoordinate(state, args.from)
        : await this.elementCenter(state, args.appRef ?? {}, args.from);
    const to =
      args.to.type === 'coordinate'
        ? this.resolveCoordinate(state, args.to)
        : await this.elementCenter(state, args.appRef ?? {}, args.to);
    const steps = 10;
    for (let i = 0; i <= steps; i += 1) {
      const t = i / steps;
      await nut.mouse.setPosition({
        x: Math.round(from.x + (to.x - from.x) * t),
        y: Math.round(from.y + (to.y - from.y) * t),
      });
      if (i === 0) await nut.mouse.click(nutButtonNumber(nut, 'left'));
    }
    return { tool: 'left_click_drag', actionSent: true, dispatchStatus: 'possibly_sent' };
  }

  private async elementCenter(
    state: CuaSessionState,
    appRef: CuaAppRef,
    target: CuaTarget,
  ): Promise<{ x: number; y: number }> {
    const resolved = this.resolveElement(state, appRef, target);
    const el = resolved.elements[resolved.probeIndex - 1];
    // elementCenter: probeIndex is 1-based over the same element list.
    if (!el || el.bounds[2] <= 0 || el.bounds[3] <= 0) {
      throw new CuaError('the element has no usable bounds for a positional action', {
        code: 'ELEMENT_UNAVAILABLE',
      });
    }
    return {
      x: el.bounds[0] + Math.round(el.bounds[2] / 2),
      y: el.bounds[1] + Math.round(el.bounds[3] / 2),
    };
  }

  async scroll(
    args: { target?: CuaTarget; direction: 'up' | 'down' | 'left' | 'right'; pages?: number },
    sessionId?: string,
  ): Promise<CuaActionReceipt> {
    const state = this.session(sessionId);
    const nut = this.requireNut();
    if (args.target && args.target.type === 'coordinate') {
      const point = this.resolveCoordinate(state, args.target);
      await nut.mouse.setPosition(point);
    }
    const dir = args.direction.toUpperCase() as 'UP' | 'DOWN' | 'LEFT' | 'RIGHT';
    await nut.mouse.wheel(dir, Math.max(1, args.pages ?? 1));
    return { tool: 'scroll', actionSent: true, dispatchStatus: 'possibly_sent' };
  }

  async typeText(args: { text: string }, _sessionId?: string): Promise<CuaActionReceipt> {
    const nut = this.requireNut();
    await nut.keyboard.type(args.text, { delayMs: 10 });
    return { tool: 'type', actionSent: true, dispatchStatus: 'possibly_sent' };
  }

  async key(args: { key: string; modifiers?: string[] }, _sessionId?: string): Promise<CuaActionReceipt> {
    const nut = this.requireNut();
    const chord = normalizeKeyChord([...(args.modifiers ?? []), args.key].join('+'));
    const { modifiers, key } = splitChord(chord);
    const tokens: Array<string | number> = [];
    for (const mod of modifiers) {
      const mapped = nut.Key?.[mod.toUpperCase()];
      tokens.push(typeof mapped === 'string' || typeof mapped === 'number' ? mapped : mod);
    }
    const mainKey = nut.Key?.[key.toUpperCase()];
    tokens.push(typeof mainKey === 'string' || typeof mainKey === 'number' ? mainKey : key);
    await nut.keyboard.pressKey(...tokens);
    return { tool: 'key', actionSent: true, dispatchStatus: 'possibly_sent' };
  }

  async setValue(
    args: { appRef?: CuaAppRef; target: CuaTarget; value: string },
    sessionId?: string,
  ): Promise<CuaActionReceipt> {
    const state = this.session(sessionId);
    return this.invokeElement(state, args.appRef ?? {}, args.target, 'set_value', {
      method: 'setValue',
      value: args.value,
    });
  }

  async selectText(
    args: { appRef?: CuaAppRef; target: CuaTarget; text: string },
    sessionId?: string,
  ): Promise<CuaActionReceipt> {
    const state = this.session(sessionId);
    const resolved = this.resolveElement(state, args.appRef ?? {}, args.target);
    const outcome = await this.probe().selectText(resolved.hwnd, {
      index: resolved.probeIndex,
      text: args.text,
      ...resolved.guards,
    });
    if (outcome === null) {
      throw new CuaError('select_text timed out', { code: 'TIMEOUT' });
    }
    if (!outcome.ok) {
      if (outcome.reason === 'no-pattern') {
        throw new CuaError(
          'the element carries no TextPattern — text selection is unavailable on it',
          { code: 'NOT_SELECTABLE' },
        );
      }
      if (outcome.reason === 'not-found') {
        throw new CuaError(
          'the requested text does not occur in the element value — re-observe and verify',
          { code: 'NOT_SELECTABLE' },
        );
      }
      throw this.invokeFailureToError(outcome.reason ?? 'error');
    }
    return {
      tool: 'select_text',
      actionSent: true,
      dispatchStatus: 'accepted',
      targetVerificationStatus: 'matched',
    };
  }

  /** AX-vocabulary semantic action → UIA pattern (aligned mapping). */
  async performAction(
    args: { appRef?: CuaAppRef; target: CuaTarget; action: string; value?: string },
    sessionId?: string,
  ): Promise<CuaActionReceipt> {
    await this.requireApproval('perform_action', args as Record<string, unknown>);
    const state = this.session(sessionId);
    const method = actionToMethod(args.action);
    if (method === null) {
      throw new CuaError(
        `perform_action: unknown action ${JSON.stringify(args.action)} — only actions the element advertises are valid (see its actions=[...] row)`,
        { code: 'ACTION_UNAVAILABLE' },
      );
    }
    // Advertised-actions guard (plan 575 gap fix): the doc promised "only
    // actions the element declares are valid" — actually enforce it. The
    // element row from the last observation carries the derived actions=[...].
    const resolved = this.resolveElement(state, args.appRef ?? {}, args.target);
    const el = resolved.elements[resolved.probeIndex - 1];
    if (el && Array.isArray(el.actions) && !el.actions.includes(args.action)) {
      throw new CuaError(
        `perform_action: ${args.action} is not advertised by this element (actions=[${el.actions.join(', ') || 'none'}]) — pick from the advertised set or use left_click`,
        { code: 'ACTION_UNAVAILABLE' },
      );
    }
    return this.invokeElement(state, args.appRef ?? {}, args.target, 'perform_action', {
      method,
      ...(method === 'setValue' ? { value: args.value } : {}),
    });
  }

  async paste(args: { text: string }, _sessionId?: string): Promise<CuaActionReceipt> {
    await this.requireApproval('paste', args as Record<string, unknown>);
    if (!this.deps.writeClipboard) {
      throw new CuaError('paste: no clipboard provider on this platform', {
        code: 'ACTION_UNAVAILABLE',
      });
    }
    this.deps.writeClipboard(args.text);
    await this.key({ key: 'v', modifiers: ['ctrl'] });
    return { tool: 'paste', actionSent: true, dispatchStatus: 'possibly_sent' };
  }

  // ────────────────────────────────────────────────────────────────────
  // 13-14: request_access / stop_computer_control
  // ────────────────────────────────────────────────────────────────────

  async requestAccess(): Promise<{ ready: boolean; platform: 'win32'; notes: string[] }> {
    await this.probe().ensureStarted();
    return {
      ready: true,
      platform: 'win32',
      notes: [
        'Windows has no TCC gate; elevated (UIPI) targets are unreadable and reported as PERMISSION_DENIED.',
      ],
    };
  }

  stop(sessionId?: string): void {
    const key = sessionId ?? '(no-session)';
    const state = this.sessions.get(key);
    if (state) {
      state.ledger.clear();
      state.snapshots.clear();
      state.frame = null;
      state.elementsByHwnd.clear();
      state.titleByHwnd.clear();
      this.sessions.delete(key);
    }
  }

  // ────────────────────────────────────────────────────────────────────
  // Coordinates (implicit frame binding)
  // ────────────────────────────────────────────────────────────────────

  /** Remember the last delivered screenshot for coordinate binding. */
  rememberFrame(
    sessionId: string | undefined,
    frame: { imageWidth: number; imageHeight: number; windowRect: [number, number, number, number] | null },
  ): void {
    this.session(sessionId).frame = frame;
  }

  /**
   * Raster pixel → screen physical pixel against the last frame. When
   * the frame carried a window rect (window capture), the pixel maps
   * into that rect; a full-screen frame maps 1:1 over its bitmap size.
   */
  resolveCoordinate(
    state: CuaSessionState,
    target: { x: number; y: number },
  ): { x: number; y: number } {
    const frame = state.frame;
    if (!frame || frame.imageWidth <= 0 || frame.imageHeight <= 0) {
      throw new CuaError(
        'no actionable frame: take a get_app_state screenshot (includeScreenshot) before coordinate clicks',
        { code: 'STALE_STATE' },
      );
    }
    if (
      !Number.isFinite(target.x) ||
      !Number.isFinite(target.y) ||
      target.x < 0 ||
      target.y < 0 ||
      target.x >= frame.imageWidth ||
      target.y >= frame.imageHeight
    ) {
      throw new CuaError(
        `coordinate (${target.x}, ${target.y}) is outside the ${frame.imageWidth}x${frame.imageHeight} frame — take a fresh screenshot`,
        { code: 'STALE_STATE' },
      );
    }
    if (frame.windowRect) {
      const [wx, wy, ww, wh] = frame.windowRect;
      if (ww > 0 && wh > 0) {
        return {
          x: wx + Math.round((target.x / frame.imageWidth) * ww),
          y: wy + Math.round((target.y / frame.imageHeight) * wh),
        };
      }
    }
    return { x: Math.round(target.x), y: Math.round(target.y) };
  }
}

/** Map an AX-vocabulary action to a probe invoke method (null = unknown). */
export function actionToMethod(action: string): string | null {
  switch (action) {
    case 'AXPress':
      return 'invoke';
    case 'AXToggle':
      return 'toggle';
    case 'AXExpand':
      return 'expand';
    case 'AXCollapse':
      return 'collapse';
    case 'AXSelect':
      return 'select';
    case 'AXRaise':
      return 'focus';
    case 'AXSetValue':
      return 'setValue';
    case 'AXShowMenu':
      return 'invoke';
    default:
      return null;
  }
}
