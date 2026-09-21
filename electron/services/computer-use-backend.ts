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
import { execFile } from 'node:child_process';
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
 * Nut adapter. GENUINELY lazy: the module-level IIFE previously ran
 * `require('@nut-tree-fork/nut-js')` at import time, so a broken
 * transitive dep (xml2js → nested xmlbuilder missing lib/index.js)
 * threw during `await import('./services/computer-use-backend')` in
 * main.ts — the try/catch swallowed it and the DesktopBackend was
 * never registered, making every action fail with "not initialized".
 *
 * Now the require fires on first USE (method call or Key/Button
 * property access via getters) and is memoized. A load failure
 * surfaces at action time with a remediation hint instead of
 * silently disabling the whole backend at boot.
 */
let cachedNutMod: Record<string, unknown> | null = null;
let nutLoadError: Error | null = null;

function loadNut(): Record<string, unknown> {
  if (cachedNutMod) return cachedNutMod;
  if (nutLoadError) throw nutLoadError;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    cachedNutMod = require('@nut-tree-fork/nut-js') as Record<string, unknown>;
    return cachedNutMod;
  } catch (err) {
    nutLoadError = new Error(
      'nut.js failed to load — mouse/keyboard actions are unavailable. ' +
      'Fix: rebuild the electron bundle (`npm run build:electron`) and restart ' +
      'DUYA. If the .node file itself is missing, reinstall ' +
      '@nut-tree-fork/nut-js / @nut-tree-fork/libnut-win32 (N-API, so no ' +
      'rebuild needed — just `npm install`). Original error: ' +
      (err instanceof Error ? err.message : String(err)),
    );
    logger.warn(
      'computer-use: nut.js load failed',
      { error: nutLoadError.message },
      LogComponent.ComputerUse,
    );
    throw nutLoadError;
  }
}

const nutAdapter: NutAdapter = {
  mouse: {
    async setPosition(point: { x: number; y: number }): Promise<void> {
      const nut = loadNut() as { mouse: { setPosition(p: { x: number; y: number }): Promise<unknown> } };
      await nut.mouse.setPosition(point);
    },
    async click(button: 'LEFT' | 'RIGHT' | 'MIDDLE' | number): Promise<void> {
      const nut = loadNut() as { mouse: { click(b: 'LEFT' | 'RIGHT' | 'MIDDLE' | number): Promise<unknown> } };
      await nut.mouse.click(button);
    },
    async drag(path: Array<{ x: number; y: number }>): Promise<void> {
      const nut = loadNut() as { mouse: { drag(p: Array<{ x: number; y: number }>): Promise<unknown> } };
      await nut.mouse.drag(path);
    },
    async wheel(direction: 'UP' | 'DOWN' | 'LEFT' | 'RIGHT', amount: number): Promise<void> {
      const nut = loadNut() as { mouse: { wheel(d: 'UP' | 'DOWN' | 'LEFT' | 'RIGHT', a: number): Promise<unknown> } };
      await nut.mouse.wheel(direction, amount);
    },
  },
  keyboard: {
    async type(text: string, opts?: { delayMs?: number }): Promise<void> {
      const nut = loadNut() as { keyboard: { type(t: string, o?: { delayMs?: number }): Promise<unknown> } };
      await nut.keyboard.type(text, opts);
    },
    async pressKey(...keys: Array<string | number>): Promise<void> {
      const nut = loadNut() as { keyboard: { pressKey(...k: Array<string | number>): Promise<unknown> } };
      await nut.keyboard.pressKey(...keys);
    },
  },
  // Getters: the backend reads `.Key` / `.Button` synchronously when
  // mapping key names — the getter triggers the lazy load on first
  // access instead of at module import.
  get Key(): Record<string, string | number> {
    const nut = loadNut() as { Key: Record<string, string | number> };
    return nut.Key;
  },
  get Button(): Record<'LEFT' | 'RIGHT' | 'MIDDLE', 'LEFT' | 'RIGHT' | 'MIDDLE' | number> {
    const nut = loadNut() as { Button: Record<'LEFT' | 'RIGHT' | 'MIDDLE', 'LEFT' | 'RIGHT' | 'MIDDLE' | number> };
    return nut.Button;
  },
} as NutAdapter;

/**
 * Lazy libnut window-action loader. libnut ships native
 * EnumWindows-backed window APIs (getWindows / getWindowTitle /
 * focusWindow) that work cross-process — unlike
 * BrowserWindow.getAllWindows(), which only sees DUYA's own windows.
 * The package is already an esbuild external (see build-electron.mjs)
 * so require() lands on the real module at runtime.
 */
interface LibnutWindowAction {
  getWindows(): Promise<unknown[]>;
  getWindowTitle(handle: unknown): Promise<string>;
  focusWindow(handle: unknown): Promise<void>;
}

let cachedLibnutWindows: LibnutWindowAction | null = null;

function loadLibnutWindows(): LibnutWindowAction | null {
  if (cachedLibnutWindows) return cachedLibnutWindows;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const mod = require('@nut-tree-fork/libnut') as {
      DefaultWindowAction?: new () => LibnutWindowAction;
    };
    if (typeof mod.DefaultWindowAction !== 'function') return null;
    cachedLibnutWindows = new mod.DefaultWindowAction();
    return cachedLibnutWindows;
  } catch (err) {
    logger.warn(
      'computer-use: libnut window API unavailable',
      { error: err instanceof Error ? err.message : String(err) },
      LogComponent.ComputerUse,
    );
    return null;
  }
}

/** Upper bound on enumerated windows — guards against huge desktops. */
const MAX_LISTED_WINDOWS = 64;

/** One real top-level OS window with identity info. */
interface NativeAppWindow {
  pid: number;
  processName: string;
  title: string;
}

/**
 * Run a fixed PowerShell snippet and return its stdout. Used instead of
 * libnut's getWindowTitle on Windows because libnut calls the ANSI
 * GetWindowTextA — Chinese window titles (微信, ...) come back mojibake
 * and can never be matched. PowerShell outputs UTF-8 and sees the real
 * Unicode titles plus pid / process name.
 */
function runPowerShell(script: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', script],
      { timeout: 10_000, windowsHide: true, maxBuffer: 1 << 20, encoding: 'utf8' },
      (err, stdout) => (err ? reject(err) : resolve(stdout)),
    );
  });
}

/**
 * Enumerate main windows via Get-Process. Returns [] when PowerShell
 * is unavailable or fails — callers fall back to libnut enumeration.
 */
async function listWindowsViaPowerShell(): Promise<NativeAppWindow[]> {
  try {
    const stdout = await runPowerShell(
      '[Console]::OutputEncoding=[System.Text.Encoding]::UTF8; ' +
      'Get-Process | Where-Object { $_.MainWindowTitle } | ' +
      'ForEach-Object { "{0}`t{1}`t{2}" -f $_.Id, $_.ProcessName, $_.MainWindowTitle }',
    );
    const apps: NativeAppWindow[] = [];
    for (const line of stdout.split(/\r?\n/)) {
      if (apps.length >= MAX_LISTED_WINDOWS) break;
      const [pid, processName, title] = line.split('\t');
      if (!pid || !title || !title.trim()) continue;
      const n = Number(pid);
      if (!Number.isFinite(n)) continue;
      apps.push({ pid: n, processName: processName ?? '', title });
    }
    return apps;
  } catch {
    return [];
  }
}

/**
 * Foreground window snapshot for the plan 556 recorder focus tracker.
 * Returns null when PowerShell is unavailable, the query fails, or no
 * window is foreground — callers treat that as "keep previous state".
 */
export interface ForegroundWindowInfo {
  /** Top-level window handle (fits in a JS number). */
  hwnd: number;
  pid: number;
  processName: string;
  title: string;
}

export async function getForegroundWindowInfo(): Promise<ForegroundWindowInfo | null> {
  try {
    const stdout = await runPowerShell(
      '[Console]::OutputEncoding=[System.Text.Encoding]::UTF8; ' +
      '$t = Add-Type -MemberDefinition "[DllImport(\'user32.dll\')] ' +
      'public static extern IntPtr GetForegroundWindow(); ' +
      '[DllImport(\'user32.dll\')] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);" ' +
      '-Name WinFg -Namespace Native -PassThru; ' +
      '$h = $t::GetForegroundWindow(); ' +
      'if ($h -eq [IntPtr]::Zero) { return; } ' +
      '$procId = 0; ' +
      '$null = $t::GetWindowThreadProcessId($h, [ref]$procId); ' +
      '$p = Get-Process -Id $procId -ErrorAction SilentlyContinue; ' +
      '"{0}`t{1}`t{2}`t{3}" -f $h, $procId, $p.ProcessName, $p.MainWindowTitle',
    );
    const line = stdout.trim().split(/\r?\n/).pop() ?? '';
    if (!line) return null;
    // Title may itself contain tabs — everything after the third tab is title.
    const parts = line.split('\t');
    if (parts.length < 4) return null;
    const hwnd = Number(parts[0]);
    const pid = Number(parts[1]);
    if (!Number.isFinite(hwnd) || !Number.isFinite(pid)) return null;
    return {
      hwnd,
      pid,
      processName: parts[2] ?? '',
      title: parts.slice(3).join('\t'),
    };
  } catch {
    return null;
  }
}

/**
 * Bring a window to the foreground by PID via user32 P/Invoke.
 * ShowWindow(SW_RESTORE) un-minimizes first — SetForegroundWindow
 * alone refuses minimized windows.
 */
async function focusWindowViaPowerShell(pid: number): Promise<boolean> {
  try {
    const stdout = await runPowerShell(
      '[Console]::OutputEncoding=[System.Text.Encoding]::UTF8; ' +
      '$t = Add-Type -MemberDefinition "[DllImport(\'user32.dll\')] ' +
      'public static extern bool SetForegroundWindow(IntPtr hWnd); ' +
      '[DllImport(\'user32.dll\')] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);" ' +
      '-Name Win -Namespace Native -PassThru; ' +
      '$p = Get-Process -Id ' + Number(pid) + ' -ErrorAction Stop; ' +
      '$r1 = $t::ShowWindow($p.MainWindowHandle, 9); ' +
      '$r2 = $t::SetForegroundWindow($p.MainWindowHandle); ' +
      'if ($r2) { "ok" } else { "refused" }',
    );
    return stdout.trim() === 'ok';
  } catch {
    return false;
  }
}

/**
 * plan 519 §3.7 / C2: surface a window without stealing the user's
 * foreground. Uses ShowWindow(SW_SHOWNOACTIVATE, 4) so the window is
 * restored + shown but does NOT take focus. Falls back to a normal
 * raise if the non-activating call is unavailable.
 */
async function showWindowWithoutFocus(pid: number): Promise<boolean> {
  try {
    const stdout = await runPowerShell(
      '[Console]::OutputEncoding=[System.Text.Encoding]::UTF8; ' +
      '$t = Add-Type -MemberDefinition "[DllImport(\'user32.dll\')] ' +
      'public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow); " ' +
      '-Name Win -Namespace Native -PassThru; ' +
      '$p = Get-Process -Id ' + Number(pid) + ' -ErrorAction Stop; ' +
      '$r = $t::ShowWindow($p.MainWindowHandle, 4); ' +
      'if ($r) { "ok" } else { "refused" }',
    );
    return stdout.trim() === 'ok';
  } catch {
    return false;
  }
}

/**
 * Enumerate visible top-level windows via libnut. Returns [] when the
 * native API is unavailable or the platform call fails — callers fall
 * back to the OSContextBridge snapshot.
 */
async function listNativeWindows(): Promise<AppInfo[]> {
  const windows = loadLibnutWindows();
  if (!windows) return [];
  try {
    const handles = await windows.getWindows();
    if (!Array.isArray(handles)) return [];
    const apps: AppInfo[] = [];
    for (const handle of handles) {
      if (apps.length >= MAX_LISTED_WINDOWS) break;
      let title = '';
      try {
        title = (await windows.getWindowTitle(handle)) ?? '';
      } catch {
        continue; // handle died between enumeration and title read
      }
      if (!title.trim()) continue;
      apps.push({ title, processName: '', pid: null });
    }
    return apps;
  } catch {
    return [];
  }
}

/**
 * listAppsProvider: enumerate real top-level windows. Preferred chain:
 *   1. PowerShell (Windows) — Unicode-correct titles + pid + processName
 *   2. libnut native enumeration — cross-platform, but ANSI titles
 *   3. OSContextBridge foreground snapshot — single entry, last resort
 */
async function listAppsFromContext(): Promise<AppInfo[]> {
  const viaPs = await listWindowsViaPowerShell();
  if (viaPs.length > 0) {
    return viaPs.map((w) => ({
      title: w.title,
      processName: w.processName,
      pid: w.pid,
    }));
  }

  const native = await listNativeWindows();
  if (native.length > 0) return native;

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
 * focusAppProvider: best-effort cross-platform window focus.
 *
 * Pass chain:
 *   1. PowerShell (Windows) — Unicode-correct title / processName match
 *      against Get-Process main windows, then user32 SetForegroundWindow
 *      by PID. Works for ANY process (微信, browsers, ...).
 *   2. libnut native windows — EnumWindows + native focusWindow; titles
 *      are ANSI so this only reliably matches ASCII titles.
 *   3. Electron BrowserWindows — DUYA's own windows, matched on title
 *      or webContents URL.
 */
async function focusAppByTitle(
  opts: { title?: string; processName?: string; raise?: boolean },
): Promise<boolean> {
  if (!opts.title && !opts.processName) return false;
  const target = opts.title?.toLowerCase();
  const targetProcess = opts.processName?.toLowerCase();
  // plan 519 §3.7 / C2: background priority by default. false → show
  // without activating; true → raise to the foreground.
  const raise = opts.raise === true;
  const activate = async (pid: number): Promise<boolean> =>
    raise ? focusWindowViaPowerShell(pid) : showWindowWithoutFocus(pid);
  const matches = (title: string, processName = ''): boolean => {
    const t = title.toLowerCase();
    const p = processName.toLowerCase();
    return (
      (target !== undefined && (t.includes(target) || p.includes(target))) ||
      (targetProcess !== undefined && (p.includes(targetProcess) || t.includes(targetProcess)))
    );
  };

  // Pass 1: PowerShell enumeration + user32 focus by PID (Windows).
  const viaPs = await listWindowsViaPowerShell();
  for (const w of viaPs) {
    if (matches(w.title, w.processName)) {
      if (await activate(w.pid)) return true;
    }
  }

  // Pass 2: libnut native cross-process windows (non-Windows / PS down).
  const native = loadLibnutWindows();
  if (native && target) {
    try {
      const handles = await native.getWindows();
      if (Array.isArray(handles)) {
        for (const handle of handles) {
          let title = '';
          try {
            title = (await native.getWindowTitle(handle)) ?? '';
          } catch {
            continue;
          }
          if (matches(title)) {
            await native.focusWindow(handle);
            return true;
          }
        }
      }
    } catch (err) {
      logger.warn(
        'computer-use: native window focus failed, falling back',
        { error: err instanceof Error ? err.message : String(err) },
        LogComponent.ComputerUse,
      );
    }
  }

  // Pass 3: DUYA's own Electron windows (matches URL as well as title).
  const wins = BrowserWindow.getAllWindows();
  for (const w of wins) {
    if (w.isDestroyed()) continue;
    const title = w.getTitle().toLowerCase();
    const url = (w.webContents?.getURL() ?? '').toLowerCase();
    if (target && (title.includes(target) || url.includes(target))) {
      if (w.isMinimized()) w.restore();
      if (raise) {
        w.moveTop();
        w.show();
        w.focus();
      } else {
        // Background priority: show without stealing focus.
        w.showInactive();
      }
      return true;
    }
    if (targetProcess && title.includes(targetProcess)) {
      if (w.isMinimized()) w.restore();
      if (raise) {
        w.moveTop();
        w.show();
        w.focus();
      } else {
        w.showInactive();
      }
      return true;
    }
  }

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
            // plan 519 §3.4: feed the UIA / MSAA accessibility inputs the
            // daemon already captures so SOM is upgraded from "no usable
            // element" to "labeled controls". Empty arrays keep the
            // detector's focused-entity / heuristic fallbacks active.
            axInfo: {
              uia: ctx?.uiaInputs ?? [],
              msaa: ctx?.msaaInputs ?? [],
            },
          });
        } catch {
          return detectSomElements({ width, height });
        }
      },
      renderOverlay: async (image, elements, dims) => {
        return drawSomOverlay(sharpAdapter, image, elements, {}, dims);
      },
      listAppsProvider: listAppsFromContext,
      focusAppProvider: focusAppByTitle,
      // plan 519 §3.5 / A3: post-action read-back source for Verdicts.
      // Uses the bridge's latest focused entity; resolves to null when the
      // snapshot is unavailable so the verdict ladder always has a signal.
      readFocusedEntity: () => {
        const ctx = getOSContextBridge().getCurrent();
        return ctx?.focusedEntity ?? null;
      },
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
