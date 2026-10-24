/**
 * gpu-diagnostics.test.ts — GPU compositing observability.
 *
 * The main process had no GPU observation at all before this module: a
 * GPU-process crash was silent and the `gpu.compositing` metric had no
 * producer. These tests pin the two halves of that gap:
 *
 *   - the PURE helpers, which decide what "hardware" vs "software"
 *     compositing means and how an adapter identity is read out of an
 *     `unknown` payload;
 *   - the WIRING, which counts GPU-process deaths and WebGL context losses and
 *     exposes both through the status snapshot.
 *
 * The wiring is tested against fakes rather than a live Electron app so the
 * counts can be driven deterministically.
 */
import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { App, IpcMain } from 'electron';
import {
  GPU_STATUS_CHANNEL,
  GPU_WEBGL_LOSS_CHANNEL,
  attachGpuDiagnostics,
  classifyGpuCompositing,
  extractGpuAdapterInfo,
  formatGpuStatusLine,
  normalizeChildProcessGoneDetails,
  normalizeGpuFeatureStatus,
  normalizeWebglContextLossReport,
  readGpuStatus,
} from '../gpu-diagnostics';

describe('normalizeGpuFeatureStatus', () => {
  it('maps the fields the app reports and keeps everything raw', () => {
    const snapshot = normalizeGpuFeatureStatus({
      gpu_compositing: 'enabled',
      gpu_rasterization: 'enabled',
      webgl: 'enabled',
      webgl2: 'enabled',
      '2d_canvas': 'enabled',
      video_decode: 'enabled',
      video_encode: 'disabled',
      multiple_raster_threads: 'enabled',
    });

    expect(snapshot.gpu_compositing).toBe('enabled');
    expect(snapshot.canvas2d).toBe('enabled');
    expect(snapshot.video_encode).toBe('disabled');
    expect(snapshot.raw.multiple_raster_threads).toBe('enabled');
  });

  it('returns empty strings rather than undefined for a missing payload', () => {
    const snapshot = normalizeGpuFeatureStatus(undefined);
    expect(snapshot.gpu_compositing).toBe('');
    expect(snapshot.raw).toEqual({});
  });

  it('falls back to the `rasterization` key Chromium 44 reports', () => {
    const snapshot = normalizeGpuFeatureStatus({ rasterization: 'enabled' });
    expect(snapshot.gpu_rasterization).toBe('enabled');
  });
});

describe('classifyGpuCompositing', () => {
  it('maps Chromium values onto the four modes', () => {
    expect(classifyGpuCompositing('enabled')).toBe('hardware');
    expect(classifyGpuCompositing('software')).toBe('software');
    expect(classifyGpuCompositing('disabled')).toBe('disabled');
  });

  it('maps the suffixed values Chromium reports on a degraded GPU', () => {
    expect(classifyGpuCompositing('enabled_on')).toBe('hardware');
    expect(classifyGpuCompositing('disabled_software')).toBe('software');
    expect(classifyGpuCompositing('unavailable_software')).toBe('software');
    expect(classifyGpuCompositing('disabled_off')).toBe('disabled');
  });

  it('reports anything it does not recognise as unknown', () => {
    expect(classifyGpuCompositing('')).toBe('unknown');
    expect(classifyGpuCompositing('ENABLED')).toBe('hardware');
    expect(classifyGpuCompositing('something-new')).toBe('unknown');
  });
});

describe('extractGpuAdapterInfo', () => {
  it('reads the adapter identity out of the complete GPU info payload', () => {
    const info = extractGpuAdapterInfo({
      auxAttributes: {
        glVendor: 'Google Inc. (NVIDIA)',
        glRenderer: 'ANGLE (NVIDIA, NVIDIA GeForce RTX 5060 Ti Direct3D11 vs_5_0 ps_5_0, D3D11)',
      },
      gpuDevice: {
        driverVersion: '32.0.15.9186',
        deviceString: 'NVIDIA GeForce RTX 5060 Ti',
      },
    });

    expect(info.vendor).toBe('Google Inc. (NVIDIA)');
    expect(info.renderer).toContain('RTX 5060 Ti');
    expect(info.driverVersion).toBe('32.0.15.9186');
    expect(info.adapter).toBe('NVIDIA GeForce RTX 5060 Ti');
  });

  it('picks the ACTIVE device out of the device list Chromium reports', () => {
    const info = extractGpuAdapterInfo({
      auxAttributes: { glVendor: 'Google Inc. (NVIDIA)' },
      gpuDevice: [
        {
          active: false,
          deviceString: 'Microsoft Basic Render Driver',
          driverVersion: '10.0.26100.9711',
        },
        {
          active: true,
          deviceString: 'NVIDIA GeForce RTX 5060 Ti',
          driverVersion: '32.0.15.9186',
        },
      ],
    });

    expect(info.adapter).toBe('NVIDIA GeForce RTX 5060 Ti');
    expect(info.driverVersion).toBe('32.0.15.9186');
  });

  it('keeps every field null when the payload carries nothing usable', () => {
    expect(extractGpuAdapterInfo(null)).toEqual({
      vendor: null,
      renderer: null,
      driverVersion: null,
      adapter: null,
    });
  });
});

describe('normalizeChildProcessGoneDetails', () => {
  it('narrows the payload to the fields the observer reads', () => {
    expect(
      normalizeChildProcessGoneDetails({
        type: 'GPU',
        reason: 'crashed',
        exitCode: 1,
        name: 'GPU Process',
      }),
    ).toEqual({ type: 'GPU', reason: 'crashed', exitCode: 1, name: 'GPU Process' });
  });

  it('returns null for a payload that is not an object', () => {
    expect(normalizeChildProcessGoneDetails('GPU')).toBeNull();
  });
});

describe('normalizeWebglContextLossReport', () => {
  it('keeps a well-formed report', () => {
    expect(
      normalizeWebglContextLossReport({ surface: 'terminal', reason: 'webgl-context-lost' }),
    ).toEqual({ surface: 'terminal', reason: 'webgl-context-lost' });
  });

  it('falls back and clamps a hostile or empty report', () => {
    expect(normalizeWebglContextLossReport({ surface: 'x'.repeat(500), reason: '' })).toEqual({
      surface: 'x'.repeat(120),
      reason: 'unknown',
    });
    expect(normalizeWebglContextLossReport(undefined)).toEqual({
      surface: 'unknown',
      reason: 'unknown',
    });
  });
});

describe('formatGpuStatusLine', () => {
  it('names the compositing mode, the adapter and both counters', () => {
    const line = formatGpuStatusLine({
      timestamp: 0,
      compositing: 'software',
      featureStatus: normalizeGpuFeatureStatus({
        gpu_compositing: 'software',
        webgl: 'enabled',
        webgl2: 'disabled',
      }),
      adapter: {
        vendor: 'Google Inc. (NVIDIA)',
        renderer: 'ANGLE (NVIDIA, RTX 5060 Ti)',
        driverVersion: '32.0.15.9186',
        adapter: 'NVIDIA GeForce RTX 5060 Ti',
      },
      gpuProcessExitCount: 2,
      webglContextLossCount: 1,
    });

    expect(line).toContain('compositing=software');
    expect(line).toContain('gpuProcessExits=2');
    expect(line).toContain('webglContextLosses=1');
    expect(line).toContain('RTX 5060 Ti');
  });
});

/** A fake Electron `app` that records `child-process-gone` listeners. */
function fakeApp(featureStatus: Record<string, string>, gpuInfo: unknown = {}) {
  const listeners: Array<(event: unknown, details: unknown) => void> = [];
  const app = {
    getGPUFeatureStatus: () => featureStatus,
    getGPUInfo: vi.fn(async () => gpuInfo),
    on(event: string, listener: (event: unknown, details: unknown) => void) {
      if (event === 'child-process-gone') listeners.push(listener);
      return app;
    },
  };
  return { app: app as unknown as App, listeners };
}

/** A fake Electron `ipcMain` that records the handlers it was given. */
function fakeIpcMain() {
  const handlers = new Map<string, (event: unknown, ...args: unknown[]) => unknown>();
  const ipcMain = {
    handle(channel: string, handler: (event: unknown, ...args: unknown[]) => unknown) {
      handlers.set(channel, handler);
    },
  };
  return { ipcMain: ipcMain as unknown as IpcMain, handlers };
}

function fakeLogger() {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
}

describe('readGpuStatus', () => {
  it('builds a snapshot from the live app', async () => {
    const { app } = fakeApp({ gpu_compositing: 'enabled', webgl: 'enabled' }, {
      auxAttributes: { glVendor: 'Google Inc. (NVIDIA)', glRenderer: 'ANGLE (NVIDIA, RTX)' },
    });

    const status = await readGpuStatus(app, 0, 0);
    expect(status.compositing).toBe('hardware');
    expect(status.featureStatus.gpu_compositing).toBe('enabled');
    expect(status.adapter.vendor).toBe('Google Inc. (NVIDIA)');
    expect(status.gpuProcessExitCount).toBe(0);
    expect(status.webglContextLossCount).toBe(0);
  });

  it('survives a GPU info query that rejects', async () => {
    const { app } = fakeApp({ gpu_compositing: 'software' });
    (app.getGPUInfo as unknown as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('no gpu'));

    const status = await readGpuStatus(app, 0, 0);
    expect(status.compositing).toBe('software');
    expect(status.adapter.adapter).toBeNull();
  });
});

describe('attachGpuDiagnostics', () => {
  it('registers the channels under the literal names the preload calls', () => {
    // The IPC contract gate proves that every channel the preload can invoke
    // has a handler by scanning the source for `ipcMain.handle('ch', ...)`,
    // so the names have to be literals at the call site. This test is what
    // keeps those literals and the exported constants from drifting apart.
    const source = readFileSync(
      fileURLToPath(new URL('../gpu-diagnostics.ts', import.meta.url)),
      'utf8',
    );
    expect(source).toContain(`ipcMain.handle('${GPU_STATUS_CHANNEL}'`);
    expect(source).toContain(`ipcMain.handle('${GPU_WEBGL_LOSS_CHANNEL}'`);
  });

  it('counts GPU-process deaths and ignores other child processes', async () => {
    const { app, listeners } = fakeApp({ gpu_compositing: 'enabled' });
    const { ipcMain, handlers } = fakeIpcMain();
    const logger = fakeLogger();

    attachGpuDiagnostics(app, ipcMain, logger);

    listeners[0]({}, { type: 'Utility', reason: 'clean-exit', exitCode: 0 });
    expect(logger.error).not.toHaveBeenCalled();

    listeners[0]({}, { type: 'GPU', reason: 'crashed', exitCode: 1, name: 'GPU Process' });
    expect(logger.error).toHaveBeenCalledTimes(1);

    const statusHandler = handlers.get(GPU_STATUS_CHANNEL);
    expect(statusHandler).toBeDefined();
    const status = (await statusHandler?.({}, undefined)) as { gpuProcessExitCount: number };
    expect(status.gpuProcessExitCount).toBe(1);
  });

  it('counts a renderer-reported WebGL context loss', async () => {
    const { app } = fakeApp({ gpu_compositing: 'enabled' });
    const { ipcMain, handlers } = fakeIpcMain();
    const logger = fakeLogger();

    attachGpuDiagnostics(app, ipcMain, logger);

    const lossHandler = handlers.get(GPU_WEBGL_LOSS_CHANNEL);
    expect(lossHandler).toBeDefined();
    const result = (await lossHandler?.({}, { surface: 'terminal', reason: 'webgl-context-lost' })) as {
      ok: boolean;
      webglContextLossCount: number;
    };
    expect(result.ok).toBe(true);
    expect(result.webglContextLossCount).toBe(1);
    expect(logger.warn).toHaveBeenCalledTimes(1);

    const statusHandler = handlers.get(GPU_STATUS_CHANNEL);
    const status = (await statusHandler?.({}, undefined)) as { webglContextLossCount: number };
    expect(status.webglContextLossCount).toBe(1);
  });

  it('does not attach twice', () => {
    const { app, listeners } = fakeApp({ gpu_compositing: 'enabled' });
    const { ipcMain, handlers } = fakeIpcMain();
    const logger = fakeLogger();

    attachGpuDiagnostics(app, ipcMain, logger);
    attachGpuDiagnostics(app, ipcMain, logger);

    expect(listeners).toHaveLength(1);
    expect(handlers.size).toBe(2);
  });
});
