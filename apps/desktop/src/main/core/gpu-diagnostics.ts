// electron/core/gpu-diagnostics.ts
// GPU compositing observability for the desktop performance hill-climb.
//
// WHY THIS EXISTS
// The main process had NO GPU observation at all: `app.getGPUFeatureStatus()`,
// `app.getGpuInfo()` and the `child-process-gone` event were never used
// anywhere under `apps/desktop/src/main`. Consequences:
//   - A GPU-process crash was silent. `child-process-gone` fires for the GPU
//     process (`details.type === 'GPU'`), and nothing listened, so a driver
//     reset or a GPU OOM left no trace beyond a suddenly-slower UI.
//   - The `gpu.compositing` metric had no producer. Whether the window was
//     composited on the GPU or in software was unknowable from inside the app.
//   - The terminal's WebGL -> DOM fallback was visible only as a label in the
//     appearance menu. A user hit a degraded terminal and had no way to find
//     out why.
//
// Split in two like `webview-guard.ts`: the pure helpers below are exhaustively
// unit-testable, and `attachGpuDiagnostics` is the thin adapter that wires them
// to a live Electron `app` / `ipcMain`.
//
// SCOPE
// This module OBSERVES. It never changes a GPU switch, never sets
// `disableHardwareAcceleration`, and never toggles a Chromium feature flag.
// The degraded states this file can report (GPU unavailable, WebGL context
// lost) are produced by launch switches or by the product's own fallback path,
// not by anything added here.

import type { App, IpcMain } from 'electron';

/** IPC channel the renderer calls to read the current GPU status. */
export const GPU_STATUS_CHANNEL = 'gpu:get-status';

/** IPC channel the renderer calls when a WebGL context is lost. */
export const GPU_WEBGL_LOSS_CHANNEL = 'gpu:report-webgl-context-lost';

/**
 * How the window is composited.
 *
 * `hardware`  - the GPU process composites the frame (Chromium reports
 *               `gpu_compositing: 'enabled'`).
 * `software`  - compositing happens on the CPU (Chromium reports
 *               `'software'`). The UI still paints, but every frame costs
 *               main-process CPU.
 * `disabled`  - GPU compositing is turned off.
 * `unknown`   - Chromium reported nothing usable.
 */
export type GpuCompositingMode = 'hardware' | 'software' | 'disabled' | 'unknown';

/** The subset of `Electron.GPUFeatureStatus` this app cares about. */
export interface GpuFeatureStatusSnapshot {
  gpu_compositing: string;
  gpu_rasterization: string;
  webgl: string;
  webgl2: string;
  canvas2d: string;
  video_decode: string;
  video_encode: string;
  /** Every key Chromium reported, so a report never loses a field. */
  raw: Record<string, string>;
}

/** The GPU adapter identity, as far as Chromium could report it. */
export interface GpuAdapterInfo {
  vendor: string | null;
  renderer: string | null;
  driverVersion: string | null;
  adapter: string | null;
}

/** A snapshot of everything this module knows about the GPU right now. */
export interface GpuStatusSnapshot {
  /** When the snapshot was taken (epoch ms). */
  timestamp: number;
  /** How the window is composited. */
  compositing: GpuCompositingMode;
  featureStatus: GpuFeatureStatusSnapshot;
  adapter: GpuAdapterInfo;
  /**
   * How many times the GPU process has gone away since startup. A non-zero
   * value means Chromium lost the GPU and fell back to software rendering.
   */
  gpuProcessExitCount: number;
  /**
   * How many WebGL context losses the renderer has reported. The terminal
   * reports here when its WebGL renderer degrades to the DOM renderer.
   */
  webglContextLossCount: number;
}

/** What the renderer sends when a WebGL context is lost. */
export interface WebglContextLossReport {
  /** Which surface lost its context, e.g. `'terminal'`. */
  surface: string;
  /** Why, e.g. `'webgl-context-lost'` or `'webgl-unavailable'`. */
  reason: string;
}

/** A `child-process-gone` payload, narrowed to what this module reads. */
export interface ChildProcessGoneDetails {
  type: string;
  reason: string;
  exitCode: number;
  name?: string;
}

// =============================================================================
// Pure helpers
// =============================================================================

/** Read a nested value out of an `unknown` blob without trusting its shape. */
function readPath(root: unknown, path: readonly string[]): unknown {
  let current: unknown = root;
  for (const key of path) {
    if (current === null || typeof current !== 'object') return undefined;
    current = (current as Record<string, unknown>)[key];
  }
  return current;
}

/** First non-empty string found at any of `paths`, else null. */
function readStringAtAny(root: unknown, paths: readonly (readonly string[])[]): string | null {
  for (const path of paths) {
    const value = readPath(root, path);
    if (typeof value === 'string' && value.trim() !== '') return value.trim();
  }
  return null;
}

/**
 * The GPU device list, as the ACTIVE device.
 *
 * Chromium reports `gpuDevice` as an ARRAY of every adapter it knows about
 * (the real GPU, the Microsoft Basic Render Driver, and one entry per
 * physical adapter). The entry with `active: true` is the one the renderer
 * actually uses; when none is marked active, the first entry is the best
 * available answer. Older payloads carry a single object instead of a list.
 */
function activeGpuDevice(root: unknown): unknown {
  const devices = readPath(root, ['gpuDevice']);
  if (Array.isArray(devices)) {
    const active = devices.find(
      (device) =>
        device !== null &&
        typeof device === 'object' &&
        (device as Record<string, unknown>).active === true,
    );
    return active ?? devices[0];
  }
  if (devices !== null && typeof devices === 'object') return devices;
  return undefined;
}

/**
 * Turn Chromium's free-form `GPUFeatureStatus` into a fixed shape.
 *
 * Chromium's field names are snake_case with a leading digit in one case
 * (`2d_canvas`), which is not a usable JS identifier, so the canvas field is
 * renamed to `canvas2d`. Everything Chromium reported is kept in `raw`.
 */
export function normalizeGpuFeatureStatus(raw: unknown): GpuFeatureStatusSnapshot {
  const source: Record<string, unknown> =
    raw !== null && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};

  const flat: Record<string, string> = {};
  for (const [key, value] of Object.entries(source)) {
    if (typeof value === 'string') flat[key] = value;
    else if (typeof value === 'number' || typeof value === 'boolean') flat[key] = String(value);
  }

  const pick = (key: string): string => flat[key] ?? '';

  return {
    gpu_compositing: pick('gpu_compositing'),
    // Chromium 44 reports the rasterization flag under `rasterization`; older
    // builds used `gpu_rasterization`. Read both so the field is not blank
    // for a reason that has nothing to do with the GPU.
    gpu_rasterization: pick('gpu_rasterization') || pick('rasterization'),
    webgl: pick('webgl'),
    webgl2: pick('webgl2'),
    canvas2d: pick('2d_canvas'),
    video_decode: pick('video_decode'),
    video_encode: pick('video_encode'),
    raw: flat,
  };
}

/**
 * Classify the compositing mode from Chromium's `gpu_compositing` string.
 *
 * Chromium uses `'enabled'`, `'disabled'`, `'software'` and the empty string,
 * and appends a suffix when the feature is not simply on or off:
 * `'disabled_software'` (the feature is off and the CPU takes over),
 * `'unavailable_software'` (there is no GPU implementation and the CPU takes
 * over), `'enabled_on'`, `'disabled_off'`. A software fallback is reported as
 * `software` - that is what the user actually gets - and a feature that is
 * simply switched off is reported as `disabled`.
 *
 * An unrecognised value is `'unknown'` rather than a guess: a wrong guess here
 * would turn a performance report into a false claim.
 */
export function classifyGpuCompositing(gpuCompositing: string): GpuCompositingMode {
  const value = gpuCompositing.trim().toLowerCase();
  if (value === 'enabled' || value.startsWith('enabled')) return 'hardware';
  if (value === 'software' || value.endsWith('_software')) return 'software';
  if (value === 'disabled' || value.startsWith('disabled')) return 'disabled';
  return 'unknown';
}

/**
 * Pull the adapter identity out of `app.getGPUInfo('complete')`.
 *
 * The payload is `unknown` by contract, so every field is read defensively:
 * a missing field yields null rather than an exception.
 */
export function extractGpuAdapterInfo(raw: unknown): GpuAdapterInfo {
  const device = activeGpuDevice(raw);
  const deviceString = readStringAtAny(device, [['deviceString']]);
  const driverVersion = readStringAtAny(device, [['driverVersion']]);

  return {
    vendor:
      readStringAtAny(raw, [['auxAttributes', 'glVendor']]) ??
      readStringAtAny(device, [['vendorString']]),
    renderer: readStringAtAny(raw, [['auxAttributes', 'glRenderer']]) ?? deviceString,
    driverVersion:
      driverVersion ?? readStringAtAny(raw, [['auxAttributes', 'glVersion']]),
    adapter: deviceString ?? readStringAtAny(raw, [['auxAttributes', 'glRenderer']]),
  };
}

/**
 * Narrow a `child-process-gone` payload.
 *
 * Only the GPU process matters here; every other child type is ignored by the
 * caller.
 */
export function normalizeChildProcessGoneDetails(details: unknown): ChildProcessGoneDetails | null {
  if (details === null || typeof details !== 'object') return null;
  const source = details as Record<string, unknown>;
  const type = typeof source.type === 'string' ? source.type : '';
  const reason = typeof source.reason === 'string' ? source.reason : '';
  const exitCode = typeof source.exitCode === 'number' ? source.exitCode : 0;
  const name = typeof source.name === 'string' ? source.name : undefined;
  return { type, reason, exitCode, name };
}

/**
 * One line summarising the GPU state, for a log line a human can read.
 *
 * Deliberately short: this is written to the main log on every startup, so it
 * has to stay scannable.
 */
export function formatGpuStatusLine(snapshot: GpuStatusSnapshot): string {
  const adapter = snapshot.adapter.renderer ?? snapshot.adapter.adapter ?? 'unknown adapter';
  return (
    `GPU compositing=${snapshot.compositing} ` +
    `gpu_compositing=${snapshot.featureStatus.gpu_compositing || 'n/a'} ` +
    `webgl=${snapshot.featureStatus.webgl || 'n/a'} ` +
    `webgl2=${snapshot.featureStatus.webgl2 || 'n/a'} ` +
    `adapter=${adapter} ` +
    `gpuProcessExits=${snapshot.gpuProcessExitCount} ` +
    `webglContextLosses=${snapshot.webglContextLossCount}`
  );
}

// =============================================================================
// Live wiring
// =============================================================================

/** The subset of the main-process logger this module uses. */
export interface GpuDiagnosticLogger {
  info(message: string, context?: Record<string, unknown>, component?: string): void;
  warn(message: string, context?: Record<string, unknown>, component?: string): void;
  error(message: string, error?: Error, context?: Record<string, unknown>, component?: string): void;
}

/** What `attachGpuDiagnostics` hands back, so callers can read the status. */
export interface GpuDiagnosticsHandle {
  /** Read the current status. */
  getStatus(): Promise<GpuStatusSnapshot>;
  /** Whether the observer was already attached (guards double wiring). */
  readonly attached: boolean;
}

/**
 * Attach the GPU observer to a live Electron app.
 *
 * Attaches:
 *   - a `child-process-gone` listener that counts GPU-process deaths,
 *   - an `ipcMain` handler the renderer reads the status through,
 *   - an `ipcMain` handler the renderer reports WebGL context losses through.
 *
 * Idempotent: a second call on the same app is a no-op, so a hot reload
 * cannot double-count a GPU crash.
 */
export function attachGpuDiagnostics(
  app: App,
  ipcMain: IpcMain,
  logger: GpuDiagnosticLogger,
  component = 'Main',
): GpuDiagnosticsHandle {
  const state = app as App & { __duyaGpuDiagnosticsAttached?: boolean };
  if (state.__duyaGpuDiagnosticsAttached) {
    return {
      attached: true,
      getStatus: () => readGpuStatus(app, 0, 0),
    };
  }
  state.__duyaGpuDiagnosticsAttached = true;

  let gpuProcessExitCount = 0;
  let webglContextLossCount = 0;

  app.on('child-process-gone', (_event, details) => {
    const normalized = normalizeChildProcessGoneDetails(details);
    if (!normalized || normalized.type !== 'GPU') return;
    gpuProcessExitCount += 1;
    logger.error(
      'GPU process gone; the app fell back to software rendering',
      undefined,
      {
        reason: normalized.reason,
        exitCode: normalized.exitCode,
        name: normalized.name ?? 'unknown',
        gpuProcessExitCount,
      },
      component,
    );
  });

  // Registering the same channel twice throws, and a throw here would take
  // the whole startup sequence down. The observer is diagnostics; it must not
  // be able to break the app.
  //
  // The channel names are written as LITERALS, not as the constants above.
  // The IPC contract gate scans the source for `ipcMain.handle('ch', ...)` to
  // prove that every channel the preload can invoke has a handler, and a
  // constant is invisible to that scan: with `ipcMain.handle(GPU_STATUS_
  // CHANNEL, ...)` the gate reported two channels as reachable-but-unhandled
  // even though they were registered. Every other handler in this process
  // writes the literal the same way. `gpu-diagnostics.test.ts` ties the two
  // spellings together so they cannot drift.
  try {
    ipcMain.handle('gpu:get-status', async () =>
      readGpuStatus(app, gpuProcessExitCount, webglContextLossCount),
    );

    ipcMain.handle('gpu:report-webgl-context-lost', async (_event, report: unknown) => {
      const normalized = normalizeWebglContextLossReport(report);
      webglContextLossCount += 1;
      logger.warn(
        `WebGL context lost on surface "${normalized.surface}"`,
        {
          surface: normalized.surface,
          reason: normalized.reason,
          webglContextLossCount,
        },
        component,
      );
      return { ok: true, webglContextLossCount };
    });
  } catch (err) {
    logger.error(
      'GPU diagnostics channels could not be registered',
      err instanceof Error ? err : new Error(String(err)),
      undefined,
      component,
    );
  }

  return {
    attached: true,
    getStatus: () => readGpuStatus(app, gpuProcessExitCount, webglContextLossCount),
  };
}

/**
 * Narrow a renderer-supplied WebGL loss report.
 *
 * The payload arrives over IPC from the renderer, so it is `unknown` and it
 * is clamped: a long or hostile string must not end up in the main log.
 */
export function normalizeWebglContextLossReport(report: unknown): WebglContextLossReport {
  const source: Record<string, unknown> =
    report !== null && typeof report === 'object' ? (report as Record<string, unknown>) : {};
  const clamp = (value: unknown, fallback: string): string => {
    if (typeof value !== 'string') return fallback;
    const trimmed = value.trim();
    if (trimmed === '') return fallback;
    return trimmed.length > 120 ? trimmed.slice(0, 120) : trimmed;
  };
  return {
    surface: clamp(source.surface, 'unknown'),
    reason: clamp(source.reason, 'unknown'),
  };
}

/**
 * Read the current GPU status from a live app.
 *
 * `getGPUInfo` is a promise and can reject (no GPU process, a locked
 * driver); the adapter fields then stay null rather than failing the whole
 * snapshot.
 */
export async function readGpuStatus(
  app: App,
  gpuProcessExitCount: number,
  webglContextLossCount: number,
): Promise<GpuStatusSnapshot> {
  const featureStatus = normalizeGpuFeatureStatus(app.getGPUFeatureStatus());

  let adapterInfo: GpuAdapterInfo = {
    vendor: null,
    renderer: null,
    driverVersion: null,
    adapter: null,
  };
  try {
    const raw = await app.getGPUInfo('complete');
    adapterInfo = extractGpuAdapterInfo(raw);
  } catch {
    // No GPU process, or the driver refused the query. The feature status
    // above is still valid, so the snapshot stays useful.
  }

  return {
    timestamp: Date.now(),
    compositing: classifyGpuCompositing(featureStatus.gpu_compositing),
    featureStatus,
    adapter: adapterInfo,
    gpuProcessExitCount,
    webglContextLossCount,
  };
}
