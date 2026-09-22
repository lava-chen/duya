/**
 * services/overlay/index.ts — element-tree visualization overlay
 * (plan 562 Phase 3).
 *
 * A single transparent, click-through, always-on-top BrowserWindow
 * covering the display that contains the enumerated elements. The page
 * draws one rect + index badge per interactive element so the user can
 * aim clicks at numbered targets while recording (plan 562 D6: the
 * overlay is passive — clicks pass through to the REAL elements and
 * are captured by the hook worker + probe attach; the overlay never
 * takes input).
 *
 * Modeled on `electron/services/computer-use-overlay.ts`: data-URL
 * page, no preload, `setIgnoreMouseEvents(true)`, and content
 * protection ON so desktop captures never show the frames to the model.
 * Like the stop chip, the page hardcodes its colors — design tokens do
 * not exist inside a sandboxed data-URL page, so it mirrors the badge
 * chip style (dark surface + purple accent).
 *
 * Renderer-side defense (plan 562 §5 缺口2): the page re-asserts the
 * interactive whitelist on EVERY draw — the enumerate side already
 * filters, but this channel may be fed from anywhere, so anything
 * without a whitelisted ControlType, a usable rect, or interactive !==
 * false is dropped rather than drawn. SOM capture-channel elements are
 * not accepted on this channel at all (they carry no `interactive`
 * provenance).
 *
 * Lifecycle: `overlay:show-elements` shows/refreshes; `overlay:clear`,
 * recorder stop, and display metrics changes tear the window down (it
 * is rebuilt on the next show, so a resolution/monitor change can never
 * leave a stale-positioned frame behind).
 */

import { BrowserWindow, screen } from 'electron';

import { getLogger, LogComponent } from '../../logging/logger.js';

const logger = getLogger();

let overlayWindow: BrowserWindow | null = null;
let screenListenersWired = false;

// ────────────────────────────────────────────────────────────────────
// Page (no preload — data URL + executeJavaScript injection)
// ────────────────────────────────────────────────────────────────────

/** Mirror of DEFAULT_INTERACTIVE_CONTROL_TYPES (packages/computer-use). */
const PAGE_WHITELIST = [
  'button', 'edit', 'hyperlink', 'checkbox', 'radiobutton', 'combobox',
  'tabitem', 'menuitem', 'slider', 'listitem', 'toggleswitch',
];

const OVERLAY_HTML =
  'data:text/html;charset=utf-8,' +
  encodeURIComponent(`<!doctype html>
<html><head><style>
  html, body { margin: 0; padding: 0; background: transparent; overflow: hidden;
    font-family: 'Segoe UI', system-ui, sans-serif; user-select: none; }
  .frame {
    position: absolute;
    border: 1.5px solid rgba(168, 85, 247, 0.9);
    border-radius: 4px;
    background: rgba(168, 85, 247, 0.08);
    pointer-events: none;
  }
  .badge {
    position: absolute;
    min-width: 16px; height: 16px;
    padding: 0 4px;
    border-radius: 9999px;
    background: rgba(24, 24, 27, 0.85);
    border: 1px solid rgba(168, 85, 247, 0.55);
    color: #e9d5ff;
    font-size: 10px; line-height: 14px;
    text-align: center;
    pointer-events: none;
  }
</style></head>
<body><div id="elements"></div>
<script>
  var WHITELIST = ${JSON.stringify(PAGE_WHITELIST)};

  // Renderer-side defense (plan 562 §5 缺口2): re-assert the interactive
  // whitelist on the consuming side. Anything without a whitelisted
  // ControlType, a usable rect, or interactive !== false is dropped.
  function isInteractive(el) {
    if (!el || el.interactive === false) return false;
    var r = el.rect;
    if (!r || !(r.w > 0) || !(r.h > 0)) return false;
    var t = (el.controlType || '').toLowerCase();
    if (!t) return false;
    return WHITELIST.indexOf(t) !== -1;
  }

  window.__overlayShow = function (raw) {
    var list;
    try { list = JSON.parse(raw); } catch (e) { list = null; }
    if (!Array.isArray(list)) list = [];
    var origin = window.__overlayOrigin || { x: 0, y: 0 };
    var root = document.getElementById('elements');
    root.innerHTML = '';
    var count = 0;
    for (var i = 0; i < list.length; i++) {
      var el = list[i];
      if (!isInteractive(el)) continue;
      count++;
      var r = el.rect;
      var frame = document.createElement('div');
      frame.className = 'frame';
      frame.style.left = (r.x - origin.x) + 'px';
      frame.style.top = (r.y - origin.y) + 'px';
      frame.style.width = r.w + 'px';
      frame.style.height = r.h + 'px';
      var badge = document.createElement('span');
      badge.className = 'badge';
      badge.textContent = String(count);
      badge.style.left = (r.x - origin.x) + 'px';
      badge.style.top = (r.y - origin.y - 8) + 'px';
      root.appendChild(frame);
      root.appendChild(badge);
    }
    window.__overlayCount = count;
    window.__overlayRenderedAt = Date.now();
  };
</script></body></html>`);

// ────────────────────────────────────────────────────────────────────
// Window management
// ────────────────────────────────────────────────────────────────────

function createOverlayWindow(displayBounds: Electron.Rectangle): BrowserWindow {
  const win = new BrowserWindow({
    x: displayBounds.x,
    y: displayBounds.y,
    width: displayBounds.width,
    height: displayBounds.height,
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
  // Never steal focus, never intercept clicks, never appear in captures.
  win.setAlwaysOnTop(true, 'screen-saver');
  win.setIgnoreMouseEvents(true);
  win.setContentProtection(true);
  void win.loadURL(OVERLAY_HTML);
  win.once('ready-to-show', () => win.showInactive());
  return win;
}

function destroyOverlayWindow(): void {
  if (overlayWindow && !overlayWindow.isDestroyed()) {
    overlayWindow.destroy();
  }
  overlayWindow = null;
}

/**
 * Rebuild on display/monitor/scale changes: a stale window would draw
 * frames at outdated positions. The window is recreated lazily by the
 * next show, so a metrics change mid-idle costs nothing.
 */
function wireScreenListeners(): void {
  if (screenListenersWired) {
    return;
  }
  screenListenersWired = true;
  screen.on('display-metrics-changed', () => {
    if (overlayWindow) {
      logger.debug('overlay: display metrics changed — rebuilding on next show', undefined, LogComponent.ComputerUse);
      destroyOverlayWindow();
    }
  });
  screen.on('display-removed', () => {
    if (overlayWindow) {
      destroyOverlayWindow();
    }
  });
}

interface RectLike {
  x: number;
  y: number;
  w: number;
  h: number;
}

function rectOf(entry: Record<string, unknown>): RectLike | null {
  const rect = entry['rect'];
  if (typeof rect !== 'object' || rect === null) {
    return null;
  }
  const r = rect as Record<string, unknown>;
  if (
    typeof r['x'] !== 'number' ||
    typeof r['y'] !== 'number' ||
    typeof r['w'] !== 'number' ||
    typeof r['h'] !== 'number'
  ) {
    return null;
  }
  return { x: r['x'], y: r['y'], w: r['w'], h: r['h'] };
}

// ────────────────────────────────────────────────────────────────────
// Public API (wired in electron/ipc/recorder-handlers.ts)
// ────────────────────────────────────────────────────────────────────

/**
 * Show (or refresh) the element frames. `elements` must already be
 * structurally validated (sanitizeOverlayElements); the page applies
 * the semantic interactive filter on top. Cosmetic failures are logged
 * and swallowed — the overlay must never break the recording pipeline.
 */
export function showOverlayElements(elements: readonly Record<string, unknown>[]): void {
  try {
    wireScreenListeners();

    // Cover the display that holds the union of the element rects
    // (fallback: primary display when no rect is usable).
    let union: RectLike | null = null;
    for (const entry of elements) {
      const rect = rectOf(entry);
      if (!rect) continue;
      union = union
        ? {
            x: Math.min(union.x, rect.x),
            y: Math.min(union.y, rect.y),
            w: Math.max(union.x + union.w, rect.x + rect.w) - Math.min(union.x, rect.x),
            h: Math.max(union.y + union.h, rect.y + rect.h) - Math.min(union.y, rect.y),
          }
        : rect;
    }
    const display = union
      ? screen.getDisplayMatching({ x: union.x, y: union.y, width: union.w, height: union.h })
      : screen.getPrimaryDisplay();

    if (!overlayWindow || overlayWindow.isDestroyed()) {
      overlayWindow = createOverlayWindow(display.bounds);
    } else {
      const bounds = overlayWindow.getBounds();
      if (
        bounds.x !== display.bounds.x ||
        bounds.y !== display.bounds.y ||
        bounds.width !== display.bounds.width ||
        bounds.height !== display.bounds.height
      ) {
        destroyOverlayWindow();
        overlayWindow = createOverlayWindow(display.bounds);
      }
    }

    const origin = display.bounds;
    const payload = JSON.stringify({
      origin: { x: origin.x, y: origin.y },
    });
    const win = overlayWindow;
    // Set the display origin first (draw coords are display-relative),
    // then inject the element list as a JSON STRING (double stringify
    // keeps the page from evaluating anything).
    void win.webContents
      .executeJavaScript(`window.__overlayOrigin = ${payload}; true;`)
      .then(() =>
        win.webContents.executeJavaScript(
          `window.__overlayShow(${JSON.stringify(JSON.stringify(elements))}); true;`,
        ),
      )
      .catch(() => {
        // Page not ready yet or window torn down — next show retries.
      });

    logger.debug(
      'overlay: showing elements',
      { count: elements.length, displayId: display.id },
      LogComponent.ComputerUse,
    );
  } catch (err) {
    logger.warn(
      'overlay: failed to show elements',
      { error: err instanceof Error ? err.message : String(err) },
      LogComponent.ComputerUse,
    );
  }
}

/** Hide the overlay (recorder stop / overlay:clear / shutdown). */
export function clearOverlayElements(): void {
  if (overlayWindow) {
    destroyOverlayWindow();
    logger.debug('overlay: cleared', undefined, LogComponent.ComputerUse);
  }
}

export function isElementOverlayActive(): boolean {
  return overlayWindow !== null && !overlayWindow.isDestroyed();
}
