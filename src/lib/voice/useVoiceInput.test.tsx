// @vitest-environment jsdom
// src/lib/voice/useVoiceInput.test.tsx
// Plan 411 Phase 3 + Plan 427: verify onNeedsSetup gating (model not ready /
// voice disabled), device + block-size wiring into the capture layer, and
// permission-failure surfacing.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useVoiceInput, type UseVoiceInputOptions } from './useVoiceInput';

interface VoiceApiMock {
  getConfig: ReturnType<typeof vi.fn>;
  onInterim: ReturnType<typeof vi.fn>;
  onFinal: ReturnType<typeof vi.fn>;
  onError: ReturnType<typeof vi.fn>;
  onCancelled: ReturnType<typeof vi.fn>;
  onAutoStop: ReturnType<typeof vi.fn>;
  start: ReturnType<typeof vi.fn>;
  transcribeChunk: ReturnType<typeof vi.fn>;
  stop: ReturnType<typeof vi.fn>;
  cancel: ReturnType<typeof vi.fn>;
}

const mocks = vi.hoisted(() => {
  const api: VoiceApiMock = {
    getConfig: vi.fn(),
    onInterim: vi.fn(() => () => {}),
    onFinal: vi.fn(() => () => {}),
    onError: vi.fn(() => () => {}),
    onCancelled: vi.fn(() => () => {}),
    onAutoStop: vi.fn(() => () => {}),
    start: vi.fn(async () => ({ ok: true })),
    transcribeChunk: vi.fn(async () => ({ ok: true })),
    stop: vi.fn(async () => ({ ok: true })),
    cancel: vi.fn(async () => ({ ok: true })),
  };
  /** Shared capture-start implementation so tests can override per case. */
  const captureStart = vi.fn(
    async (_opts?: unknown): Promise<{ ok: boolean; message?: string }> => ({ ok: true }),
  );
  const captureInstances: Array<{
    start: typeof captureStart;
    stop: ReturnType<typeof vi.fn>;
    setCallbacks: ReturnType<typeof vi.fn>;
  }> = [];
  return { api, captureStart, captureInstances };
});

vi.mock('./voice-capture', () => ({
  AudioWorkletVoiceCapture: class {
    start = mocks.captureStart;
    stop = vi.fn();
    setCallbacks = vi.fn();
    active = false;
    constructor() {
      mocks.captureInstances.push(this);
    }
  },
}));

beforeEach(() => {
  vi.resetAllMocks();
  mocks.captureInstances.length = 0;
  // Re-establish defaults after reset.
  mocks.api.onInterim.mockReturnValue(() => {});
  mocks.api.onFinal.mockReturnValue(() => {});
  mocks.api.onError.mockReturnValue(() => {});
  mocks.api.onCancelled.mockReturnValue(() => {});
  mocks.api.onAutoStop.mockReturnValue(() => {});
  mocks.api.start.mockResolvedValue({ ok: true });
  mocks.api.transcribeChunk.mockResolvedValue({ ok: true });
  mocks.api.stop.mockResolvedValue({ ok: true });
  mocks.api.cancel.mockResolvedValue({ ok: true });
  mocks.captureStart.mockResolvedValue({ ok: true });
  (globalThis as Record<string, unknown>).window = {
    electronAPI: { voice: mocks.api },
  } as unknown as Window;
});

function renderStart(opts: { enabled?: boolean; modelReady?: boolean; inputDevice?: string; chunkMs?: number }) {
  const enabled = opts.enabled ?? true;
  const modelReady = opts.modelReady ?? true;
  mocks.api.getConfig.mockResolvedValue({
    enabled,
    inputDevice: opts.inputDevice ?? '',
    engine: 'local',
    endSilenceMs: 900,
    noSpeechTimeoutMs: 4000,
    chunkMs: opts.chunkMs ?? 200,
    language: 'zh',
    model: 'ggml-base.bin',
    modelReady,
    modelSizeMb: 142,
    cloudProvider: '',
    cloudModel: 'whisper-1',
  });
  const onNeedsSetup = vi.fn();
  const hookOpts: UseVoiceInputOptions = {
    onText: vi.fn(),
    onNeedsSetup,
  };
  const { result } = renderHook(() => useVoiceInput(hookOpts));
  return { result, onNeedsSetup };
}

describe('useVoiceInput onNeedsSetup', () => {
  it('fires onNeedsSetup when the STT model is not ready', async () => {
    const { result, onNeedsSetup } = renderStart({ modelReady: false });
    await act(async () => {
      await result.current.start();
    });
    expect(onNeedsSetup).toHaveBeenCalledTimes(1);
    expect(result.current.errorCode).toBe('model_not_ready');
  });

  it('fires onNeedsSetup when voice is disabled', async () => {
    const { result, onNeedsSetup } = renderStart({ enabled: false });
    await act(async () => {
      await result.current.start();
    });
    expect(onNeedsSetup).toHaveBeenCalledTimes(1);
    expect(result.current.errorMessage).toContain('未启用');
  });

  it('does NOT fire onNeedsSetup when the model is ready', async () => {
    const { result, onNeedsSetup } = renderStart({});
    await act(async () => {
      await result.current.start();
    });
    expect(onNeedsSetup).not.toHaveBeenCalled();
    expect(result.current.status).toBe('recording');
  });
});

describe('useVoiceInput capture wiring', () => {
  it('passes the configured input device and chunkMs-derived block size', async () => {
    const { result } = renderStart({ inputDevice: 'device-42', chunkMs: 100 });
    await act(async () => {
      await result.current.start();
    });
    const capture = mocks.captureInstances[0];
    expect(capture).toBeTruthy();
    expect(capture.start).toHaveBeenCalledWith({
      deviceId: 'device-42',
      blockSamples: 1600, // 100 ms @ 16 kHz
    });
  });

  it('omits deviceId when unset and defaults blocks to chunkMs=200ms', async () => {
    const { result } = renderStart({});
    await act(async () => {
      await result.current.start();
    });
    const capture = mocks.captureInstances[0];
    expect(capture.start).toHaveBeenCalledWith({
      deviceId: undefined,
      blockSamples: 3200,
    });
  });

  it('surfaces capture permission failures as error state', async () => {
    const { result } = renderStart({});
    mocks.captureStart.mockResolvedValueOnce({ ok: false, message: '麦克风权限被拒绝' });
    await act(async () => {
      await result.current.start();
    });
    expect(result.current.errorCode).toBe('permission_denied');
    expect(result.current.errorMessage).toBe('麦克风权限被拒绝');
    expect(result.current.status).toBe('error');
  });

  it('streams chunks through transcribeChunk once callbacks are set', async () => {
    const { result } = renderStart({});
    await act(async () => {
      await result.current.start();
    });
    const capture = mocks.captureInstances[0];
    const cbs = capture.setCallbacks.mock.calls[0][0] as {
      onChunk: (c: Int16Array) => void;
    };
    const chunk = new Int16Array(3200);
    await act(async () => {
      cbs.onChunk(chunk);
    });
    expect(mocks.api.transcribeChunk).toHaveBeenCalledWith(chunk);
  });
});
