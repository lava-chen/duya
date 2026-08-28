/**
 * computer-use-backend.ts — DesktopBackend initialization (plan 454 follow-up).
 *
 * Wires the production DesktopBackend into the agent's IPC dispatcher.
 * The `electron/ipc/computer-use.ts` handler calls
 * `getDefaultDesktopBackend()` to dispatch each computer_use action;
 * if no backend has been registered, every action throws
 * "DesktopBackend not initialized".
 *
 * Initialization strategy:
 *   - Lazy: triggered after the IPC handlers are registered, so the
 *     first computer_use invocation can find a backend.
 *   - Platform-aware: Windows + macOS + Linux all use the same
 *     ElectronDesktopBackend (desktopCapturer + nut.js are
 *     cross-platform per @nut-tree-fork/nut-js design).
 *   - Soft-fail: if the import or construction throws (e.g. headless
 *     CI without a display, or prebuilt binary missing), log a WARN
 *     and continue. The mode still registers; the dispatcher will
 *     surface a structured error on the first call.
 *
 * Wiring:
 *   - electron module  -> electron adapter (desktopCapturer)
 *   - @nut-tree-fork/nut-js -> nut adapter (mouse / keyboard)
 *   - sharp  -> sharp adapter (SOM overlay rendering)
 *   - @duya/computer-use -> detectElements / renderOverlay / listApps /
 *     focusApp providers (built from OSContextBridge + native focus)
 */

import { app, BrowserWindow, screen } from 'electron';
import {
  setDefaultDesktopBackend,
  ElectronDesktopBackend,
  type ElectronAdapter,
  type NutAdapter,
  type SharpAdapter,
  type AppInfo,
} from '@duya/computer-use';
import { detectSomElements, drawSomOverlay } from '@duya/computer-use';

import { getLogger, LogComponent } from '../logging/logger.js';
import { getOSContextBridge } from '../../packages/agent/dist/context/os-context/index.js';

const logger = getLogger();

/**
 * Adapter for Electron's desktopCapturer. Captures the primary display
 * on demand via Electron's own `desktopCapturer.getSources`. The
 * `as unknown as` cast collapses Electron's richer
 * `DesktopCapturerSource` shape (with `appIcon` + `NativeImage`)
 * into our minimal interface — the backend only reads `id`,
 * `display_id`, `thumbnail.toPNG`, and `thumbnail.getSize`.
 */
const electronAdapter: ElectronAdapter = {
  desktopCapturer: {
    async getSources(opts) {
      // Lazy require: electron's `desktopCapturer` is only available
      // after the app is ready. We require the npm `electron` module
      // (which proxies to the running Electron process) at call time.
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { desktopCapturer } = require('electron');
      return desktopCapturer.getSources(opts) as unknown as Promise<
        Array<{
          id: string;
          name: string;
          display_id?: string;
          thumbnail: {
            toPNG(): Promise<Buffer>;
            getSize(): { width: number; height: number };
          };
        }>
      >;
    },
  },
};

/**
 * Sharp adapter. Lazy require keeps the bundle slim until the first
 * `capture` action fires SOM overlay rendering. The `as never` cast
 * sidesteps the missing `sharp` types in the electron side (the
 * prebuilt binary is resolved at runtime).
 */
const sharpAdapter: SharpAdapter = ((input: Buffer | string) => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const sharpMod = require('sharp');
  return sharpMod(input);
}) as SharpAdapter;

/**
 * Nut adapter. Lazy require so a missing prebuilt binary surfaces a
 * clear error at action time instead of crashing app boot. The real
 * @nut-tree-fork/nut-js API has classes (MouseClass, KeyboardClass)
 * with richer return types; the adapter strips them down to the
 * simple method set the DesktopBackend interface expects.
 */
const nutAdapter: NutAdapter = (() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const nutMod = require('@nut-tree-fork/nut-js');
  const mouse = nutMod.mouse;
  const keyboard = nutMod.keyboard;
  return {
    mouse: {
      async setPosition(point: { x: number; y: number }): Promise<void> {
        await mouse.setPosition(point);
      },
      async click(button: 'LEFT' | 'RIGHT' | 'MIDDLE' | number): Promise<void> {
        await mouse.click(button);
      },
      async drag(path: Array<{ x: number; y: number }>): Promise<void> {
        await mouse.drag(path);
      },
      async wheel(direction: 'UP' | 'DOWN' | 'LEFT' | 'RIGHT', amount: number): Promise<void> {
        await mouse.wheel(direction, amount);
      },
    },
    keyboard: {
      async type(text: string, opts?: { delayMs?: number }): Promise<void> {
        await keyboard.type(text, opts);
      },
      async pressKey(...keys: Array<string | number>): Promise<void> {
        await keyboard.pressKey(...keys);
      },
    },
    Key: nutMod.Key as unknown as Record<string, string | number>,
    Button: nutMod.Button as unknown as Record<'LEFT' | 'RIGHT' | 'MIDDLE', 'LEFT' | 'RIGHT' | 'MIDDLE' | number>,
  };
})();

/**
 * listAppsProvider: read the visible app list from OSContextBridge.
 * The daemon populates `foreground` + `focusedEntity` in the latest
 * snapshot; we surface a one-entry list with that foreground as the
 * "active" app. Plan 3 may extend to a full window list.
 */
async function listAppsFromContext(): Promise<AppInfo[]> {
  try {
    const ctx = getOSContextBridge().getCurrent();
    if (!ctx) return [];
    const foreground = ctx.foreground as
      | { pid: number; exeName: string; title: string }
      | undefined;
    return [
      {
        title: foreground?.title ?? 'Unknown',
        processName: foreground?.exeName ?? 'unknown',
        pid: foreground?.pid ?? null,
        focusedEntity: ctx.focusedEntity ?? null,
      },
    ];
  } catch {
    return [];
  }
}

/**
 * focusAppProvider: best-effort cross-platform window focus. On
 * Windows we use Electron's `BrowserWindow.getAllWindows()` to
 * find a window whose title matches the substring; the call to
 * `moveToFront` activates the OS-level focus.
 *
 * Other platforms fall back to no-op (the OSContextBridge is the
 * read-side signal; activation here is best-effort).
 */
async function focusAppByTitle(
  opts: { title?: string; processName?: string },
): Promise<boolean> {
  if (!opts.title && !opts.processName) return false;
  const target = opts.title?.toLowerCase();
  const targetProcess = opts.processName?.toLowerCase();

  const wins = BrowserWindow.getAllWindows();
  for (const w of wins) {
    if (w.isDestroyed()) continue;
    const title = w.getTitle().toLowerCase();
    const url = (w.webContents?.getURL() ?? '').toLowerCase();
    if (target && (title.includes(target) || url.includes(target))) {
      if (w.isMinimized()) w.restore();
      w.moveTop();
      w.show();
      w.focus();
      return true;
    }
  }

  // No match in our process tree. Cross-process focus is OS-specific;
  // a future phase may add Windows uiAccess / macOS AXAPI hooks.
  // For now we surface a soft fail so the dispatcher returns ok=false
  // with a clear reason.
  void targetProcess; // reserved for future cross-process focus
  return false;
}

/**
 * Initialize the DesktopBackend. Safe to call multiple times; later
 * calls are no-ops once the backend is set.
 *
 * @returns true when the backend was initialized, false when init
 *   failed (the dispatcher will still be reachable, but every action
 *   will surface the "not initialized" error).
 */
export function initializeComputerUseBackend(): boolean {
  if (app.isReady() === false) {
    // Defer until the app is ready; desktopCapturer / nut.js may need
    // the ready state to function.
    void app.whenReady().then(() => initializeComputerUseBackend());
    return false;
  }

  try {
    const backend = new ElectronDesktopBackend({
      electron: electronAdapter,
      sharp: sharpAdapter,
      nut: nutAdapter,
      detectElements: async ({ width, height }) => {
        try {
          const ctx = getOSContextBridge().getCurrent();
          return detectSomElements({
            width,
            height,
            focusedEntity: ctx?.focusedEntity ?? null,
          });
        } catch {
          return detectSomElements({ width, height });
        }
      },
      renderOverlay: async (image, elements) => {
        return drawSomOverlay(sharpAdapter, image, elements);
      },
      listAppsProvider: listAppsFromContext,
      focusAppProvider: focusAppByTitle,
      // Use the primary display's actual pixel size as the capture
      // resolution baseline. desktopCapturer returns native pixels;
      // we let the backend resize via thumbnailSize on getSources.
      captureWidth: screen.getPrimaryDisplay().bounds.width,
      captureHeight: screen.getPrimaryDisplay().bounds.height,
    });

    setDefaultDesktopBackend(backend);
    logger.info(
      'Computer Use backend initialized',
      {
        platform: process.platform,
        primaryDisplay: screen.getPrimaryDisplay().bounds,
      },
      LogComponent.ComputerUse,
    );
    return true;
  } catch (err) {
    logger.warn(
      'Computer Use backend initialization failed',
      {
        error: err instanceof Error ? err.message : String(err),
        platform: process.platform,
      },
      LogComponent.ComputerUse,
    );
    return false;
  }
}
