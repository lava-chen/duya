/**
 * window-state.ts — persist the main window's bounds across restarts.
 *
 * Plan 331 Phase 3. A single JSON file at `{userData}/window-state.json`
 * stores the last `x/y/width/height/maximized`. The file is written
 * atomically (tmp + rename) so a crash mid-write cannot corrupt it.
 *
 * Bounds are validated against the current display layout on read — if
 * the saved window would land entirely off-screen (e.g. an external
 * monitor was disconnected), it falls back to the defaults so the window
 * never appears "lost".
 */

import { app, screen, type Rectangle } from 'electron';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { getLogger, LogComponent } from '../logging/logger';

export interface WindowState extends Rectangle {
  /** True if the window was maximized when last saved. */
  maximized: boolean;
}

const STATE_FILE = 'window-state.json';

function getStatePath(): string {
  return path.join(app.getPath('userData'), STATE_FILE);
}

/**
 * Returns the saved window state, or `null` if no state file exists,
 * the file is unreadable, or the saved bounds are entirely off-screen.
 *
 * "Entirely off-screen" means no intersection with any display's
 * work area — a window that is merely partially clipped is kept
 * (Electron will nudge it on-screen).
 */
export function loadWindowState(): WindowState | null {
  const logger = getLogger();
  try {
    const statePath = getStatePath();
    if (!fs.existsSync(statePath)) return null;
    const raw = fs.readFileSync(statePath, 'utf-8');
    const parsed = JSON.parse(raw) as Partial<WindowState>;

    if (
      typeof parsed.x !== 'number' ||
      typeof parsed.y !== 'number' ||
      typeof parsed.width !== 'number' ||
      typeof parsed.height !== 'number'
    ) {
      logger.warn('window-state.json has invalid shape, ignoring', { raw }, LogComponent.Main);
      return null;
    }

    const bounds: Rectangle = {
      x: parsed.x,
      y: parsed.y,
      width: parsed.width,
      height: parsed.height,
    };
    if (!isBoundsVisible(bounds)) {
      logger.warn(
        'Saved window bounds are off-screen, falling back to defaults',
        { bounds },
        LogComponent.Main,
      );
      return null;
    }

    return {
      ...bounds,
      maximized: parsed.maximized === true,
    };
  } catch (error) {
    getLogger().warn(
      'Failed to load window state',
      error instanceof Error ? error : new Error(String(error)),
      LogComponent.Main,
    );
    return null;
  }
}

/**
 * Atomically persist the window state. Writes to a `.tmp` sibling first,
 * then renames over the target so a partial write never replaces a
 * previously-good state.
 */
export function saveWindowState(state: WindowState): void {
  const logger = getLogger();
  try {
    const statePath = getStatePath();
    const tmpPath = `${statePath}.tmp`;
    const dir = path.dirname(statePath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(tmpPath, JSON.stringify(state), 'utf-8');
    fs.renameSync(tmpPath, statePath);
  } catch (error) {
    logger.warn(
      'Failed to save window state',
      error instanceof Error ? error : new Error(String(error)),
      LogComponent.Main,
    );
  }
}

/**
 * True if `bounds` intersects any display's work area. Used to reject
 * stale bounds that would place the window on a disconnected monitor.
 */
function isBoundsVisible(bounds: Rectangle): boolean {
  const displays = screen.getAllDisplays();
  if (displays.length === 0) return true; // headless test env — trust the caller.
  for (const display of displays) {
    if (rectIntersects(bounds, display.workArea)) return true;
  }
  return false;
}

function rectIntersects(a: Rectangle, b: Rectangle): boolean {
  const aRight = a.x + a.width;
  const aBottom = a.y + a.height;
  const bRight = b.x + b.width;
  const bBottom = b.y + b.height;
  return a.x < bRight && aRight > b.x && a.y < bBottom && aBottom > b.y;
}
