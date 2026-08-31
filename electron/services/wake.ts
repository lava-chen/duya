/**
 * wake.ts — Wake Agent orb lifecycle.
 *
 * Owns the single Orb BrowserWindow + 4-state state machine
 * (DORMANT → INPUT → LOADING → RESULT). State transitions happen via
 * IPC handlers in `electron/ipc/orb.ts`.
 *
 * Why a single BrowserWindow:
 *   - Per plan §2 row 2: "任何时刻只渲染一个 UI 元素:球 / 输入框 /
 *     结果". Switching is a `setBounds()` + element-swap, not a stack
 *     of windows.
 *   - The window stays always-on-top + transparent + skipTaskbar so
 *     it never competes with the main DUYA window.
 *
 * Hotkey:
 *   - Default `CommandOrControl+Shift+Space` (configurable via
 *     `[wake.shortcut]` in config.toml — Task H).
 *   - globalShortcut.register is best-effort; conflicts surface as a
 *     WARN log + UI banner, not a crash.
 *
 * Plan 453 Task E.
 */

import { BrowserWindow, app, globalShortcut, screen } from 'electron';
import { EventEmitter } from 'node:events';
import { join } from 'node:path';
import { existsSync } from 'node:fs';

import { getLogger, LogComponent } from '../logging/logger.js';

/** Component tag for structured logs. */
const logger = getLogger();

/** The four orb states documented in plan §2 row 5. */
export type OrbState = 'DORMANT' | 'INPUT' | 'LOADING' | 'RESULT';

export interface OrbBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface OrbPosition {
  x: number;
  y: number;
  displayId: number;
}

export interface WakeOptions {
  /** Default shortcut. Defaults to `CommandOrControl+Shift+Space`. */
  defaultShortcut?: string;
  /**
   * Treat the registered shortcut as the first half of a double-tap
   * (e.g. `Shift+=` pressed twice within `doubleTapWindowMs`).
   * Matches the daemon's `computer-use-demo` Shift++= trigger so the
   * user only has to learn one combo for the whole wake surface.
   */
  doubleTap?: boolean;
  /** Sliding window for double-tap detection. Default 600ms. */
  doubleTapWindowMs?: number;
  /** Dev URL for the orb vite entry. */
  orbDevUrl?: string;
  /** Built orb entry directory (resources/orb/ in production). */
  orbResourcesPath?: string;
  /** Bounds for each orb state. */
  bounds?: Partial<Record<OrbState, OrbBounds>>;
}

const DEFAULT_BOUNDS: Record<OrbState, OrbBounds> = {
  DORMANT: { x: 0, y: 0, width: 50, height: 50 },
  INPUT: { x: 0, y: 0, width: 320, height: 160 },
  // Wide enough to hold the ball plus the "thinking / 用 tool" progress
  // bubble INSIDE the window — at 50x50 the bubble was clipped by the OS.
  LOADING: { x: 0, y: 0, width: 220, height: 60 },
  RESULT: { x: 0, y: 0, width: 350, height: 350 },
};

let _wake: WakeService | null = null;

export interface WakeService {
  /** Idempotent — safe to call from app.whenReady. */
  initialize(): void;
  /** Triggered by globalShortcut. Opens Orb in INPUT state. */
  wake(): void;
  /** Esc / external collapse — return to DORMANT. */
  collapse(): void;
  /** Mark a wakeless turn as in-flight: suppress blur-collapse until the turn
   *  ends or a hard timeout. See the private `wakelessTurnActive` field. */
  markWakelessTurnActive(): void;
  /** Clear the in-flight marker. */
  clearWakelessTurnActive(): void;
  /** Programmatically transition to a new state. */
  setState(next: OrbState): void;
  /** Get current orb state. */
  getState(): OrbState;
  /** Persist the user's orb position. */
  setPosition(position: OrbPosition): void;
  getPosition(): OrbPosition;
  /** The lazily-created orb BrowserWindow (null before first wake). */
  getOrbWindow(): Electron.BrowserWindow | null;
  /** Listener for state transitions (used by IPC + tests). */
  onStateChange(listener: (state: OrbState) => void): () => void;
  /** Test-only: replace singleton. */
  __setForTest(replacement: WakeService | null): void;
  /**
   * Phase F (Plan session-floater): explicit new-chat reset that clears
   * the persisted session in configStore. Optional in Phase A so the IPC
   * handler can guard with `typeof === 'function'`; mandatory after
   * Phase F lands.
   */
  resetConversation?(): void;
}

class WakeServiceImpl implements WakeService {
  private orbWindow: BrowserWindow | null = null;
  private state: OrbState = 'DORMANT';

  /**
   * True while a wakeless turn is in flight. Set the moment the orb submits
   * (in the submit IPC handler, before the window is resized / the worker is
   * spawned) and cleared on collapse or a hard safety timeout. While this is
   * true the INPUT-box blur-collapse is suppressed, so a transient OS focus
   * flicker during the INPUT→LOADING hand-off (the frameless window can
   * momentarily lose focus when `setResizable` toggles in `applyBounds`, and
   * the Windows foreground lock makes this racy) cannot interrupt a turn the
   * user just started. This is the mechanism that makes LOADING "survive
   * focus changes (the agent keeps running)" as the blur handler comment
   * promises.
   */
  private wakelessTurnActive = false;
  private wakelessTurnTimer: ReturnType<typeof setTimeout> | null = null;
  private static readonly WAKLESS_TURN_MAX_MS = 5 * 60 * 1000;
  private emitter = new EventEmitter();
  private position: OrbPosition = { x: 100, y: 100, displayId: 0 };
  private registeredShortcut: string | null = null;
  private readonly opts: Required<Pick<WakeOptions,
    'defaultShortcut' | 'doubleTap' | 'doubleTapWindowMs'>> &
    Pick<WakeOptions, 'orbDevUrl' | 'orbResourcesPath' | 'bounds'>;
  /** Double-tap state. */
  private lastPressMs = 0;
  private pressCount = 0;
  private doubleTapTimer: NodeJS.Timeout | null = null;
  /** true once the orb renderer has loaded and can receive `main → orb` IPC. */
  private orbReady = false;
  /** Messages sent before the renderer was ready; replayed on did-finish-load. */
  private orbQueue: Array<{ channel: string; args: unknown[] }> = [];

  constructor(opts: WakeOptions) {
    this.opts = {
      defaultShortcut: opts.defaultShortcut ?? 'CommandOrControl+Shift+Space',
      orbDevUrl: opts.orbDevUrl,
      orbResourcesPath: opts.orbResourcesPath,
      bounds: opts.bounds,
      doubleTap: opts.doubleTap ?? false,
      doubleTapWindowMs: opts.doubleTapWindowMs ?? 600,
    };
  }

  initialize(): void {
    const shortcut = this.opts.defaultShortcut;
    try {
      // When double-tap mode is on, we register the raw shortcut and
      // intercept the callback so the wake only fires on the second
      // press within the sliding window. Otherwise the globalShortcut
      // callback directly invokes wake().
      const callback = this.opts.doubleTap
        ? () => this.handleDoubleTapPress()
        : () => this.wake();
      const ok = globalShortcut.register(shortcut, callback);
      if (!ok) {
        logger.warn(
          'Wake: globalShortcut.register returned false (likely already bound)',
          { shortcut, doubleTap: this.opts.doubleTap },
          LogComponent.Orb,
        );
      } else {
        this.registeredShortcut = shortcut;
        logger.info(
          'Wake: hotkey registered',
          {
            shortcut,
            doubleTap: this.opts.doubleTap,
            windowMs: this.opts.doubleTapWindowMs,
          },
          LogComponent.Orb,
        );
      }
    } catch (err) {
      logger.warn(
        'Wake: globalShortcut.register threw',
        {
          shortcut,
          error: err instanceof Error ? err.message : String(err),
        },
        LogComponent.Orb,
      );
    }
  }

  /**
   * Called for every press of the underlying globalShortcut when
   * doubleTap mode is on. Sliding-window detector: two presses
   * within `doubleTapWindowMs` fire `wake()`; the second press
   * resets the counter. We don't gate on `Shift held` (the daemon
   * does, but Electron's globalShortcut only fires when the modifier
   * is held so the gate is implicit).
   */
  private handleDoubleTapPress(): void {
    const now = Date.now();
    const delta = now - this.lastPressMs;
    this.pressCount = delta > this.opts.doubleTapWindowMs ? 1 : this.pressCount + 1;
    this.lastPressMs = now;

    logger.debug(
      'Wake: double-tap press',
      { count: this.pressCount, deltaMs: delta },
      LogComponent.Orb,
    );

    if (this.pressCount >= 2) {
      this.pressCount = 0;
      if (this.doubleTapTimer) {
        clearTimeout(this.doubleTapTimer);
        this.doubleTapTimer = null;
      }
      this.wake();
      return;
    }

    // Auto-reset the counter after the window elapses so a stray
    // single press doesn't sit there forever.
    if (this.doubleTapTimer) clearTimeout(this.doubleTapTimer);
    this.doubleTapTimer = setTimeout(() => {
      this.pressCount = 0;
      this.doubleTapTimer = null;
    }, this.opts.doubleTapWindowMs + 50);
  }

  wake(): void {
    // Arm the OS context bridge: the daemon keeps writing snapshots
    // regardless, but fan-out + the `isEnabled()` gate that
    // `buildContextPreamble()` / `insertTabToFocusedField()` check stays
    // off until the user actually opens the orb (privacy by default).
    // Idempotent, so re-waking an already-open orb is free.
    armOSContextBridge();
    // Already DORMANT → trigger show-input.
    if (this.state === 'DORMANT') {
      const win = this.ensureOrb();
      // Park the orb in front of the user rather than wherever it was last
      // left: the hotkey is global, so the user may be on another app,
      // another display, or another corner of this one.
      this.setState('INPUT', this.anchorPoint());
      this.sendOrb('automation:orb:show-input');
      win.show();
      win.focus();
      return;
    }
    // Already INPUT/LOADING/RESULT → bring to front, do not reset state.
    if (this.orbWindow) {
      if (this.state === 'INPUT') {
        // Resend: a renderer that missed the original event (reload mid-
        // session) would otherwise stay a ball forever in an INPUT-sized
        // window. transition('INPUT') is idempotent on the renderer side.
        this.sendOrb('automation:orb:show-input');
      }
      if (this.orbWindow.isMinimized()) this.orbWindow.restore();
      this.orbWindow.show();
      this.orbWindow.focus();
    }
  }

  collapse(): void {
    if (this.state === 'DORMANT') return;
    this.clearWakelessTurnActive();
    this.setState('DORMANT');
    this.sendOrb('automation:orb:hide');
    // Hiding the UI must also stop the worker: without this the wakeless
    // turn runs to completion on the agent server and only surfaces later
    // as a notify badge — wasted tokens and a pinned worker slot.
    void this.cancelWakelessTurn();
  }

  /** Mark a wakeless turn as in-flight: suppress blur-collapse until the turn
   *  ends or the safety timeout fires. Idempotent. */
  markWakelessTurnActive(): void {
    this.wakelessTurnActive = true;
    if (this.wakelessTurnTimer !== null) clearTimeout(this.wakelessTurnTimer);
    this.wakelessTurnTimer = setTimeout(() => {
      this.wakelessTurnActive = false;
      this.wakelessTurnTimer = null;
    }, WakeServiceImpl.WAKLESS_TURN_MAX_MS);
  }

  /** Clear the in-flight marker (turn ended, user dismissed, or re-wake). */
  clearWakelessTurnActive(): void {
    this.wakelessTurnActive = false;
    if (this.wakelessTurnTimer !== null) {
      clearTimeout(this.wakelessTurnTimer);
      this.wakelessTurnTimer = null;
    }
  }

  /** Best-effort interrupt of the in-flight wakeless turn, if any. */
  private async cancelWakelessTurn(): Promise<void> {
    try {
      const { interruptActiveWakelessChat } = await import('./orb-wakeless-chat');
      await interruptActiveWakelessChat();
    } catch {
      // best-effort — a leaked turn is not worth breaking collapse over
    }
  }

  /**
   * Send a `main → orb` message, queueing it if the renderer has not loaded
   * yet.
   *
   * The first wake creates the window and immediately pushes `show-input`,
   * but `loadURL` is async: the renderer registers its `ipcRenderer.on`
   * listeners only once React mounts, so an early send is silently dropped
   * and the orb comes up stuck on the ball while the window has already been
   * resized to the input box. `did-finish-load` is the earliest point at
   * which the listeners exist (module scripts are deferred, so they run
   * before it fires).
   */
  private sendOrb(channel: string, ...args: unknown[]): void {
    const win = this.orbWindow;
    if (!win || win.isDestroyed()) return;
    if (this.orbReady) {
      win.webContents.send(channel, ...args);
      return;
    }
    this.orbQueue.push({ channel, args });
  }

  getState(): OrbState {
    return this.state;
  }

  setPosition(position: OrbPosition): void {
    this.position = position;
    if (this.orbWindow) {
      this.applyBounds(this.state);
    }
  }

  getPosition(): OrbPosition {
    return { ...this.position };
  }

  getOrbWindow(): Electron.BrowserWindow | null {
    if (this.orbWindow && !this.orbWindow.isDestroyed()) {
      return this.orbWindow;
    }
    return null;
  }

  onStateChange(listener: (state: OrbState) => void): () => void {
    this.emitter.on('state', listener);
    return () => {
      this.emitter.off('state', listener);
    };
  }

  __setForTest(_replacement: WakeService | null): void {
    // singleton hook — see getWakeService
  }

  /**
   * Internal: change state and broadcast to listeners + UI.
   * Used by IPC handlers in `electron/ipc/orb.ts`.
   */
  setState(next: OrbState, centre?: { x: number; y: number }): void {
    if (next === this.state) return;
    this.state = next;
    this.applyBounds(next, centre);
    for (const listener of this.emitter.listeners('state')) {
      try {
        (listener as (s: OrbState) => void)(next);
      } catch {
        // swallow
      }
    }
  }

  /**
   * Where the user is working. The cursor wins: it is the only focus signal
   * that survives another application holding the keyboard, which is exactly
   * the case the global hotkey exists for. Falls back to the focused window's
   * centre, then to the orb's own parked position.
   */
  private anchorPoint(): { x: number; y: number } {
    try {
      const cursor = screen.getCursorScreenPoint();
      if (Number.isFinite(cursor.x) && Number.isFinite(cursor.y)) {
        return { x: cursor.x, y: cursor.y };
      }
    } catch {
      // screen unavailable (headless, or called before app ready)
    }
    try {
      const focused = BrowserWindow.getFocusedWindow();
      if (focused && !focused.isDestroyed()) {
        const b = focused.getBounds();
        return { x: b.x + b.width / 2, y: b.y + b.height / 2 };
      }
    } catch {
      // fall through
    }
    return { x: this.position.x, y: this.position.y };
  }

  private ensureOrb(): BrowserWindow {
    if (this.orbWindow && !this.orbWindow.isDestroyed()) {
      return this.orbWindow;
    }
    const devUrl = this.opts.orbDevUrl;
    const resourcesPath = this.opts.orbResourcesPath;
    const url = devUrl ?? (resourcesPath ? `file://${join(resourcesPath, 'index.html')}` : 'about:blank');

    const win = new BrowserWindow({
      width: DEFAULT_BOUNDS.DORMANT.width,
      height: DEFAULT_BOUNDS.DORMANT.height,
      x: this.position.x,
      y: this.position.y,
      alwaysOnTop: true,
      frame: false,
      transparent: true,
      focusable: true,
      skipTaskbar: true,
      resizable: false,
      show: false,
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        // Without the preload bundle the orb renderer has no
        // window.electronAPI: it renders the ball fine (pure SVG) but every
        // IPC in both directions is a no-op — the hotkey woke the window and
        // the renderer never learned about it.
        preload: join(__dirname, 'preload.js'),
      },
    });

    // Closing the orb window (e.g. user X) collapses to DORMANT.
    win.on('close', (event) => {
      event.preventDefault();
      this.collapse();
    });

    // Clicking anywhere outside the input box dismisses it — the input is a
    // quick capture surface, not something that lingers. Only INPUT: LOADING
    // must survive focus changes (the agent keeps running) and RESULT stays
    // until Esc or the auto-fold. While a wakeless turn is in flight the box
    // must NOT collapse on blur — a real click-away outside the box is still
    // caught (the turn flag is only set once the user actually submits), and
    // the spurious focus flicker during submit is ignored.
    win.on('blur', () => {
      if (this.state === 'INPUT' && !this.wakelessTurnActive) this.collapse();
    });

    // Flush anything the main process tried to send while the renderer was
    // still loading. See `sendOrb`.
    win.webContents.on('did-finish-load', () => {
      this.orbReady = true;
      const queued = this.orbQueue;
      this.orbQueue = [];
      for (const m of queued) {
        if (!win.isDestroyed()) win.webContents.send(m.channel, ...m.args);
      }
    });

    win.on('closed', () => {
      this.orbReady = false;
      this.orbQueue = [];
    });

    if (url.startsWith('file://') && !existsSync(url.slice('file://'.length))) {
      logger.warn(
        'Wake: orb entry not found at expected path; window will load about:blank',
        { url },
        LogComponent.Orb,
      );
      win.loadURL('about:blank');
    } else if (url !== 'about:blank') {
      void win.loadURL(url);
    }

    // Deliberately not shown here: `wake()` moves the window to the anchor
    // before the first paint, so it never flashes at the old parked spot.
    this.orbWindow = win;
    return win;
  }

  private applyBounds(state: OrbState, centre?: { x: number; y: number }): void {
    if (!this.orbWindow || this.orbWindow.isDestroyed()) return;
    const spec = this.opts.bounds?.[state] ?? DEFAULT_BOUNDS[state];
    const bounds = centre
      ? this.boundsNear(centre, state)
      : {
          // Snap to the parked position unless the state declares its own x/y.
          x: spec.x !== 0 ? spec.x : this.position.x,
          y: spec.y !== 0 ? spec.y : this.position.y,
          width: spec.width,
          height: spec.height,
        };
    // Remember where we landed so the following states (LOADING → RESULT →
    // DORMANT) keep the orb in one place instead of snapping back.
    this.position = { ...this.position, x: bounds.x, y: bounds.y };
    // Windows silently ignores setBounds on non-resizable windows, so the
    // window must be made resizable for the duration of the call. The orb
    // stays resizable:false while idle to avoid frameless edge-drag zones.
    const win = this.orbWindow;
    try {
      win.setResizable(true);
      win.setBounds(bounds);
    } finally {
      win.setResizable(false);
    }
  }

  /**
   * Bounds for `state` centred on `centre`, clamped to the work area of the
   * display it lands on. Clamping matters on the edges and with multiple
   * monitors, where an unclamped centre would push the box off-screen or
   * straddle two displays.
   */
  private boundsNear(
    centre: { x: number; y: number },
    state: OrbState,
  ): OrbBounds {
    const bounds = this.opts.bounds?.[state] ?? DEFAULT_BOUNDS[state];
    let area: Electron.Rectangle | undefined;
    try {
      area = screen.getDisplayNearestPoint(centre).workArea;
    } catch {
      area = undefined;
    }
    const clamp = (v: number, min: number, max: number) =>
      Math.min(Math.max(v, min), max);
    const x = area
      ? clamp(
          centre.x - bounds.width / 2,
          area.x,
          Math.max(area.x, area.x + area.width - bounds.width),
        )
      : centre.x - bounds.width / 2;
    const y = area
      ? clamp(
          centre.y - bounds.height / 2,
          area.y,
          Math.max(area.y, area.y + area.height - bounds.height),
        )
      : centre.y - bounds.height / 2;
    return {
      x: Math.round(x),
      y: Math.round(y),
      width: bounds.width,
      height: bounds.height,
    };
  }
}

/**
 * Arm the OSContextBridge in the main process (idempotent).
 *
 * Both `buildContextPreamble()` (orb context injection) and
 * `insertTabToFocusedField()` (Insert Tab) refuse to do anything while
 * `bridge.isEnabled()` is false — and nothing ever enabled it. The only
 * `enable()` call in the tree lives in the agent *worker* process
 * (`computer-use-mode.ts`), which is a different singleton, so the orb
 * ended up with an always-empty context preamble and an Insert Tab that
 * could never succeed.
 *
 * `start()` spins the watcher (idempotent — it keeps the latest daemon
 * payload warm so the first wake already has a snapshot); `enable()` flips
 * the consume gate. Called from every orb entry point: hotkey wake (via
 * `wake()`) and the ball-click / open-result paths in `ipc/orb.ts`, which
 * bypass `WakeService.wake()` entirely.
 *
 * Deliberately never disabled: a result delivered while the orb is DORMANT
 * is re-opened through `open-result`, and Insert Tab on that card still
 * needs the gate open. Nothing subscribes in the main process, so leaving
 * it enabled costs nothing beyond the flag.
 */
export function armOSContextBridge(): void {
  try {
    void import('../../packages/agent/dist/context/os-context/index.js')
      .then(({ getOSContextBridge }) => {
        const bridge = getOSContextBridge();
        void bridge.start().catch(() => {});
        bridge.enable();
      })
      .catch(() => {
        // bridge unavailable — orb degrades to a plain-prompt turn
      });
  } catch {
    // ignore
  }
}

/** Initialize the singleton. Call from app.whenReady. */
export function initializeWakeService(opts: WakeOptions = {}): WakeService {
  if (_wake) {
    throw new Error('WakeService singleton already initialized');
  }
  _wake = new WakeServiceImpl(opts);
  _wake.initialize();
  return _wake;
}

export function getWakeService(): WakeService {
  if (!_wake) {
    throw new Error('WakeService not initialized');
  }
  return _wake;
}

/** Test-only: reset singleton. */
export function __resetWakeService(): void {
  if (_wake) {
    try {
      globalShortcut.unregisterAll();
    } catch {
      // ignore
    }
  }
  _wake = null;
}

/** Helper: pick a sensible default orb position for the user's display. */
export function defaultOrbPosition(): OrbPosition {
  try {
    const primary = screen.getPrimaryDisplay();
    return {
      x: Math.max(20, primary.workArea.x + 20),
      y: Math.max(20, primary.workArea.y + 20),
      displayId: primary.id,
    };
  } catch {
    return { x: 100, y: 100, displayId: 0 };
  }
}

// Ensure app reference is used (some bundlers tree-shake otherwise).
void app;