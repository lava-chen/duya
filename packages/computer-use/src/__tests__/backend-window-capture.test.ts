/**
 * backend window capture — plan 572 Phase 5 contract tests.
 *
 * `capture({ windowId })` routes through the injectable
 * `windowCaptureProvider` (macOS: the AX helper's ScreenCaptureKit op)
 * and degrades to the full-screen desktopCapturer path on every miss —
 * a window capture must never fail for asking.
 */

import { describe, it, expect } from 'vitest';

import { ElectronDesktopBackend } from '../backend/electron/win32.js';
import type { ElectronAdapter, NutAdapter, SharpAdapter } from '../backend/electron/win32.js';

function makeElectronFake(): ElectronAdapter & { calls: number } {
  const calls = { count: 0 };
  return {
    calls,
    desktopCapturer: {
      async getSources() {
        calls.count += 1;
        return [
          {
            id: 'screen:0',
            name: 'Screen 0',
            display_id: '0',
            thumbnail: {
              async toPNG() {
                return Buffer.from([0x89, 0x50, 0x4e, 0x47]);
              },
              getSize() {
                return { width: 1920, height: 1080 };
              },
            },
          },
        ];
      },
    },
  };
}

function makeNutFake(): NutAdapter {
  return {
    mouse: {
      async setPosition() {},
      async click() {},
      async wheel() {},
    },
    keyboard: {
      async type() {},
      async pressKey() {},
    },
    Key: {},
    Button: { LEFT: 0, MIDDLE: 1, RIGHT: 2 },
  };
}

function makeSharpFake(): SharpAdapter {
  const adapter = ((input: Buffer | string) => {
    const pipeline = {
      resize() {
        return pipeline;
      },
      extract() {
        return pipeline;
      },
      composite() {
        return pipeline;
      },
      png() {
        return { async toBuffer() { return Buffer.from(input); } };
      },
    };
    return pipeline;
  }) as unknown as SharpAdapter;
  return adapter;
}

function makeBackend(
  provider: ((windowId: number) => Promise<{ base64: string; width: number; height: number } | null>) | null,
): { backend: ElectronDesktopBackend; electron: ReturnType<typeof makeElectronFake> } {
  const electron = makeElectronFake();
  const backend = new ElectronDesktopBackend({
    electron,
    sharp: makeSharpFake(),
    nut: makeNutFake(),
    ...(provider ? { windowCaptureProvider: provider } : {}),
  });
  return { backend, electron };
}

describe('capture({ windowId }) — plan 572 Phase 5', () => {
  it('uses the window provider when it answers with a real image', async () => {
    const providerCalls: number[] = [];
    const { backend, electron } = makeBackend(async (windowId) => {
      providerCalls.push(windowId);
      return { base64: Buffer.from('windowpng').toString('base64'), width: 800, height: 600 };
    });
    const cap = await backend.capture({ windowId: 6506 });
    expect(providerCalls).toEqual([6506]);
    expect(electron.calls.count).toBe(0); // full-screen path skipped
    expect(cap.width).toBe(800);
    expect(cap.height).toBe(600);
    expect(cap.base64.length).toBeGreaterThan(0);
  });

  it('falls back to the full-screen path when the provider answers null (SDK < 14)', async () => {
    const { backend, electron } = makeBackend(async () => null);
    const cap = await backend.capture({ windowId: 1 });
    expect(electron.calls.count).toBe(1);
    expect(cap.width).toBe(1920);
    expect(cap.height).toBe(1080);
  });

  it('falls back when no provider is wired (non-mac production wiring)', async () => {
    const { backend, electron } = makeBackend(null);
    const cap = await backend.capture({ windowId: 1 });
    expect(electron.calls.count).toBe(1);
    expect(cap.width).toBe(1920);
  });

  it('falls back when the provider throws', async () => {
    const { backend, electron } = makeBackend(async () => {
      throw new Error('helper died');
    });
    const cap = await backend.capture({ windowId: 2 });
    expect(electron.calls.count).toBe(1);
    expect(cap.base64.length).toBeGreaterThan(0);
  });

  it('ignores windowId without a provider rather than failing the shape', async () => {
    const { backend, electron } = makeBackend(null);
    const cap = await backend.capture({});
    expect(electron.calls.count).toBe(1);
    expect(cap.elements).toEqual([]);
  });
});
