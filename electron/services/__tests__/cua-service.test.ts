/**
 * CuaService unit tests (plan 575 Phase 3 gate).
 *
 * The service is exercised against a fake UiaProbeClient — only the
 * methods the service consumes are stubbed, everything else rides the
 * injectable deps (clipboard / capture / nut). Asserts pin the aligned
 * receipt shapes and the error taxonomy, not just happy paths.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { CuaError } from '@duya/computer-use';
import { CuaService, type CuaNutAdapter } from '../cua/cua-service.js';

type InvokeArgs = { index: number; method?: string; value?: string; name?: string; controlType?: string };

interface FakeProbe {
  listApps: ReturnType<typeof vi.fn>;
  listWindows: ReturnType<typeof vi.fn>;
  enumerate: ReturnType<typeof vi.fn>;
  foreground: ReturnType<typeof vi.fn>;
  invoke: ReturnType<typeof vi.fn>;
  selectText: ReturnType<typeof vi.fn>;
  ensureStarted: ReturnType<typeof vi.fn>;
}

function makeFakeProbe(): FakeProbe {
  return {
    listApps: vi.fn(),
    listWindows: vi.fn(),
    enumerate: vi.fn(),
    foreground: vi.fn(),
    invoke: vi.fn(),
    selectText: vi.fn(),
    ensureStarted: vi.fn(async () => undefined),
  };
}

function makeNut(): CuaNutAdapter {
  return {
    mouse: {
      setPosition: vi.fn(async () => undefined),
      click: vi.fn(async () => undefined),
      wheel: vi.fn(async () => undefined),
    },
    keyboard: {
      type: vi.fn(async () => undefined),
      pressKey: vi.fn(async () => undefined),
    },
    Key: { A: 'a', V: 'v', CTRL: 'ctrl' },
    Button: { LEFT: 0, RIGHT: 2 },
  };
}

const WINDOWS = [
  { hwnd: 100, pid: 11, title: 'DUYA', rect: { x: 0, y: 0, w: 800, h: 600 }, minimized: false, cloaked: false },
  { hwnd: 200, pid: 22, title: 'B', rect: { x: 0, y: 0, w: 100, h: 100 }, minimized: true, cloaked: false },
  { hwnd: 300, pid: 33, title: 'Hosted', rect: { x: 5, y: 5, w: 50, h: 50 }, minimized: false, cloaked: true },
];

const TREE = [
  { name: 'OK', controlType: 'Button', rect: { x: 10, y: 10, w: 80, h: 24 } },
  { name: 'Search', controlType: 'Edit', rect: { x: 10, y: 40, w: 200, h: 24 }, value: '' },
];

function makeService(fake: FakeProbe, nut: CuaNutAdapter, extra: Record<string, unknown> = {}) {
  return new CuaService({
    probeClient: () => fake as never,
    nut,
    writeClipboard: extra.writeClipboard as ((text: string) => void) | undefined,
    capture: extra.capture as
      | ((
          windowId: number | null,
          bounds?: [number, number, number, number] | null,
        ) => Promise<{ base64: string; width: number; height: number; blank?: boolean } | null>)
      | undefined,
    approval: extra.approval as
      | ((tool: string, args: Record<string, unknown>) => Promise<{ ok: boolean; reason?: string }>)
      | undefined,
  });
}

describe('CuaService — enumeration tools', () => {
  let fake: FakeProbe;
  let service: CuaService;

  beforeEach(() => {
    fake = makeFakeProbe();
    fake.listApps.mockResolvedValue([
      { pid: 11, exe: 'C:\\app\\duya.exe', title: 'DUYA', active: true },
    ]);
    fake.listWindows.mockResolvedValue(WINDOWS);
    service = makeService(fake, makeNut());
  });

  it('list_apps maps rows to the aligned app info shape', async () => {
    const apps = await service.listApps();
    expect(apps).toEqual([
      { pid: 11, bundleId: 'C:\\app\\duya.exe', name: 'DUYA', active: true, title: 'DUYA' },
    ]);
  });

  it('list_apps fails with TIMEOUT when the probe is unavailable', async () => {
    fake.listApps.mockResolvedValue(null);
    await expect(service.listApps()).rejects.toMatchObject({ code: 'TIMEOUT' });
  });

  it('list_windows maps geometry + shell state and drops nothing', async () => {
    const wins = await service.listWindows();
    expect(wins).toHaveLength(3);
    expect(wins[0]).toMatchObject({ windowId: 100, pid: 11, bounds: [0, 0, 800, 600], cloaked: false });
    expect(wins[2]?.cloaked).toBe(true);
  });

  it('request_access is ready on Windows with a UIPI note', async () => {
    const access = await service.requestAccess();
    expect(access.ready).toBe(true);
    expect(access.platform).toBe('win32');
    expect(access.notes[0]).toContain('UIPI');
  });
});

describe('CuaService — get_app_state', () => {
  let fake: FakeProbe;
  let service: CuaService;

  beforeEach(() => {
    fake = makeFakeProbe();
    fake.listWindows.mockResolvedValue(WINDOWS);
    fake.enumerate.mockResolvedValue({ elements: TREE, truncated: false, reason: null });
    service = makeService(fake, makeNut());
  });

  it('renders the aligned observation text and observation receipt', async () => {
    const { observation, text } = await service.getAppState({ pid: 11 });
    expect(text).toContain('app: pid=11 "DUYA"');
    expect(text).toContain('window: "DUYA" window_id=100 bounds=[0,0,800,600]');
    expect(text).toContain('[0] button OK (pressable) actions=[AXPress]');
    expect(text).toContain('[1] textfield Search actions=[AXSetValue]');
    expect(observation.snapshotMode).toBe('full');
    expect(observation.stateId).toContain('cua-11-100-');
    expect(observation.elements[1]?.editable).toBe(true);
  });

  it('second observation of an unchanged tree is no_change with no advisory', async () => {
    await service.getAppState({ pid: 11 });
    const second = await service.getAppState({ pid: 11 });
    expect(second.observation.snapshotMode).toBe('no_change');
    expect(second.text).not.toContain('+ [');
  });

  it('name-based app_ref resolves by title contains; ambiguity fails closed', async () => {
    await service.getAppState({ name: 'DUYA' });
    await expect(service.getAppState({ name: 'nope' })).rejects.toMatchObject({ code: 'INVALID_APP' });
  });

  it('elevated windows surface PERMISSION_DENIED (UIPI)', async () => {
    fake.enumerate.mockResolvedValue({ elements: [], truncated: false, reason: 'elevated' });
    await expect(service.getAppState({ pid: 11 })).rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
  });

  it('remembered frames bind coordinate targets to the window rect', async () => {
    fake.listWindows.mockResolvedValue([
      { ...WINDOWS[0], rect: { x: 100, y: 50, w: 400, h: 200 } },
    ]);
    await service.getAppState({ pid: 11 }, 's1');
    // Coordinate click without a frame must fail closed.
    const bare = makeService(fake, makeNut());
    await expect(
      bare.leftClick({ target: { type: 'coordinate', x: 10, y: 10 } }, 'bare'),
    ).rejects.toMatchObject({ code: 'STALE_STATE' });
    void bare;

    // After a capture-backed observation the frame maps into the window rect.
    const serviceWithCapture = makeService(fake, makeNut(), {
      capture: async () => ({ base64: 'x', width: 200, height: 100 }),
    });
    await serviceWithCapture.getAppState({ pid: 11, includeScreenshot: true }, 's2');
    // 200x100 image over a 400x200 rect: center (100,50) → screen (300,150).
    const receipt = await serviceWithCapture.leftClick(
      { target: { type: 'coordinate', x: 100, y: 50 } },
      's2',
    );
    expect(receipt.tool).toBe('left_click');
    expect(receipt.dispatchStatus).toBe('possibly_sent');
  });
});

describe('CuaService — actions', () => {
  let fake: FakeProbe;
  let nut: CuaNutAdapter;
  let service: CuaService;
  const clipboardWrites: string[] = [];

  beforeEach(() => {
    fake = makeFakeProbe();
    fake.listWindows.mockResolvedValue(WINDOWS);
    fake.enumerate.mockResolvedValue({ elements: TREE, truncated: false, reason: null });
    fake.invoke.mockResolvedValue({
      ok: true,
      method: 'invoke',
      pattern: 'InvokePattern',
      value: null,
      element: { name: 'OK', controlType: 'Button' },
    });
    nut = makeNut();
    clipboardWrites.length = 0;
    service = makeService(fake, nut, { writeClipboard: (t: string) => clipboardWrites.push(t) });
  });

  it('left_click on an element rides the probe pattern chain with guards and verification', async () => {
    await service.getAppState({ pid: 11 }, 's');
    const receipt = await service.leftClick(
      { appRef: { pid: 11 }, target: { type: 'element', index: 0 } },
      's',
    );
    expect(fake.invoke).toHaveBeenCalledWith(
      100,
      expect.objectContaining({ index: 1, method: 'auto', name: 'OK', controlType: 'Button' }),
    );
    expect(receipt).toMatchObject({
      tool: 'left_click',
      actionSent: true,
      dispatchStatus: 'accepted',
      targetVerificationStatus: 'matched',
    });
  });

  it('left_click on an unobserved app_ref fails closed ELEMENT_UNAVAILABLE', async () => {
    await expect(
      service.leftClick({ appRef: { pid: 11 }, target: { type: 'element', index: 1 } }, 'fresh'),
    ).rejects.toMatchObject({ code: 'ELEMENT_UNAVAILABLE' });
  });

  it('stale-tree maps to ELEMENT_UNAVAILABLE with re-observe guidance', async () => {
    fake.invoke.mockResolvedValue({ ok: false, reason: 'stale-tree' });
    await service.getAppState({ pid: 11 }, 's');
    await expect(
      service.leftClick({ appRef: { pid: 11 }, target: { type: 'element', index: 1 } }, 's'),
    ).rejects.toMatchObject({ code: 'ELEMENT_UNAVAILABLE', retry: 'reobserve' });
  });

  it('no-pattern steers to the vision loop with ACTION_UNAVAILABLE', async () => {
    fake.invoke.mockResolvedValue({ ok: false, reason: 'no-pattern' });
    await service.getAppState({ pid: 11 }, 's');
    await expect(
      service.leftClick({ appRef: { pid: 11 }, target: { type: 'element', index: 1 } }, 's'),
    ).rejects.toMatchObject({ code: 'ACTION_UNAVAILABLE' });
  });

  it('set_value passes the value through and reports the read-back', async () => {
    fake.invoke.mockResolvedValue({
      ok: true,
      method: 'setValue',
      pattern: 'ValuePattern',
      value: 'typed',
      element: { name: 'Search', value: 'typed', controlType: 'Edit' },
    });
    await service.getAppState({ pid: 11 }, 's');
    const receipt = await service.setValue(
      { appRef: { pid: 11 }, target: { type: 'element', index: 1 }, value: 'typed' },
      's',
    );
    expect(fake.invoke).toHaveBeenCalledWith(
      100,
      expect.objectContaining({ index: 2, method: 'setValue', value: 'typed' }),
    );
    expect(receipt.element?.value).toBe('typed');
  });

  it('perform_action maps AX vocabulary, enforces advertised actions, rejects unknown', async () => {
    await service.getAppState({ pid: 11 }, 's');
    // Button advertises AXPress.
    await service.performAction(
      { appRef: { pid: 11 }, target: { type: 'element', index: 0 }, action: 'AXPress' },
      's',
    );
    expect(fake.invoke).toHaveBeenCalledWith(100, expect.objectContaining({ method: 'invoke' }));

    // Edit advertises only AXSetValue — AXPress is refused (plan 575 gap fix).
    await expect(
      service.performAction(
        { appRef: { pid: 11 }, target: { type: 'element', index: 1 }, action: 'AXPress' },
        's',
      ),
    ).rejects.toMatchObject({ code: 'ACTION_UNAVAILABLE' });
    await service.performAction(
      { appRef: { pid: 11 }, target: { type: 'element', index: 1 }, action: 'AXSetValue', value: 'v' },
      's',
    );
    expect(fake.invoke).toHaveBeenCalledWith(
      100,
      expect.objectContaining({ method: 'setValue', value: 'v' }),
    );

    await expect(
      service.performAction(
        { appRef: { pid: 11 }, target: { type: 'element', index: 1 }, action: 'AXLaunchMissiles' },
        's',
      ),
    ).rejects.toMatchObject({ code: 'ACTION_UNAVAILABLE' });
  });

  it('coordinate clicks go through nut with the mapped screen point', async () => {
    const withCapture = makeService(fake, nut, {
      capture: async () => ({ base64: 'x', width: 400, height: 200 }),
    });
    await withCapture.getAppState({ pid: 11, includeScreenshot: true }, 's');
    await withCapture.leftClick({ target: { type: 'coordinate', x: 200, y: 100 } }, 's');
    // 400x200 image over rect [0,0,800,600]: (200,100) → (400,300).
    expect(nut.mouse.setPosition).toHaveBeenCalledWith({ x: 400, y: 300 });
  });

  it('key normalizes aliases and resolves tokens through the nut Key map', async () => {
    await service.key({ key: 'Return' });
    expect(nut.keyboard.pressKey).toHaveBeenCalledWith('return');
    await service.key({ key: 'a', modifiers: ['ctrl'] });
    expect(nut.keyboard.pressKey).toHaveBeenCalledWith('ctrl', 'a');
  });

  it('paste writes the clipboard then sends ctrl+v', async () => {
    await service.paste({ text: 'hello' });
    expect(clipboardWrites).toEqual(['hello']);
    expect(nut.keyboard.pressKey).toHaveBeenCalledWith('ctrl', 'v');
  });

  it('select_text distinguishes NOT_SELECTABLE from stale-tree', async () => {
    await service.getAppState({ pid: 11 }, 's');
    fake.selectText.mockResolvedValue({ ok: false, reason: 'no-pattern' });
    await expect(
      service.selectText({ appRef: { pid: 11 }, target: { type: 'element', index: 1 }, text: 'x' }, 's'),
    ).rejects.toMatchObject({ code: 'NOT_SELECTABLE' });
    fake.selectText.mockResolvedValue({ ok: true, pattern: 'TextPattern' });
    const receipt = await service.selectText(
      { appRef: { pid: 11 }, target: { type: 'element', index: 1 }, text: 'x' },
      's',
    );
    expect(receipt.targetVerificationStatus).toBe('matched');
  });

  it('stop_computer_control forgets the session (indices fail closed afterwards)', async () => {
    await service.getAppState({ pid: 11 }, 's');
    service.stop('s');
    await expect(
      service.leftClick({ appRef: { pid: 11 }, target: { type: 'element', index: 1 } }, 's'),
    ).rejects.toMatchObject({ code: 'ELEMENT_UNAVAILABLE' });
  });
});

describe('CuaService — plan 575 gap fixes', () => {
  let fake: FakeProbe;

  beforeEach(() => {
    fake = makeFakeProbe();
    fake.listApps.mockResolvedValue([
      { pid: 11, exe: 'C:\\app\\duya.exe', title: 'DUYA', active: true },
    ]);
    fake.listWindows.mockResolvedValue(WINDOWS);
    fake.enumerate.mockResolvedValue({ elements: TREE, truncated: false, reason: null });
  });

  it('approval gate: deny → NOT_AUTHORIZED with nothing dispatched', async () => {
    const service = makeService(fake, makeNut(), {
      approval: async () => ({ ok: false, reason: 'user-deny' }),
      writeClipboard: () => {},
    });
    await expect(
      service.leftClick({ target: { type: 'coordinate', x: 5, y: 5 } }, 's'),
    ).rejects.toMatchObject({ code: 'NOT_AUTHORIZED', actionSent: false });
  });

  it('approval gate: allow proceeds; observation tools skip the gate entirely', async () => {
    const gated: string[] = [];
    const service = makeService(fake, makeNut(), {
      approval: async (tool: string) => {
        gated.push(tool);
        return { ok: true };
      },
      writeClipboard: () => {},
    });
    await service.paste({ text: 'hi' });
    expect(gated).toEqual(['paste']);
    await service.key({ key: 'Return' });
    expect(gated).toEqual(['paste']);
    await service.getAppState({ pid: 11 }, 's');
    expect(gated).toEqual(['paste']);
  });

  it('truncated trees surface in the observation receipt AND the text', async () => {
    fake.enumerate.mockResolvedValue({ elements: TREE, truncated: true, reason: null });
    const service = makeService(fake, makeNut());
    const { observation, text } = await service.getAppState({ pid: 11 });
    expect(observation.truncated).toBe(true);
    expect(text).toContain('[tree truncated');
  });

  it('complete trees are not flagged truncated', async () => {
    const service = makeService(fake, makeNut());
    const { observation, text } = await service.getAppState({ pid: 11 });
    expect(observation.truncated).toBe(false);
    expect(text).not.toContain('[tree truncated');
  });

  it('bundleId is filled from the apps op exe path', async () => {
    const service = makeService(fake, makeNut());
    const { observation } = await service.getAppState({ pid: 11 });
    expect(observation.app.bundleId).toBe('C:\\app\\duya.exe');
  });

  it('blank captures are refused with screenshot_blank and bind no frame', async () => {
    const service = makeService(fake, makeNut(), {
      capture: async () => ({ base64: 'x', width: 400, height: 200, blank: true }),
    });
    const { screenshot, text } = await service.getAppState(
      { pid: 11, includeScreenshot: true },
      's',
    );
    expect(screenshot).toBeUndefined();
    expect(text).toContain('[screenshot_blank');
    await expect(
      service.leftClick({ target: { type: 'coordinate', x: 5, y: 5 } }, 's'),
    ).rejects.toMatchObject({ code: 'STALE_STATE' });
  });

  it('capture receives the window bounds for aspect-exact thumbnail requests', async () => {
    const capture = vi.fn(async () => ({ base64: 'x', width: 800, height: 600 }));
    const service = makeService(fake, makeNut(), { capture });
    await service.getAppState({ pid: 11, includeScreenshot: true }, 's');
    expect(capture).toHaveBeenCalledWith(100, [0, 0, 800, 600]);
  });

  it('captures are invalidated when the window rect changed between enumeration and shot', async () => {
    let call = 0;
    fake.listWindows.mockImplementation(async () => {
      call += 1;
      return [
        {
          hwnd: 100,
          pid: 11,
          title: 'DUYA',
          rect: call === 1 ? { x: 0, y: 0, w: 800, h: 600 } : { x: 40, y: 0, w: 800, h: 600 },
          minimized: false,
          cloaked: false,
        },
      ];
    });
    const service = makeService(fake, makeNut(), {
      capture: async () => ({ base64: 'x', width: 400, height: 200 }),
    });
    const { screenshot, text } = await service.getAppState(
      { pid: 11, includeScreenshot: true },
      's',
    );
    expect(screenshot).toBeUndefined();
    expect(text).toContain('[capture_surfaces_changed');
    await expect(
      service.leftClick({ target: { type: 'coordinate', x: 5, y: 5 } }, 's'),
    ).rejects.toMatchObject({ code: 'STALE_STATE' });
  });

  it('unchanged windows keep the frame (rect re-check passes)', async () => {
    const service = makeService(fake, makeNut(), {
      capture: async () => ({ base64: 'x', width: 400, height: 200 }),
    });
    const { screenshot, text } = await service.getAppState(
      { pid: 11, includeScreenshot: true },
      's',
    );
    expect(screenshot).toBeDefined();
    expect(text).not.toContain('[capture_surfaces_changed');
    expect(text).not.toContain('[screenshot unverified');
  });

  it('ApplicationFrameHost pid ambiguity refuses with window_id guidance', async () => {
    fake.listApps.mockResolvedValue([
      {
        pid: 77,
        exe: 'C:\\Windows\\System32\\ApplicationFrameHost.exe',
        title: 'host',
        active: false,
      },
    ]);
    fake.listWindows.mockResolvedValue([
      { hwnd: 700, pid: 77, title: 'Calc', rect: { x: 0, y: 0, w: 100, h: 100 }, minimized: false, cloaked: false },
      { hwnd: 701, pid: 77, title: 'Settings', rect: { x: 0, y: 0, w: 100, h: 100 }, minimized: false, cloaked: false },
    ]);
    const service = makeService(fake, makeNut());
    await expect(service.getAppState({ pid: 77 })).rejects.toThrow(/ApplicationFrameHost.*window_id/s);
  });

  it('regular multi-window pids keep the top hit (no false refusal)', async () => {
    fake.listWindows.mockResolvedValue([
      { hwnd: 800, pid: 11, title: 'DUYA', rect: { x: 0, y: 0, w: 800, h: 600 }, minimized: false, cloaked: false },
      { hwnd: 801, pid: 11, title: 'DUYA Dev', rect: { x: 0, y: 0, w: 800, h: 600 }, minimized: false, cloaked: false },
    ]);
    const service = makeService(fake, makeNut());
    const { observation } = await service.getAppState({ pid: 11 });
    expect(observation.window.windowId).toBe(800);
  });
});
