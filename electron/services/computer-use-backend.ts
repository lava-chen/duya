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
  type UiaInvokeOptions,
  type UiaInvokeResult,
  type UiaTreeElement,
  type UiaTreeOptions,
  type UiaTreeResult,
} from '@duya/computer-use';
import { detectSomElements, drawSomOverlay } from '@duya/computer-use';

import { getLogger, LogComponent } from '../logging/logger.js';
import { getOSContextBridge } from '../../packages/agent/dist/context/os-context/index.js';
import {
  axEnumeratedToDescriptor,
  isChromiumProcess,
  type ElementDescriptor,
} from '@duya/computer-use';
import { getSharedAxHelperClient } from './recorder/ax-helper.js';
import { getSharedUiaProbeClient } from './recorder/uia-probe.js';

const logger = getLogger();

const IS_MAC = process.platform === 'darwin';

/**
 * SOM-capture tree TTL (plan 564): the capture path enumerates the
 * foreground window so SOM markers land on REAL coordinates instead of
 * the heuristic grid. The TTL is deliberately short — a stale tree
 * makes click targets wrong, so re-scan after 10s even when the title
 * is unchanged. The `tree` action (LLM-facing) uses the client default.
 */
const CAPTURE_TREE_TTL_MS = 10_000;

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
  // plan 572: on macOS the foreground query rides the persistent AX
  // helper (`fg` op — CGWindowList topmost, no NSWorkspace cache pitfall);
  // the windowId doubles as the hwnd slot the recorder tracks.
  if (IS_MAC) {
    try {
      const fg = await getSharedAxHelperClient().foreground();
      if (!fg) return null;
      return {
        hwnd: fg.windowId,
        pid: fg.pid,
        processName: fg.processName,
        title: fg.title,
      };
    } catch {
      return null;
    }
  }
  try {
    const stdout = await runPowerShell(
      '[Console]::OutputEncoding=[System.Text.Encoding]::UTF8; ' +
      // The C# member definition is a PowerShell SINGLE-quoted string so the
      // DLL name can keep C# double quotes. With single quotes around the
      // DLL name (`DllImport(\'user32.dll\')`) Add-Type fails to compile with
      // "too many characters in character literal" — `'user32.dll'` is a
      // char literal in C#, not a string — and the helper silently returned
      // null via the catch below.
      '$t = Add-Type -MemberDefinition \'[DllImport("user32.dll")] ' +
      'public static extern IntPtr GetForegroundWindow(); ' +
      '[DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);\' ' +
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
      '$t = Add-Type -MemberDefinition \'[DllImport("user32.dll")] ' +
      'public static extern bool SetForegroundWindow(IntPtr hWnd); ' +
      '[DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);\' ' +
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
      '$t = Add-Type -MemberDefinition \'[DllImport("user32.dll")] ' +
      'public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow); \' ' +
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
  // plan 572 pass 0 (macOS): NSWorkspace-backed app list from the AX
  // helper — Unicode-correct localized names + pid. Windows keeps its
  // PowerShell-first chain untouched.
  if (IS_MAC) {
    try {
      const apps = await getSharedAxHelperClient().apps();
      if (apps.length > 0) {
        return apps.map((a) => ({
          title: a.name,
          processName: a.name,
          pid: a.pid,
        }));
      }
    } catch {
      // helper absent/degraded → fall through to the generic chain
    }
  }

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

  // Pass 0 (macOS, plan 572): NSRunningApplication.activate + AXRaise
  // via the AX helper, matched on localized app name. raise=false is
  // background priority — macOS has no public "show without activating"
  // primitive, so background focus resolves to a no-op success when the
  // app exists (the semantics the caller wants: do not steal focus).
  if (IS_MAC) {
    try {
      const client = getSharedAxHelperClient();
      const apps = await client.apps();
      const match = apps.find((a) => matches(a.name, a.name));
      if (match) {
        if (raise) {
          const ok = await client.activate(match.pid);
          if (ok) return true;
        } else {
          return true;
        }
      }
    } catch {
      // helper absent/degraded → fall through to the generic passes
    }
  }

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
 * plan 572 Phase 2 (macOS): enumerate the focused app's AX tree and
 * return the recorder-shape descriptors (real rects + snapshot handles)
 * for the SOM detector's `axElements` path (`axElementsSource:'ax-tree'`
 * — the path plan 562 Phase 2 reserved for this producer).
 *
 * Chromium/Electron targets often have no tree until an assistive
 * client asks: run the AXManualAccessibility recipe (set → wait → one
 * retry) on an empty-tree result from a Chromium-family process.
 */
/**
 * px-per-point ratio between the capture bitmap and the display's
 * point space (plan 572 D8). AX rects arrive in global points; the
 * SOM detector and click mapping work in capture-bitmap pixels —
 * on a 2x Retina display an unscaled rect would land at half size
 * and half position (the Hunch benchmark's #1 correctness trap).
 */
function capturePxPerPoint(bitmapWidth: number): number {
  try {
    const pointsWidth = screen.getPrimaryDisplay().bounds.width;
    if (pointsWidth > 0 && bitmapWidth > 0 && bitmapWidth >= pointsWidth) {
      return bitmapWidth / pointsWidth;
    }
  } catch {
    // display readout unavailable — assume 1x
  }
  return 1;
}

function scaleDescriptorRects(
  descriptors: ElementDescriptor[],
  ratio: number,
): ElementDescriptor[] {
  if (ratio === 1) return descriptors;
  return descriptors.map((d) =>
    d.rect
      ? { ...d, rect: { x: d.rect.x * ratio, y: d.rect.y * ratio, w: d.rect.w * ratio, h: d.rect.h * ratio } }
      : d,
  );
}

async function detectElementsFromAxTree(
  bitmapWidth: number,
): Promise<ElementDescriptor[]> {
  const client = getSharedAxHelperClient();
  const fg = await client.foreground();
  if (!fg || fg.pid <= 0) return [];
  lastAxTreePid = fg.pid;
  const ratio = capturePxPerPoint(bitmapWidth);
  const toDescriptors = (elements: Array<Record<string, unknown>>): ElementDescriptor[] =>
    scaleDescriptorRects(
      elements
        .map((el) => axEnumeratedToDescriptor(el))
        .filter((el): el is ElementDescriptor => el !== null && el.source !== 'none'),
      ratio,
    );

  const result = await client.enumerateCached(fg.pid, fg.title);
  if (result === null) {
    lastAxTreePid = null;
    return [];
  }
  if (result.elements.length === 0 && result.reason === 'empty-tree' && isChromiumProcess(fg.processName)) {
    const ok = await client.manualAccessibility(fg.pid);
    if (ok) {
      // The tree grows asynchronously — wait, then one retry (fresh,
      // not cached, so the empty result is not re-served).
      await new Promise((resolve) => setTimeout(resolve, 250));
      const retry = await client.enumerate(fg.pid);
      if (retry !== null && retry.elements.length > 0) {
        return toDescriptors(retry.elements as unknown as Array<Record<string, unknown>>);
      }
    }
  }
  if (result.elements.length === 0) {
    lastAxTreePid = null;
  }
  return toDescriptors(result.elements as unknown as Array<Record<string, unknown>>);
}

/** Pid of the app the last successful AX-tree enumerate came from (SOM click targeting). */
let lastAxTreePid: number | null = null;

/**
 * plan 564 — structural channel providers.
 *
 * The `tree` / `invoke` actions (and set_value's UIA path) ride the
 * SAME persistent uia-probe.ps1 process the recorder uses — one
 * Add-Type compile, one spawn, shared (hwnd,title) enumerate cache.
 * Foreground resolution prefers the probe's cheap `fg` op and falls
 * back to the spawn-based query so a degraded probe never blocks the
 * vision loop (structural results just report unavailable).
 */

interface ResolvedTarget {
  hwnd: number;
  title: string;
  processName?: string;
}

async function resolveStructuralTarget(
  hwnd?: number,
): Promise<ResolvedTarget | null> {
  if (typeof hwnd === 'number' && hwnd > 0) {
    // Explicit target: title unknown — the empty title forces the
    // enumerate cache to re-scan.
    return { hwnd, title: '' };
  }
  try {
    const fg = getSharedUiaProbeClient().foreground();
    const info = await Promise.race([fg, new Promise<null>((r) => setTimeout(() => r(null), 1_400))]);
    if (info) {
      return { hwnd: info.hwnd, title: info.title, processName: info.processName };
    }
  } catch {
    // probe down — fall through to the spawn query
  }
  const psInfo = await getForegroundWindowInfo();
  if (psInfo) {
    return { hwnd: psInfo.hwnd, title: psInfo.title, processName: psInfo.processName };
  }
  return null;
}

async function uiaTreeProvider(opts: {
  hwnd?: number;
  maxNodes?: number;
  maxDepth?: number;
  fresh?: boolean;
}): Promise<UiaTreeResult> {
  const probe = getSharedUiaProbeClient();
  const target = await resolveStructuralTarget(opts.hwnd);
  if (!target) {
    return {
      hwnd: opts.hwnd ?? -1,
      elements: [],
      truncated: false,
      reason: 'no foreground window',
      source: 'unavailable',
    };
  }
  const enumOpts = {
    ...(opts.maxNodes !== undefined ? { maxNodes: opts.maxNodes } : {}),
    ...(opts.maxDepth !== undefined ? { maxDepth: opts.maxDepth } : {}),
  };
  const result = opts.fresh
    ? await probe.enumerate(target.hwnd, enumOpts)
    : await probe.enumerateCached(target.hwnd, target.title, enumOpts);
  if (result === null) {
    return {
      hwnd: target.hwnd,
      title: target.title,
      processName: target.processName,
      elements: [],
      truncated: false,
      reason: 'probe unavailable',
      source: 'unavailable',
    };
  }
  const elements: UiaTreeElement[] = result.elements.map((el, i) => ({
    index: i + 1,
    role: el.controlType ?? undefined,
    name: el.name ?? undefined,
    value: el.value ?? undefined,
    automationId: el.automationId ?? undefined,
    className: el.className ?? undefined,
    rect: el.rect,
    isPassword: el.isPassword === true,
  }));
  return {
    hwnd: target.hwnd,
    title: target.title,
    processName: target.processName,
    elements,
    truncated: result.truncated,
    reason: result.reason,
    source: 'uia-tree',
  };
}

async function uiaInvokeProvider(opts: {
  element: number;
  method?: UiaInvokeOptions['method'];
  value?: string;
  name?: string;
  controlType?: string;
}): Promise<UiaInvokeResult> {
  const start = Date.now();
  const probe = getSharedUiaProbeClient();
  const target = await resolveStructuralTarget();
  if (!target) {
    return { ok: false, reason: 'no foreground window' };
  }
  const outcome = await probe.invoke(target.hwnd, {
    index: opts.element,
    method: opts.method,
    value: opts.value,
    name: opts.name,
    controlType: opts.controlType,
  });
  if (outcome === null) {
    return {
      ok: false,
      reason: 'probe unavailable',
      durationMs: Date.now() - start,
    };
  }
  return {
    ok: outcome.ok,
    reason: outcome.reason,
    method: outcome.method,
    pattern: outcome.pattern ?? null,
    value: outcome.value ?? null,
    element: outcome.element
      ? {
          name: outcome.element.name ?? undefined,
          controlType: outcome.element.controlType ?? undefined,
          rect: outcome.element.rect,
          isPassword: outcome.element.isPassword === true,
        }
      : null,
    durationMs: Date.now() - start,
  };
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
          // plan 572 Phase 2 (macOS): real-coordinate AX-tree elements
          // take priority over the coordinate-less daemon inputs; the
          // detector tags them `axSource:'ax-tree'`. Windows keeps the
          // uia/msaa sidecar path unchanged.
          let axElements: ElementDescriptor[] | null = null;
          let axElementsSource: 'ax-tree' | 'uia-tree' = 'ax-tree';
          if (IS_MAC) {
            // plan 572 Phase 2 (macOS): real-coordinate AX-tree elements
            // take priority over the coordinate-less daemon inputs; the
            // detector tags them `axSource:'ax-tree'`.
            axElements = await detectElementsFromAxTree(width).catch(
              () => [] as ElementDescriptor[],
            );
          } else {
            // plan 564 (Windows): SOM capture enumerates the foreground
            // window via the shared uia-probe so markers land on REAL
            // bounding rectangles instead of the heuristic grid.
            // Best-effort: a degraded / cold probe degrades silently to
            // the axInfo grid + focused-entity path below.
            try {
              const target = await resolveStructuralTarget();
              if (target) {
                const enumerated = await getSharedUiaProbeClient().enumerateCached(
                  target.hwnd,
                  target.title,
                  { ttlMs: CAPTURE_TREE_TTL_MS },
                );
                if (enumerated && enumerated.elements.length > 0) {
                  axElements = enumerated.elements;
                  axElementsSource = 'uia-tree';
                }
              }
            } catch {
              // structural read failed — grid fallback below
            }
          }
          const detected = detectSomElements({
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
            ...(axElements && axElements.length > 0
              ? { axElements, axElementsSource }
              : {}),
          });
          // plan 572: stamp the owning pid onto ax-tree elements so the
          // IPC click path can target AXUIElementPerformAction directly.
          if (IS_MAC && lastAxTreePid !== null) {
            for (const el of detected) {
              if (el.axHandle) {
                el.axPid = lastAxTreePid;
              }
            }
          }
          return detected;
        } catch {
          return detectSomElements({ width, height });
        }
      },
      renderOverlay: async (image, elements, dims) => {
        return drawSomOverlay(sharpAdapter, image, elements, {}, dims);
      },
      listAppsProvider: listAppsFromContext,
      focusAppProvider: focusAppByTitle,
      // plan 564: structural channel providers (tree / invoke) — ride
      // the shared uia-probe.ps1 process the recorder owns (Windows;
      // macOS resolves 'unavailable' and falls back to the AX path).
      uiaTreeProvider,
      uiaInvokeProvider,
      // plan 572 Phase 5 (macOS): single-window capture via the AX
      // helper's ScreenCaptureKit op (occluded windows OK; SDK < 14
      // answers null -> the backend falls back to the full-screen path).
      ...(IS_MAC
        ? {
            windowCaptureProvider: async (windowId: number) => {
              try {
                const shot = await getSharedAxHelperClient().screenshotWindow(windowId);
                return shot ?? null;
              } catch {
                return null;
              }
            },
          }
        : {}),
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
