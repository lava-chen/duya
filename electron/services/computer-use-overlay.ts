/**
 * computer-use-overlay.ts — Visual indicator while the AI drives the
 * desktop (user request 2026-08-29).
 *
 * Two pieces, both owned by the Electron main process:
 *
 *   1. Glow overlay — a transparent, click-through, always-on-top
 *      window covering the primary display with an animated purple
 *      border, so the user always sees when the agent is in control.
 *      Content protection is ON so desktopCapturer never records it
 *      (the model must not see its own indicator).
 *   2. Stop control — a small always-on-top chip docked top-center,
 *      styled like the chat input bar: a rounded-full container with
 *      a circular stop icon-button inside. Pressing it hides the
 *      overlay and revokes control: subsequent computer_use actions
 *      fail with USER_REJECTED until the TTL expires. Click handling
 *      polls a page flag via executeJavaScript (no preload needed).
 *
 * The cursor halo was removed (user feedback 2026-08-29) — the glow
 * border alone marks agent control.
 *
 * Lifecycle: runAction calls `showComputerUseOverlay` on every
 * computer_use invocation (recreating windows if needed and resetting
 * an idle timer), and the agent-process-pool calls
 * `hideComputerUseOverlayForSession` when an agent process exits, so
 * the indicator disappears as soon as the session is over.
 */

import { BrowserWindow, screen } from 'electron';

import { getLogger, LogComponent } from '../logging/logger.js';

const logger = getLogger();

/** Hide the indicator after this long without a computer_use action. */
const IDLE_HIDE_MS = 120_000;

/**
 * After the user presses stop, computer_use actions are refused for
 * this long. Long enough to abort the current run; short enough that
 * the next explicit task in the same session is not blocked.
 */
const REVOKE_TTL_MS = 120_000;

let glowWindow: BrowserWindow | null = null;
let stopWindow: BrowserWindow | null = null;
let idleTimer: NodeJS.Timeout | null = null;
let stopPollTimer: NodeJS.Timeout | null = null;
let revokedUntil = 0;

/** Session whose actions last showed the overlay (exit linkage). */
let activeSessionId: string | undefined;

// ────────────────────────────────────────────────────────────────────
// Page HTML (no preload — data URLs + executeJavaScript only)
// ────────────────────────────────────────────────────────────────────

const GLOW_HTML =
  'data:text/html;charset=utf-8,' +
  encodeURIComponent(`<!doctype html>
<html><head><style>
  html, body { margin: 0; padding: 0; background: transparent; overflow: hidden; }
  #glow {
    position: fixed; inset: 0; pointer-events: none;
    box-shadow: inset 0 0 14px 4px rgba(168, 85, 247, 0.55);
    border: 3px solid transparent;
    border-image: linear-gradient(120deg, #a855f7, #7c3aed, #c084fc, #a855f7) 1;
    animation: pulse 2.2s ease-in-out infinite;
  }
  @keyframes pulse {
    0%, 100% { opacity: 0.85; } 50% { opacity: 0.45; }
  }
</style></head>
<body><div id="glow"></div></body></html>`);

// Styled after the chat input bar (MessageInput.tsx): a rounded-full
// surface with a circular icon-button inside, StopIcon = small square.
const STOP_HTML =
  'data:text/html;charset=utf-8,' +
  encodeURIComponent(`<!doctype html>
<html><head><style>
  html, body { margin: 0; background: transparent; overflow: hidden;
    font-family: 'Segoe UI', system-ui, sans-serif; user-select: none; }
  #bar {
    display: flex; align-items: center; gap: 8px;
    padding: 4px 12px 4px 4px; border-radius: 9999px;
    background: rgba(24, 24, 27, 0.85);
    border: 1px solid rgba(168, 85, 247, 0.35);
    box-shadow: 0 2px 12px rgba(0, 0, 0, 0.35);
    width: max-content;
  }
  #stop {
    width: 26px; height: 26px; border-radius: 50%;
    border: none; cursor: pointer;
    background: rgba(239, 68, 68, 0.2);
    display: flex; align-items: center; justify-content: center;
  }
  #stop:hover { background: rgba(239, 68, 68, 0.35); }
  #stop svg { display: block; }
  #label { color: #e9d5ff; font-size: 12px; line-height: 1; }
</style></head>
<body><div id="bar">
  <button id="stop" title="停止电脑操控">
    <svg width="11" height="11" viewBox="0 0 12 12">
      <rect x="1" y="1" width="10" height="10" rx="2" fill="#f87171"/>
    </svg>
  </button>
  <span id="label">停止电脑操控</span>
</div>
<script>
  document.getElementById('stop').addEventListener('click', function () {
    window.__stopRequested = true;
  });
</script></body></html>`);

// ────────────────────────────────────────────────────────────────────
// Window management
// ────────────────────────────────────────────────────────────────────

function createGlowWindow(): BrowserWindow {
  const bounds = screen.getPrimaryDisplay().bounds;
  const win = new BrowserWindow({
    x: bounds.x,
    y: bounds.y,
    width: bounds.width,
    height: bounds.height,
    frame: false,
    transparent: true,
    resizable: false,
    movable: false,
    focusable: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    hasShadow: false,
    fullscreenable: false,
    show: false,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
    },
  });
  // Never steal focus, never intercept clicks, and never appear in
  // captures the model receives.
  win.setAlwaysOnTop(true, 'screen-saver');
  win.setIgnoreMouseEvents(true);
  win.setContentProtection(true);
  void win.loadURL(GLOW_HTML);
  win.once('ready-to-show', () => win.showInactive());
  return win;
}

function createStopWindow(): BrowserWindow {
  const display = screen.getPrimaryDisplay().bounds;
  const width = 150;
  const height = 36;
  const win = new BrowserWindow({
    x: display.x + Math.floor((display.width - width) / 2),
    y: display.y + 6,
    width,
    height,
    frame: false,
    transparent: true,
    resizable: false,
    movable: false,
    focusable: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    hasShadow: false,
    show: false,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
    },
  });
  win.setAlwaysOnTop(true, 'screen-saver');
  // Clickable (no ignoreMouseEvents) — that's the whole point.
  win.setContentProtection(true);
  void win.loadURL(STOP_HTML);
  win.once('ready-to-show', () => win.showInactive());
  return win;
}

function startStopPolling(win: BrowserWindow): void {
  stopStopPolling();
  stopPollTimer = setInterval(() => {
    if (win.isDestroyed()) {
      stopStopPolling();
      return;
    }
    void win.webContents
      .executeJavaScript('window.__stopRequested === true')
      .then((requested) => {
        if (requested === true) {
          revokeComputerUseControl();
        }
      })
      .catch(() => {
        // Page not ready yet; next tick retries.
      });
  }, 200);
}

function stopStopPolling(): void {
  if (stopPollTimer) {
    clearInterval(stopPollTimer);
    stopPollTimer = null;
  }
}

function hideWindows(): void {
  stopStopPolling();
  if (glowWindow && !glowWindow.isDestroyed()) {
    glowWindow.destroy();
  }
  glowWindow = null;
  if (stopWindow && !stopWindow.isDestroyed()) {
    stopWindow.destroy();
  }
  stopWindow = null;
  activeSessionId = undefined;
}

// ────────────────────────────────────────────────────────────────────
// Public API (used by electron/ipc/computer-use.ts runAction and the
// agent-process-pool exit handler)
// ────────────────────────────────────────────────────────────────────

/**
 * Show (or refresh) the control indicator. Called on every
 * computer_use action; also resets the idle auto-hide timer.
 */
export function showComputerUseOverlay(sessionId?: string): void {
  activeSessionId = sessionId;
  try {
    if (!glowWindow || glowWindow.isDestroyed()) {
      glowWindow = createGlowWindow();
      logger.info(
        'computer-use: control overlay shown',
        { sessionId: sessionId ?? null },
        LogComponent.ComputerUse,
      );
    }
    if (!stopWindow || stopWindow.isDestroyed()) {
      stopWindow = createStopWindow();
      startStopPolling(stopWindow);
    }
  } catch (err) {
    // Overlay is cosmetic — never let it break the action.
    logger.warn(
      'computer-use: failed to show control overlay',
      { error: err instanceof Error ? err.message : String(err) },
      LogComponent.ComputerUse,
    );
  }

  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = setTimeout(() => {
    logger.info('computer-use: overlay idle — hiding', undefined, LogComponent.ComputerUse);
    hideWindows();
  }, IDLE_HIDE_MS);
}

/** Immediately hide the indicator (mode exit / app shutdown). */
export function hideComputerUseOverlay(): void {
  if (idleTimer) {
    clearTimeout(idleTimer);
    idleTimer = null;
  }
  hideWindows();
}

/**
 * Hide the indicator when an agent process exits — called from the
 * process pool's exit handler. Only hides when the overlay is still
 * showing for THAT session, so a parallel session keeps its indicator.
 */
export function hideComputerUseOverlayForSession(sessionId: string): void {
  if (activeSessionId === sessionId) {
    logger.info(
      'computer-use: agent process exited — hiding overlay',
      { sessionId },
      LogComponent.ComputerUse,
    );
    hideComputerUseOverlay();
  }
}

export function isComputerUseOverlayActive(): boolean {
  return glowWindow !== null && !glowWindow.isDestroyed();
}

/**
 * User pressed stop: hide the indicator and refuse further
 * computer_use actions until the TTL lapses.
 */
export function revokeComputerUseControl(): void {
  revokedUntil = Date.now() + REVOKE_TTL_MS;
  logger.info(
    'computer-use: control revoked by user (stop button)',
    { ttlMs: REVOKE_TTL_MS },
    LogComponent.ComputerUse,
  );
  hideComputerUseOverlay();
}

/** True while a stop-button revocation is in force. */
export function isComputerUseControlRevoked(): boolean {
  return Date.now() < revokedUntil;
}
