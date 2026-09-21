/**
 * services/recorder/badge.ts — the always-visible recording badge
 * (plan 556 Phase 5, design §4.8).
 *
 * "显式开启 + badge 常显可停" is the privacy model's middle pillar
 * (design §4.9): once a recording starts the user must be able to see
 * it and stop it without hunting for a window. So the badge is an
 * independent, always-on-top, click-through-free pill docked top-centre
 * — NOT a dialog in the duya window, which the user may have minimised
 * or be looking away from.
 *
 * Same construction as the computer-use control overlay
 * (services/computer-use-overlay.ts): a frameless transparent
 * BrowserWindow loading a data: URL, polled through executeJavaScript.
 * Two deliberate differences:
 *
 *   - `setContentProtection(true)` keeps the badge out of every
 *     desktopCapturer frame, so a recording never captures its own
 *     badge and a later computer-use run cannot see it either.
 *   - It never steals focus (`showInactive`) so it cannot become the
 *     foreground window and get recorded as an app_focus event.
 *
 * The badge holds no state of its own: `updateRecorderBadge` is fed by
 * the recorder service's status snapshots, and the two buttons resolve
 * to injected handlers (wired in ipc/recorder-handlers.ts).
 *
 * Logging discipline (AGENTS.md red line): counts and state only.
 */

import { BrowserWindow, screen } from 'electron';

import { getLogger, LogComponent } from '../../logging/logger.js';

const logger = getLogger();

/** Poll cadence for the button flags (matches the overlay's 200ms feel). */
const POLL_INTERVAL_MS = 400;

export interface RecorderBadgeSnapshot {
  /** Pre-formatted duration, e.g. "01:23". */
  duration: string;
  eventCount: number;
  /** True when the hook worker died through its restart budget. */
  degraded: boolean;
}

export interface RecorderBadgeHandlers {
  /** Stop and KEEP the session (it lands in the recordings list). */
  onStop: () => void;
  /** Stop and DISCARD the session. */
  onCancel: () => void;
}

const BADGE_WIDTH = 268;
const BADGE_HEIGHT = 40;

const BADGE_HTML =
  'data:text/html;charset=utf-8,' +
  encodeURIComponent(`<!doctype html>
<html><head><style>
  html, body { margin: 0; background: transparent; overflow: hidden;
    font-family: 'Segoe UI', system-ui, sans-serif; user-select: none; }
  #bar {
    display: flex; align-items: center; gap: 8px;
    padding: 5px 6px 5px 12px; border-radius: 9999px;
    background: rgba(24, 24, 27, 0.88);
    border: 1px solid rgba(239, 68, 68, 0.45);
    box-shadow: 0 2px 14px rgba(0, 0, 0, 0.4);
    width: max-content;
  }
  #dot { width: 8px; height: 8px; border-radius: 50%; background: #ef4444;
    animation: rec 1.6s ease-in-out infinite; flex: none; }
  @keyframes rec { 0%, 100% { opacity: 1; } 50% { opacity: 0.25; } }
  #meta { color: #fee2e2; font-size: 12px; line-height: 1; white-space: nowrap; }
  #meta .degraded { color: #fbbf24; }
  button {
    border: none; cursor: pointer; border-radius: 9999px; height: 26px;
    padding: 0 10px; font-size: 11px; line-height: 1;
    display: flex; align-items: center; gap: 4px;
  }
  #stop { background: rgba(239, 68, 68, 0.22); color: #fecaca; }
  #stop:hover { background: rgba(239, 68, 68, 0.38); }
  #cancel { background: transparent; color: #a1a1aa; }
  #cancel:hover { background: rgba(255, 255, 255, 0.08); color: #e4e4e7; }
</style></head>
<body><div id="bar">
  <span id="dot"></span>
  <span id="meta">录制中</span>
  <button id="stop" title="停止录制并保留">停止</button>
  <button id="cancel" title="停止并丢弃本次录制">取消</button>
</div>
<script>
  document.getElementById('stop').addEventListener('click', function () {
    window.__recorderAction = 'stop';
  });
  document.getElementById('cancel').addEventListener('click', function () {
    window.__recorderAction = 'cancel';
  });
</script></body></html>`);

let badgeWindow: BrowserWindow | null = null;
let pollTimer: NodeJS.Timeout | null = null;
let handlers: RecorderBadgeHandlers | null = null;

/** Wire the badge's buttons. Called once from the IPC registration. */
export function setRecorderBadgeHandlers(next: RecorderBadgeHandlers): void {
  handlers = next;
}

/** Show the badge (idempotent) — a no-op outside a real app.whenReady. */
export function showRecorderBadge(): void {
  try {
    if (!badgeWindow || badgeWindow.isDestroyed()) {
      badgeWindow = createBadgeWindow();
      startPolling(badgeWindow);
      logger.info('recorder: badge shown', undefined, LogComponent.ComputerUse);
    }
    badgeWindow.showInactive();
  } catch (err) {
    // The badge is an affordance, not the mechanism — a failure here
    // must never prevent a recording from running.
    logger.warn(
      'recorder: failed to show badge',
      { error: err instanceof Error ? err.message : String(err) },
      LogComponent.ComputerUse,
    );
  }
}

/** Hide and release the badge. Safe to call when never shown. */
export function hideRecorderBadge(): void {
  stopPolling();
  if (badgeWindow && !badgeWindow.isDestroyed()) {
    badgeWindow.destroy();
  }
  badgeWindow = null;
}

export function isRecorderBadgeVisible(): boolean {
  return badgeWindow !== null && !badgeWindow.isDestroyed();
}

/**
 * Push a fresh status snapshot into the badge. Never throws: the badge
 * is display-only and a stale label is better than a crash.
 */
export function updateRecorderBadge(snapshot: RecorderBadgeSnapshot): void {
  const win = badgeWindow;
  if (!win || win.isDestroyed()) return;
  const text = `录制中 ${snapshot.duration} · ${snapshot.eventCount} 事件`;
  const degraded = snapshot.degraded ? '（输入钩子已降级）' : '';
  void win.webContents
    .executeJavaScript(
      `(function () {
        var el = document.getElementById('meta');
        if (el) el.textContent = ${JSON.stringify(text + degraded)};
        return true;
      })()`,
      true,
    )
    .catch(() => {
      // Page not ready yet; the next tick retries.
    });
}

function createBadgeWindow(): BrowserWindow {
  const display = screen.getPrimaryDisplay().bounds;
  const win = new BrowserWindow({
    x: display.x + Math.floor((display.width - BADGE_WIDTH) / 2),
    y: display.y + 6,
    width: BADGE_WIDTH,
    height: BADGE_HEIGHT,
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
  // Clickable (that is the point) but invisible to any capture — neither
  // this recording nor a later computer-use run may see the badge.
  win.setContentProtection(true);
  void win.loadURL(BADGE_HTML);
  win.once('ready-to-show', () => win.showInactive());
  return win;
}

function startPolling(win: BrowserWindow): void {
  stopPolling();
  pollTimer = setInterval(() => {
    if (win.isDestroyed()) {
      stopPolling();
      return;
    }
    void win.webContents
      .executeJavaScript('window.__recorderAction || null', true)
      .then((action) => {
        if (action !== 'stop' && action !== 'cancel') return;
        // Clear first: the handler may destroy the window, and a stale
        // flag would re-fire on a later mount.
        void win.webContents
          .executeJavaScript('(window.__recorderAction = null)', true)
          .catch(() => undefined);
        if (action === 'stop') handlers?.onStop();
        else handlers?.onCancel();
      })
      .catch(() => {
        // Page not ready yet; next tick retries.
      });
  }, POLL_INTERVAL_MS);
  pollTimer.unref?.();
}

function stopPolling(): void {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
}
