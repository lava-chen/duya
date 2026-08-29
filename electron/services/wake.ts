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
  INPUT: { x: 0, y: 0, width: 280, height: 100 },
  LOADING: { x: 0, y: 0, width: 50, height: 50 },
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
}

class WakeServiceImpl implements WakeService {
  private orbWindow: BrowserWindow | null = null;
  private state: OrbState = 'DORMANT';
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
    // Already DORMANT → trigger show-input.
    if (this.state === 'DORMANT') {
      this.ensureOrb();
      this.setState('INPUT');
      this.applyBounds('INPUT');
      this.orbWindow?.webContents.send('automation:orb:show-input');
      return;
    }
    // Already INPUT/LOADING/RESULT → bring to front, do not reset state.
    if (this.orbWindow) {
      if (this.orbWindow.isMinimized()) this.orbWindow.restore();
      this.orbWindow.show();
      this.orbWindow.focus();
    }
  }

  collapse(): void {
    if (this.state === 'DORMANT') return;
    this.setState('DORMANT');
    this.applyBounds('DORMANT');
    this.orbWindow?.webContents.send('automation:orb:hide');
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
  setState(next: OrbState): void {
    if (next === this.state) return;
    this.state = next;
    this.applyBounds(next);
    for (const listener of this.emitter.listeners('state')) {
      try {
        (listener as (s: OrbState) => void)(next);
      } catch {
        // swallow
      }
    }
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
      },
    });

    // Closing the orb window (e.g. user X) collapses to DORMANT.
    win.on('close', (event) => {
      event.preventDefault();
      this.collapse();
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

    win.show();
    this.orbWindow = win;
    return win;
  }

  private applyBounds(state: OrbState): void {
    if (!this.orbWindow || this.orbWindow.isDestroyed()) return;
    const bounds = this.opts.bounds?.[state] ?? DEFAULT_BOUNDS[state];
    // Snap to current position unless we have state-specific x/y.
    const next = {
      x: bounds.x !== 0 ? bounds.x : this.position.x,
      y: bounds.y !== 0 ? bounds.y : this.position.y,
      width: bounds.width,
      height: bounds.height,
    };
    this.orbWindow.setBounds(next);
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