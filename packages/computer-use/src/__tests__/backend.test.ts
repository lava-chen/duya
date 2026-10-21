/**
 * backend.test.ts — NoopDesktopBackend + ElectronDesktopBackend contract.
 *
 * Plan 454 §6.1 acceptance:
 *   - packages/computer-use/src/backend/types.test.ts: interface contract
 *   - packages/computer-use/src/backend/electron/win32.test.ts: nut.js / desktopCapturer mock verification
 *
 * Combined into a single file for Phase 1 — we'll split when the
 * surface grows past a couple hundred lines.
 */

import { describe, it, expect } from 'vitest';

import { NoopDesktopBackend } from '../backend/stub.js';
import { ElectronDesktopBackend } from '../backend/electron/win32.js';
import type {
  ElectronAdapter,
  NutAdapter,
  SharpAdapter,
  SharpPipeline,
} from '../backend/electron/win32.js';
import type { Win32NativeAdapter } from '../backend/electron/win32-injection.js';

describe('NoopDesktopBackend', () => {
  it('returns a valid capture shape by default', async () => {
    const backend = new NoopDesktopBackend();
    const cap = await backend.capture();
    expect(cap.base64.length).toBeGreaterThan(0);
    expect(cap.width).toBe(1);
    expect(cap.height).toBe(1);
    expect(cap.elements).toEqual([]);
    expect(cap.displayId).toBe(0);
    expect(typeof cap.capturedAt).toBe('string');
  });

  it('returns the configured default capture when supplied', async () => {
    const fixedCapture = {
      base64: 'fakedata',
      width: 1280,
      height: 720,
      elements: [],
      displayId: 2,
      capturedAt: '2026-08-28T00:00:00.000Z',
    };
    const backend = new NoopDesktopBackend({ defaultCapture: fixedCapture });
    const cap = await backend.capture({ displayId: 5 });
    expect(cap).toEqual(fixedCapture);
  });

  it('records all actions in order', async () => {
    const backend = new NoopDesktopBackend();
    await backend.capture({ somMode: true });
    await backend.click({ x: 100, y: 200 });
    await backend.typeText({ text: 'hello' });
    await backend.wait({ ms: 5 });

    const actions = backend.getRecordedActions();
    expect(actions.map((a) => a.method)).toEqual([
      'capture',
      'click',
      'typeText',
      'wait',
    ]);
    expect(actions[1]?.args).toEqual({ x: 100, y: 200 });
    expect(actions[2]?.args).toEqual({ text: 'hello' });
  });

  it('honors rejectActions and returns ok=false', async () => {
    const backend = new NoopDesktopBackend({ rejectActions: true });
    const result = await backend.click({ x: 1, y: 1 });
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/stub rejects/);
  });

  it('returns a fresh copy of defaultApps so callers cannot mutate cached state', async () => {
    const backend = new NoopDesktopBackend();
    const first = await backend.listApps();
    first[0].title = 'mutated';
    const second = await backend.listApps();
    expect(second[0].title).not.toBe('mutated');
  });

  it('wait(ms) honors non-zero delays but skips zero', async () => {
    const backend = new NoopDesktopBackend();
    const start = Date.now();
    await backend.wait({ ms: 0 });
    const elapsed = Date.now() - start;
    expect(elapsed).toBeLessThan(20);

    const start2 = Date.now();
    await backend.wait({ ms: 25 });
    expect(Date.now() - start2).toBeGreaterThanOrEqual(20);
  });
});

// ─────────────────────────────────────────────────────────────────────
// ElectronDesktopBackend — uses fakes for electron / sharp / nut
// ─────────────────────────────────────────────────────────────────────

/**
 * Test fake for `electron.desktopCapturer`. Records the requested
 * thumbnail size and returns a 1x1 PNG.
 */
function makeElectronFake(opts: { sources?: number } = {}): ElectronAdapter & {
  calls: Array<{ types: Array<'screen' | 'window'>; thumbnailSize?: { width: number; height: number } }>;
} {
  const calls: Array<{ types: Array<'screen' | 'window'>; thumbnailSize?: { width: number; height: number } }> = [];
  const sourceCount = opts.sources ?? 1;
  return {
    calls,
    desktopCapturer: {
      async getSources(o) {
        calls.push({ types: o.types, thumbnailSize: o.thumbnailSize });
        const out: Array<{
          id: string;
          name: string;
          display_id?: string;
          thumbnail: { toPNG(): Promise<Buffer>; getSize(): { width: number; height: number } };
        }> = [];
        for (let i = 0; i < sourceCount; i++) {
          out.push({
            id: `screen:${i}`,
            name: `Screen ${i}`,
            display_id: String(i),
            thumbnail: {
              async toPNG() {
                return Buffer.from([0x89, 0x50, 0x4e, 0x47]); // PNG magic prefix (fake)
              },
              getSize() {
                return { width: 1920, height: 1080 };
              },
            },
          });
        }
        return out;
      },
    },
  };
}

/**
 * Test fake for `sharp`. Implements just enough to let the overlay
 * pipeline run end-to-end and assert on call shape.
 */
function makeSharpFake(): SharpAdapter & {
  compositeCalls: number;
  resizeCalls: number;
} {
  const state = { compositeCalls: 0, resizeCalls: 0, extractCalls: 0 };
  const adapter = ((input: Buffer | string) => {
    const buf = Buffer.isBuffer(input) ? input : Buffer.from(String(input));
    const pipe: SharpPipeline = {
      resize(o) {
        state.resizeCalls++;
        expect(o).toBeDefined();
        return pipe;
      },
      extract(region) {
        expect(region.left).toBeGreaterThanOrEqual(0);
        expect(region.top).toBeGreaterThanOrEqual(0);
        expect(region.width).toBeGreaterThan(0);
        expect(region.height).toBeGreaterThan(0);
        state.extractCalls = (state.extractCalls ?? 0) + 1;
        return pipe;
      },
      composite(images) {
        state.compositeCalls++;
        expect(images.length).toBeGreaterThan(0);
        return pipe;
      },
      png() {
        return {
          async toBuffer() {
            // Return the input buffer as a stand-in for the encoded PNG.
            return buf;
          },
        };
      },
    };
    return pipe;
  }) as SharpAdapter & {
    compositeCalls: number;
    resizeCalls: number;
    extractCalls: number;
  };
  adapter.compositeCalls = state.compositeCalls;
  adapter.resizeCalls = state.resizeCalls;
  adapter.extractCalls = state.extractCalls;
  // Attach the mutable counters via a Proxy so .compositeCalls++ works.
  return new Proxy(adapter, {
    get(target, prop) {
      if (prop === 'compositeCalls' || prop === 'resizeCalls' || prop === 'extractCalls') return state[prop];
      return Reflect.get(target, prop);
    },
    set(target, prop, value) {
      if (prop === 'compositeCalls') state.compositeCalls = value;
      else if (prop === 'resizeCalls') state.resizeCalls = value;
      else if (prop === 'extractCalls') state.extractCalls = value;
      else Reflect.set(target, prop, value);
      return true;
    },
  }) as SharpAdapter & { compositeCalls: number; resizeCalls: number };
}

/**
 * Test fake for `@nut-tree-fork/nut-js`. Records mouse + keyboard
 * calls so tests can assert on the sequence.
 */
function makeNutFake(): NutAdapter & {
  mouseCalls: Array<{ method: string; args: unknown[] }>;
  keyboardCalls: Array<{ method: string; args: unknown[] }>;
} {
  const mouseCalls: Array<{ method: string; args: unknown[] }> = [];
  const keyboardCalls: Array<{ method: string; args: unknown[] }> = [];
  return {
    mouseCalls,
    keyboardCalls,
    mouse: {
      async setPosition(p) {
        mouseCalls.push({ method: 'setPosition', args: [p] });
      },
      async click(b) {
        mouseCalls.push({ method: 'click', args: [b] });
      },
      async drag(path) {
        mouseCalls.push({ method: 'drag', args: [path] });
      },
      async wheel(direction, amount) {
        mouseCalls.push({ method: 'wheel', args: [direction, amount] });
      },
    },
    keyboard: {
      async type(text, o) {
        keyboardCalls.push({ method: 'type', args: [text, o] });
      },
      async pressKey(...keys) {
        keyboardCalls.push({ method: 'pressKey', args: keys });
      },
    },
    Key: { Enter: 'Enter', Escape: 'Escape', Tab: 'Tab', A: 'A' },
    Button: { LEFT: 0, RIGHT: 2, MIDDLE: 1 },
  };
}

describe('ElectronDesktopBackend (Phase 1 contract)', () => {
  it('captures a screen and returns a base64 string', async () => {
    const electron = makeElectronFake();
    const sharp = makeSharpFake();
    const nut = makeNutFake();
    const backend = new ElectronDesktopBackend({ electron, sharp, nut });

    const cap = await backend.capture();
    expect(electron.calls.length).toBe(1);
    expect(electron.calls[0]?.types).toEqual(['screen']);
    expect(cap.base64.length).toBeGreaterThan(0);
    expect(cap.width).toBe(1920);
    expect(cap.height).toBe(1080);
    expect(cap.elements).toEqual([]);
  });

  it('captures with SOM mode — invokes detector + overlay', async () => {
    const electron = makeElectronFake();
    const sharp = makeSharpFake();
    const nut = makeNutFake();
    const detected = [
      { index: 1, bbox: { x: 10, y: 20, w: 100, h: 50 }, label: 'btn-1' },
    ];
    const renderOverlay = async (img: Buffer) => img;
    const detectElements = async () => detected;
    const backend = new ElectronDesktopBackend({
      electron,
      sharp,
      nut,
      detectElements,
      renderOverlay,
    });

    const cap = await backend.capture({ somMode: true });
    expect(cap.elements).toEqual(detected);
  });

  it('capture with region crops to that region and rebases element bboxes', async () => {
    const electron = makeElectronFake();
    const sharp = makeSharpFake();
    const detected = [
      { index: 1, bbox: { x: 800, y: 900, w: 80, h: 30 }, label: 'inside' },
      { index: 2, bbox: { x: 1500, y: 100, w: 100, h: 50 }, label: 'outside' },
    ];
    const renderOverlay = async (img: Buffer) => img;
    const detectElements = async () => detected;
    const backend = new ElectronDesktopBackend({
      electron,
      sharp,
      nut: makeNutFake(),
      detectElements,
      renderOverlay,
    });

    const cap = await backend.capture({
      somMode: true,
      region: { x: 700, y: 800, w: 400, h: 200 },
    });
    expect(sharp.extractCalls).toBe(1);
    expect(cap.width).toBe(400);
    expect(cap.height).toBe(200);
    expect(cap.elements.length).toBe(1);
    // Rebased to the cropped image: 800-700=100, 900-800=100.
    expect(cap.elements[0]?.bbox).toEqual({ x: 100, y: 100, w: 80, h: 30 });
  });

  it('click falls back to explicit coords and calls nut.mouse.setPosition+click', async () => {
    const electron = makeElectronFake();
    const sharp = makeSharpFake();
    const nut = makeNutFake();
    const backend = new ElectronDesktopBackend({ electron, sharp, nut });

    const result = await backend.click({ x: 100, y: 200 });
    expect(result.ok).toBe(true);
    expect(nut.mouseCalls.map((c) => c.method)).toEqual(['setPosition', 'click']);
    expect(nut.mouseCalls[0]?.args).toEqual([{ x: 100, y: 200 }]);
  });

  it('click sends the numeric Button enum value (LEFT=0) to nut.mouse.click', async () => {
    const electron = makeElectronFake();
    const sharp = makeSharpFake();
    const nut = makeNutFake();
    const backend = new ElectronDesktopBackend({ electron, sharp, nut });

    await backend.click({ x: 10, y: 20, button: 'right' });
    const clickCall = nut.mouseCalls.find((c) => c.method === 'click');
    // nut.js expects the numeric value from @nut-tree-fork/shared
    // Button enum (LEFT=0, MIDDLE=1, RIGHT=2). Strings like
    // 'LEFT' cause libnut's mouseClick to throw "A string was
    // expected" because Map.get on the numeric-keyed ButtonLookupMap
    // returns undefined.
    expect(clickCall?.args).toEqual([2]);
  });

  it('click with element-only ref returns ok=false in Phase 1', async () => {
    const electron = makeElectronFake();
    const sharp = makeSharpFake();
    const nut = makeNutFake();
    const backend = new ElectronDesktopBackend({ electron, sharp, nut });

    const result = await backend.click({ element: 5 });
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/element/);
    // No mouse calls should have been made.
    expect(nut.mouseCalls).toEqual([]);
  });

  it('drag interpolates a path and calls mouse.drag', async () => {
    const electron = makeElectronFake();
    const sharp = makeSharpFake();
    const nut = makeNutFake();
    const backend = new ElectronDesktopBackend({ electron, sharp, nut });

    const result = await backend.drag({
      fromX: 0,
      fromY: 0,
      toX: 100,
      toY: 100,
      steps: 4,
    });
    expect(result.ok).toBe(true);
    expect(nut.mouseCalls.map((c) => c.method)).toEqual(['drag']);
    const path = nut.mouseCalls[0]?.args[0] as Array<{ x: number; y: number }>;
    expect(path.length).toBe(5); // steps + 1 (inclusive)
    expect(path[0]).toEqual({ x: 0, y: 0 });
    expect(path[4]).toEqual({ x: 100, y: 100 });
  });

  it('scroll maps direction up → wheel(UP, amount)', async () => {
    const electron = makeElectronFake();
    const sharp = makeSharpFake();
    const nut = makeNutFake();
    const backend = new ElectronDesktopBackend({ electron, sharp, nut });

    const result = await backend.scroll({ direction: 'up', amount: 3 });
    expect(result.ok).toBe(true);
    expect(nut.mouseCalls[0]).toEqual({
      method: 'wheel',
      args: ['UP', 3],
    });
  });

  it('typeText forwards text + delayMs to nut.keyboard.type', async () => {
    const electron = makeElectronFake();
    const sharp = makeSharpFake();
    const nut = makeNutFake();
    const backend = new ElectronDesktopBackend({ electron, sharp, nut });

    const result = await backend.typeText({ text: 'hello', delayMs: 25 });
    expect(result.ok).toBe(true);
    expect(nut.keyboardCalls[0]).toEqual({
      method: 'type',
      args: ['hello', { delayMs: 25 }],
    });
  });

  it('key presses a key plus its modifiers in one call', async () => {
    const electron = makeElectronFake();
    const sharp = makeSharpFake();
    const nut = makeNutFake();
    const backend = new ElectronDesktopBackend({ electron, sharp, nut });

    await backend.key({ key: 'A', modifiers: ['ctrl'] });
    expect(nut.keyboardCalls[0]?.method).toBe('pressKey');
    expect(nut.keyboardCalls[0]?.args).toEqual(['A', 'ctrl']);
  });

  it('focusApp uses the configured provider', async () => {
    const electron = makeElectronFake();
    const sharp = makeSharpFake();
    const nut = makeNutFake();
    const focusAppProvider = async () => true;
    const backend = new ElectronDesktopBackend({
      electron,
      sharp,
      nut,
      focusAppProvider,
    });

    const result = await backend.focusApp({ title: 'foo' });
    expect(result.ok).toBe(true);
  });

  it('focusApp without provider returns ok=false with reason', async () => {
    const electron = makeElectronFake();
    const sharp = makeSharpFake();
    const nut = makeNutFake();
    const backend = new ElectronDesktopBackend({ electron, sharp, nut });

    const result = await backend.focusApp({ title: 'foo' });
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/no provider/);
  });

  it('listApps falls back to empty when no provider configured', async () => {
    const electron = makeElectronFake();
    const sharp = makeSharpFake();
    const nut = makeNutFake();
    const backend = new ElectronDesktopBackend({ electron, sharp, nut });

    const apps = await backend.listApps();
    expect(apps).toEqual([]);
  });

  it('setValue issues select-all + type (ctrl+A by default)', async () => {
    const electron = makeElectronFake();
    const sharp = makeSharpFake();
    const nut = makeNutFake();
    const backend = new ElectronDesktopBackend({ electron, sharp, nut });

    const result = await backend.setValue({ value: 'replaced' });
    expect(result.ok).toBe(true);
    // pressKey for ctrl+A, then type
    expect(nut.keyboardCalls[0]?.method).toBe('pressKey');
    expect(nut.keyboardCalls[1]?.method).toBe('type');
    expect(nut.keyboardCalls[1]?.args).toEqual(['replaced', { delayMs: 10 }]);
  });

  it('handles missing desktopCapturer sources gracefully', async () => {
    const electron = makeElectronFake({ sources: 0 });
    const sharp = makeSharpFake();
    const nut = makeNutFake();
    const backend = new ElectronDesktopBackend({ electron, sharp, nut });

    const cap = await backend.capture();
    expect(cap.base64).toBe('');
    expect(cap.width).toBe(0);
    expect(cap.elements).toEqual([]);
  });

  it('id is "electron"', () => {
    const electron = makeElectronFake();
    const sharp = makeSharpFake();
    const nut = makeNutFake();
    const backend = new ElectronDesktopBackend({ electron, sharp, nut });
    expect(backend.id).toBe('electron');
  });

  // ── Phase 3 / §3.7 — background-priority click injection ──────────────
  it('click with a win32 adapter flags fallbackUsed on the verdict when the target window must raise', async () => {
    const electron = makeElectronFake();
    const sharp = makeSharpFake();
    const nut = makeNutFake();
    const readFocusedEntity = async () => ({
      kind: 'button' as const,
      name: 'ignored',
      rect: { x: 0, y: 0, width: 0, height: 0 },
    });
    const win32InputProvider: Win32NativeAdapter = {
      // Target window differs from foreground AND foreground is unknown
      // (headless-style snapshot) → raise fallback.
      getForegroundWindow: () => null,
      windowFromPoint: () => 0x40,
    };
    const backend = new ElectronDesktopBackend({
      electron,
      sharp,
      nut,
      readFocusedEntity,
      win32InputProvider,
    });

    const result = await backend.click({ x: 10, y: 20 });
    expect(result.ok).toBe(true);
    // readFocusedEntity is stable across the read-back (element unchanged),
    // so the verdict is suspected_noop; the injection patch ADDS
    // fallbackUsed=true.
    expect(result.verdict?.fallbackUsed).toBe(true);
  });

  it('click with a win32 adapter does NOT flag fallbackUsed for a same-window target', async () => {
    const electron = makeElectronFake();
    const sharp = makeSharpFake();
    const nut = makeNutFake();
    const readFocusedEntity = async () => ({
      kind: 'button' as const,
      name: 'ignored',
      rect: { x: 0, y: 0, width: 0, height: 0 },
    });
    const win32InputProvider: Win32NativeAdapter = {
      getForegroundWindow: () => 0x50,
      // Same HWND as foreground → same-window, no fallback.
      windowFromPoint: () => 0x50,
    };
    const backend = new ElectronDesktopBackend({
      electron,
      sharp,
      nut,
      readFocusedEntity,
      win32InputProvider,
    });

    const result = await backend.click({ x: 10, y: 20 });
    expect(result.ok).toBe(true);
    expect(result.verdict?.fallbackUsed).toBeUndefined();
    expect(result.verdict?.effect).toBe('suspected_noop');
  });

  // ── Phase 3 / §3.7 — focusApp raise default ────────────────────────────
  it('focusApp defaults raise to false for the provider', async () => {
    const electron = makeElectronFake();
    const sharp = makeSharpFake();
    const nut = makeNutFake();
    let received: { title?: string; raise?: boolean } | null = null;
    const focusAppProvider = async (opts: { title?: string; raise?: boolean }) => {
      received = opts;
      return true;
    };
    const backend = new ElectronDesktopBackend({
      electron,
      sharp,
      nut,
      focusAppProvider,
    });

    await backend.focusApp({ title: 'foo' });
    expect(received?.raise).toBe(false);
  });

  it('focusApp passes through an explicit raise=true', async () => {
    const electron = makeElectronFake();
    const sharp = makeSharpFake();
    const nut = makeNutFake();
    let received: { title?: string; raise?: boolean } | null = null;
    const focusAppProvider = async (opts: { title?: string; raise?: boolean }) => {
      received = opts;
      return true;
    };
    const backend = new ElectronDesktopBackend({
      electron,
      sharp,
      nut,
      focusAppProvider,
    });

    await backend.focusApp({ title: 'foo', raise: true });
    expect(received?.raise).toBe(true);
  });
});