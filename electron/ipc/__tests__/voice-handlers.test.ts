/**
 * voice-handlers.test.ts — Unit tests for the voice:* IPC channels.
 *
 * The handlers are a thin adapter over VoiceService: registration shape,
 * chunk validation (typed + bounded), and pass-through of the service
 * results. We mock the service + electron so no subprocess or mic is
 * touched.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  service: {
    start: vi.fn(async () => ({ ok: true })),
    transcribeChunk: vi.fn(() => ({ ok: true })),
    stop: vi.fn(async () => ({ ok: true })),
    cancel: vi.fn(async () => ({ ok: true })),
    getConfig: vi.fn(() => ({
      enabled: true,
      inputDevice: '',
      engine: 'local',
      endSilenceMs: 900,
      noSpeechTimeoutMs: 4000,
      chunkMs: 200,
      language: 'zh',
      model: 'ggml-base.bin',
      modelReady: true,
      modelSizeMb: 142,
      cloudProvider: '',
      cloudModel: 'whisper-1',
    })),
    getModelStatus: vi.fn(() => ({ model: 'ggml-base.bin', ready: true, sizeMb: 142 })),
    getModelList: vi.fn(() => [{ model: 'ggml-base.bin', ready: true, sizeMb: 142 }]),
    envReport: vi.fn(() => ({ platform: 'win32', binaryFound: true, installSteps: [] })),
    runtimeStatus: vi.fn(() => ({ ready: false, installable: true })),
    installRuntime: vi.fn(async () => ({ ok: true })),
    downloadModel: vi.fn(async () => ({ ok: true })),
    cloudTest: vi.fn(async () => ({ ok: true, latencyMs: 120 })),
    dispose: vi.fn(),
  },
  createVoiceService: vi.fn(() => mocks.service),
  captured: {
    handle: new Map<string, (event: unknown, ...args: unknown[]) => unknown | Promise<unknown>>(),
  },
  windows: [] as Array<{ webContents: { send: ReturnType<typeof vi.fn> }; isDestroyed: () => boolean }>,
}));

vi.mock('electron', () => ({
  ipcMain: {
    handle: (c: string, fn: (event: unknown, ...args: unknown[]) => unknown | Promise<unknown>) => {
      mocks.captured.handle.set(c, fn);
    },
  },
  BrowserWindow: {
    getAllWindows: () => mocks.windows,
  },
}));

vi.mock('../../logging/logger', () => ({
  initLogger: vi.fn(),
  getLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
  LogComponent: new Proxy({}, { get: (_t, p) => String(p) }),
}));

vi.mock('../../services/voice', () => ({
  createVoiceService: (opts: unknown) => mocks.createVoiceService(opts),
}));

import { registerVoiceHandlers } from '../voice-handlers';

// registerVoiceHandlers is module-level idempotent, so register exactly once
// at import time; beforeEach only clears call history.
registerVoiceHandlers();

function invoke(channel: string, ...args: unknown[]): Promise<unknown> {
  const handler = mocks.captured.handle.get(channel);
  if (!handler) throw new Error(`No handler registered for channel "${channel}"`);
  return Promise.resolve(handler({}, ...args));
}

describe('voice-handlers', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.windows = [];
  });

  it('registers the full channel set exactly once', () => {
    const channels = [...mocks.captured.handle.keys()].sort();
    expect(channels).toEqual([
      'voice:cancel',
      'voice:cloud-test',
      'voice:config',
      'voice:env-doctor',
      'voice:model-download',
      'voice:model-list',
      'voice:model-status',
      'voice:runtime-download',
      'voice:runtime-status',
      'voice:start',
      'voice:stop',
      'voice:transcribe-chunk',
    ]);
  });

  it('voice:start passes session options through', async () => {
    const result = await invoke('voice:start', { sessionId: 's1' });
    expect(result).toEqual({ ok: true });
    expect(mocks.service.start).toHaveBeenCalledWith({ sessionId: 's1' });
  });

  it('voice:transcribe-chunk accepts Int16Array under 64 KiB', async () => {
    const chunk = new Int16Array(3200); // 6.4 KB — one 200 ms block
    const result = await invoke('voice:transcribe-chunk', chunk);
    expect(result).toEqual({ ok: true });
    expect(mocks.service.transcribeChunk).toHaveBeenCalledWith(chunk);
  });

  it('voice:transcribe-chunk rejects non-typed-array payloads', async () => {
    const result = (await invoke('voice:transcribe-chunk', 'not-a-chunk')) as {
      ok: boolean;
      error?: string;
    };
    expect(result.ok).toBe(false);
    expect(mocks.service.transcribeChunk).not.toHaveBeenCalled();
  });

  it('voice:transcribe-chunk rejects oversized chunks', async () => {
    const huge = new Int16Array(64 * 1024 / 2 + 1); // > 64 KiB
    const result = (await invoke('voice:transcribe-chunk', huge)) as {
      ok: boolean;
      error?: string;
    };
    expect(result.ok).toBe(false);
    expect(result.error).toContain('large');
    expect(mocks.service.transcribeChunk).not.toHaveBeenCalled();
  });

  it('voice:model-download validates the model name type', async () => {
    const bad = (await invoke('voice:model-download', 42)) as { ok: boolean; message?: string };
    expect(bad.ok).toBe(false);
    expect(mocks.service.downloadModel).not.toHaveBeenCalled();

    const good = await invoke('voice:model-download', 'ggml-base.bin');
    expect(good).toEqual({ ok: true });
    expect(mocks.service.downloadModel).toHaveBeenCalledWith('ggml-base.bin');
  });

  it('exposes config, env, runtime and cloud-test endpoints', async () => {
    expect(await invoke('voice:config')).toMatchObject({ enabled: true, inputDevice: '' });
    expect(await invoke('voice:env-doctor')).toMatchObject({ binaryFound: true });
    expect(await invoke('voice:runtime-status')).toMatchObject({ installable: true });
    expect(await invoke('voice:runtime-download')).toEqual({ ok: true });
    expect(await invoke('voice:cloud-test')).toEqual({ ok: true, latencyMs: 120 });
  });
});
