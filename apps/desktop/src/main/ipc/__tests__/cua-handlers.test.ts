/**
 * cua-handlers.test.ts — Dispatch-layer contract tests for the
 * `computer-use:cua` channel (plan 578 smoke fix).
 *
 * The service unit tests call CuaService methods with the nested
 * `{ appRef: {...} }` shape; the AGENT tool schema exposes the app_ref
 * as TOP-LEVEL pid/name/windowId fields. The translation lives in
 * dispatchCuaTool — and when it was missing, every element action
 * failed with ELEMENT_UNAVAILABLE "no observation for this app_ref
 * yet" on a real machine. These tests pin the translation through the
 * real dispatch path with a fake service, so the two shapes can never
 * drift apart silently again.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  const noopLogger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    time: () => () => undefined,
    timeAsync: async <T>(fn: () => Promise<T>) => fn(),
  };
  const calls = {
    leftClick: [] as Array<Record<string, unknown>>,
    leftClickDrag: [] as Array<Record<string, unknown>>,
    setValue: [] as Array<Record<string, unknown>>,
    selectText: [] as Array<Record<string, unknown>>,
    performAction: [] as Array<Record<string, unknown>>,
    getAppState: [] as Array<Record<string, unknown>>,
  };
  const receipt = { tool: 'x', actionSent: true, dispatchStatus: 'possibly_sent' };
  const fakeService = {
    listApps: vi.fn(async () => []),
    listWindows: vi.fn(async () => []),
    getAppState: vi.fn(async (args: Record<string, unknown>) => {
      calls.getAppState.push(args);
      return { observation: {}, text: '' };
    }),
    leftClick: vi.fn(async (args: Record<string, unknown>) => {
      calls.leftClick.push(args);
      return receipt;
    }),
    leftClickDrag: vi.fn(async (args: Record<string, unknown>) => {
      calls.leftClickDrag.push(args);
      return receipt;
    }),
    scroll: vi.fn(async () => receipt),
    typeText: vi.fn(async () => receipt),
    key: vi.fn(async () => receipt),
    setValue: vi.fn(async (args: Record<string, unknown>) => {
      calls.setValue.push(args);
      return receipt;
    }),
    selectText: vi.fn(async (args: Record<string, unknown>) => {
      calls.selectText.push(args);
      return receipt;
    }),
    performAction: vi.fn(async (args: Record<string, unknown>) => {
      calls.performAction.push(args);
      return receipt;
    }),
    paste: vi.fn(async () => receipt),
    requestAccess: vi.fn(async () => ({ ready: true, platform: 'win32', notes: [] })),
    stop: vi.fn(),
  };
  return { calls, fakeService, ctorDeps: [] as Array<Record<string, unknown>>, noopLogger };
});

vi.mock('electron', () => ({
  clipboard: { writeText: vi.fn() },
  desktopCapturer: { getSources: vi.fn(async () => []) },
}));

vi.mock('../../logging/logger.js', () => ({
  getLogger: () => mocks.noopLogger,
  initLogger: () => mocks.noopLogger,
  LogComponent: { ComputerUse: 'ComputerUse' },
}));

vi.mock('../../services/computer-use-guard.js', () => ({
  assertComputerUseAllowed: vi.fn(async () => ({ ok: true })),
}));

vi.mock('../../services/cua/cua-service.js', () => ({
  CuaService: class {
    constructor(deps: Record<string, unknown>) {
      mocks.ctorDeps.push(deps);
      return mocks.fakeService;
    }
  },
}));

vi.mock('../../services/cua/window-restore.js', () => ({
  restoreWindowWithoutFocus: vi.fn(async () => true),
}));

import { __resetCuaService, dispatchCuaTool } from '../cua-handlers.js';

describe('dispatchCuaTool — top-level app_ref → nested appRef translation', () => {
  beforeEach(() => {
    __resetCuaService();
    vi.clearAllMocks();
    mocks.calls.leftClick.length = 0;
    mocks.calls.leftClickDrag.length = 0;
    mocks.calls.setValue.length = 0;
    mocks.calls.selectText.length = 0;
    mocks.calls.performAction.length = 0;
    mocks.calls.getAppState.length = 0;
  });

  it('left_click: top-level pid reaches the service as appRef.pid', async () => {
    const out = await dispatchCuaTool({
      tool: 'left_click',
      args: { target: { type: 'element', index: 9 }, pid: 48412 },
      sessionId: 's1',
    });
    expect(out.success).toBe(true);
    expect(mocks.calls.leftClick).toHaveLength(1);
    expect(mocks.calls.leftClick[0]).toMatchObject({
      target: { type: 'element', index: 9 },
      appRef: { pid: 48412 },
    });
  });

  it('set_value: top-level name reaches the service as appRef.name', async () => {
    await dispatchCuaTool({
      tool: 'set_value',
      args: { target: { type: 'element', index: 3 }, name: 'QQ', value: 'hi' },
    });
    expect(mocks.calls.setValue[0]).toMatchObject({
      value: 'hi',
      appRef: { name: 'QQ' },
    });
  });

  it('perform_action: top-level windowId reaches the service as appRef.windowId', async () => {
    await dispatchCuaTool({
      tool: 'perform_action',
      args: { target: { type: 'element', index: 0 }, windowId: 62459564, action: 'AXPress' },
    });
    expect(mocks.calls.performAction[0]).toMatchObject({
      action: 'AXPress',
      appRef: { windowId: 62459564 },
    });
  });

  it('left_click_drag: top-level refs reach the service', async () => {
    await dispatchCuaTool({
      tool: 'left_click_drag',
      args: {
        from: { type: 'element', index: 1 },
        to: { type: 'coordinate', x: 10, y: 10 },
        name: 'B',
      },
    });
    expect(mocks.calls.leftClickDrag[0]).toMatchObject({ appRef: { name: 'B' } });
  });

  it('select_text: top-level pid reaches the service', async () => {
    await dispatchCuaTool({
      tool: 'select_text',
      args: { target: { type: 'element', index: 2 }, pid: 7, text: 'needle' },
    });
    expect(mocks.calls.selectText[0]).toMatchObject({ appRef: { pid: 7 } });
  });

  it('no ref fields → appRef undefined (the service falls back to the single observed window)', async () => {
    await dispatchCuaTool({
      tool: 'left_click',
      args: { target: { type: 'element', index: 0 } },
    });
    const passed = mocks.calls.leftClick[0] as { appRef?: unknown };
    expect(passed.appRef).toBeUndefined();
  });

  it('junk ref values (pid=0, blank name) do not fabricate an appRef', async () => {
    await dispatchCuaTool({
      tool: 'left_click',
      args: { target: { type: 'element', index: 0 }, pid: 0, name: '   ', windowId: -3 },
    });
    const passed = mocks.calls.leftClick[0] as { appRef?: unknown };
    expect(passed.appRef).toBeUndefined();
  });

  it('get_app_state keeps its explicit top-level field mapping', async () => {
    await dispatchCuaTool({
      tool: 'get_app_state',
      args: { pid: 5, includeScreenshot: true, fresh: true, maxElements: 100 },
    });
    expect(mocks.calls.getAppState[0]).toEqual({
      pid: 5,
      includeScreenshot: true,
      fresh: true,
      maxElements: 100,
    });
  });
});
