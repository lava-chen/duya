// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  bounds: { x: 0, y: 0, width: 1200, height: 800 },
  physicalOrigin: { x: 0, y: 0 },
  scale: 1,
  destroyed: false,
  pending: [] as Promise<unknown>[],
  runScript: null as null | ((script: string) => unknown),
}));

vi.mock('electron', () => ({
  BrowserWindow: class {
    constructor() { mocks.destroyed = false; }
    setAlwaysOnTop() {}
    setIgnoreMouseEvents() {}
    setContentProtection() {}
    once() {}
    showInactive() {}
    isDestroyed() { return mocks.destroyed; }
    destroy() { mocks.destroyed = true; }
    getBounds() { return mocks.bounds; }
    loadURL(url: string) {
      document.documentElement.innerHTML = decodeURIComponent(url.slice(url.indexOf(',') + 1));
      mocks.runScript?.(document.querySelector('script')?.textContent ?? '');
      return Promise.resolve();
    }
    webContents = {
      executeJavaScript: (script: string) => {
        const result = Promise.resolve().then(() => mocks.runScript?.(script));
        mocks.pending.push(result);
        return result;
      },
    };
  },
  screen: {
    on: vi.fn(),
    getPrimaryDisplay: () => ({ id: 1, bounds: mocks.bounds }),
    getDisplayMatching: () => ({ id: 1, bounds: mocks.bounds }),
    screenToDipRect: (_window: unknown, rect: { x: number; y: number; width: number; height: number }) => ({
      x: (rect.x - mocks.physicalOrigin.x) / mocks.scale + mocks.bounds.x,
      y: (rect.y - mocks.physicalOrigin.y) / mocks.scale + mocks.bounds.y,
      width: rect.width / mocks.scale,
      height: rect.height / mocks.scale,
    }),
  },
}));

vi.mock('../../../logging/logger.js', () => ({
  getLogger: () => ({ debug: vi.fn(), warn: vi.fn() }),
  LogComponent: { ComputerUse: 'ComputerUse' },
}));

import { clearOverlayElements, isElementOverlayActive, showOverlayElements } from '../index.js';

async function flushScripts(): Promise<void> {
  for (let attempts = 0; attempts < 5 && mocks.pending.length === 0; attempts += 1) {
    await Promise.resolve();
  }
  for (let index = 0; index < mocks.pending.length; index += 1) {
    await mocks.pending[index];
  }
}

beforeEach(() => {
  mocks.pending = [];
  mocks.bounds = { x: 0, y: 0, width: 1200, height: 800 };
  mocks.physicalOrigin = { x: 0, y: 0 };
  mocks.scale = 1;
  mocks.runScript = (script) => new Function('window', 'document', script)(window, document);
  vi.stubGlobal('process', Object.create(process, { platform: { value: 'win32' } }));
});

afterEach(() => {
  clearOverlayElements();
  vi.unstubAllGlobals();
});

describe('overlay main-to-renderer coordinates', () => {
  it.each([
    { name: 'primary display at 100%', x: 0, y: 0, scale: 1 },
    { name: 'primary display at 150%', x: 0, y: 0, scale: 1.5 },
    { name: 'left display with a vertical offset at 150%', x: -1200, y: 100, scale: 1.5 },
  ])('positions distinct frames and badges on $name', async ({ x, y, scale }) => {
    mocks.bounds = { ...mocks.bounds, x, y };
    mocks.scale = scale;
    mocks.physicalOrigin = { x: x * scale, y: y * scale };
    const targets = [{ x: 120, y: 80, w: 100, h: 30 }, { x: 620, y: 360, w: 140, h: 40 }];
    const elements = targets.map((rect) => ({
      controlType: 'Button',
      interactive: true,
      rect: {
        x: mocks.physicalOrigin.x + rect.x * scale,
        y: mocks.physicalOrigin.y + rect.y * scale,
        w: rect.w * scale,
        h: rect.h * scale,
      },
    }));
    const original = JSON.stringify(elements);

    showOverlayElements(elements);
    await flushScripts();

    const frames = [...document.querySelectorAll<HTMLElement>('.frame')];
    const badges = [...document.querySelectorAll<HTMLElement>('.badge')];
    expect(frames).toHaveLength(2);
    expect(badges).toHaveLength(2);
    targets.forEach((target, index) => {
      expect(frames[index].style.left).toBe(`${target.x}px`);
      expect(frames[index].style.top).toBe(`${target.y}px`);
      expect(frames[index].style.width).toBe(`${target.w}px`);
      expect(frames[index].style.height).toBe(`${target.h}px`);
      expect(badges[index].style.left).toBe(`${target.x}px`);
      expect(badges[index].style.top).toBe(`${target.y - 8}px`);
    });
    expect(JSON.stringify(elements)).toBe(original);

    showOverlayElements([elements[1]]);
    await flushScripts();
    expect(document.querySelectorAll('.frame')).toHaveLength(1);
    expect(document.querySelector<HTMLElement>('.frame')?.style.left).toBe('620px');
    clearOverlayElements();
    expect(mocks.destroyed).toBe(true);
    expect(isElementOverlayActive()).toBe(false);
  });
});
