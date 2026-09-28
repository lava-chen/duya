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
  enumerateCached: ReturnType<typeof vi.fn>;
  foreground: ReturnType<typeof vi.fn>;
  invoke: ReturnType<typeof vi.fn>;
  selectText: ReturnType<typeof vi.fn>;
  ensureStarted: ReturnType<typeof vi.fn>;
}

function makeFakeProbe(): FakeProbe {
  const fake: FakeProbe = {
    listApps: vi.fn(),
    listWindows: vi.fn(),
    enumerate: vi.fn(),
    enumerateCached: vi.fn(),
    foreground: vi.fn(),
    invoke: vi.fn(),
    selectText: vi.fn(),
    ensureStarted: vi.fn(async () => undefined),
  };
  // Default: the cache op delegates to the enumerate mock so per-test
  // tree overrides keep working; call-count assertions override it.
  fake.enumerateCached.mockImplementation(async (hwnd: number) => fake.enumerate(hwnd));
  return fake;
}

function makeNut(): CuaNutAdapter {
  return {
    mouse: {
      setPosition: vi.fn(async () => undefined),
      click: vi.fn(async () => undefined),
      // Direction-split scroll API (matches @nut-tree-fork/nut-js Mouse —
      // there is no wheel(direction, amount) on the real library).
      scrollDown: vi.fn(async () => undefined),
      scrollUp: vi.fn(async () => undefined),
      scrollLeft: vi.fn(async () => undefined),
      scrollRight: vi.fn(async () => undefined),
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
    guard: extra.guard as
      | ((input: {
          action: string;
          targetApp?: { pid?: number | null; title?: string | null } | null;
          skipAppPolicy?: boolean;
        }) => Promise<{ ok: true } | { ok: false; kind: 'revoked' | 'app-blocked'; reason: string }>)
      | undefined,
    restoreWindow: extra.restoreWindow as ((windowId: number) => Promise<boolean>) | undefined,
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

  it('get_app_state rides the probe enumerate cache by default; fresh forces a re-scan', async () => {
    // Independent stub (not the delegating default): the cached path
    // must not touch enumerate at all.
    fake.enumerateCached.mockResolvedValue({ elements: TREE, truncated: false, reason: null });
    fake.enumerate.mockClear();
    await service.getAppState({ pid: 11 }, 'c');
    expect(fake.enumerateCached).toHaveBeenCalledWith(100, 'DUYA');
    expect(fake.enumerate).not.toHaveBeenCalled();

    await service.getAppState({ pid: 11, fresh: true }, 'c');
    expect(fake.enumerate).toHaveBeenCalledWith(100);
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

  it('bare targetless actions return INVALID_APP instead of a TypeError (real-machine smoke 2026-09-28)', async () => {
    // The zod schema marks target optional (one schema serves all 14
    // actions), so a bare left_click reaches the service — it must fail
    // with a structured envelope, never `undefined.type`.
    await expect(
      service.leftClick({ appRef: { pid: 11 } } as never, 's'),
    ).rejects.toMatchObject({ code: 'INVALID_APP' });
    await expect(
      service.leftClick({ appRef: { pid: 11 }, target: { type: 'element' } } as never, 's'),
    ).rejects.toMatchObject({ code: 'INVALID_APP' });
    await expect(
      service.setValue({ appRef: { pid: 11 }, value: 'v' } as never, 's'),
    ).rejects.toMatchObject({ code: 'INVALID_APP' });
    await expect(
      service.selectText({ appRef: { pid: 11 }, text: 'x' } as never, 's'),
    ).rejects.toMatchObject({ code: 'INVALID_APP' });
    await expect(
      service.performAction({ appRef: { pid: 11 }, action: 'AXPress' } as never, 's'),
    ).rejects.toMatchObject({ code: 'INVALID_APP' });
    await expect(
      service.leftClickDrag({ appRef: { pid: 11 }, to: { type: 'coordinate', x: 1, y: 1 } } as never, 's'),
    ).rejects.toMatchObject({ code: 'INVALID_APP' });
    expect(fake.invoke).not.toHaveBeenCalled();
  });

  it('scroll dispatches the direction-split nut API (no wheel on @nut-tree-fork/nut-js)', async () => {
    const receipt = await service.scroll({ direction: 'down', pages: 2 }, 's');
    expect(receipt).toMatchObject({ tool: 'scroll', actionSent: true });
    expect(nut.mouse.scrollDown).toHaveBeenCalledWith(20);
    expect(nut.mouse.scrollUp).not.toHaveBeenCalled();
    const receipt2 = await service.scroll({ direction: 'up' }, 's');
    expect(receipt2).toMatchObject({ tool: 'scroll', actionSent: true });
    expect(nut.mouse.scrollUp).toHaveBeenCalledWith(10);
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

describe('CuaService — shared execution guard (plan 575 follow-up)', () => {
  let fake: FakeProbe;

  beforeEach(() => {
    fake = makeFakeProbe();
    fake.listApps.mockResolvedValue([
      { pid: 11, exe: 'C:\\app\\duya.exe', title: 'DUYA', active: true },
    ]);
    fake.listWindows.mockResolvedValue(WINDOWS);
    fake.enumerate.mockResolvedValue({ elements: TREE, truncated: false, reason: null });
    fake.invoke.mockResolvedValue({
      ok: true,
      method: 'invoke',
      pattern: 'InvokePattern',
      value: null,
      element: { name: 'OK', controlType: 'Button' },
    });
    fake.selectText.mockResolvedValue({ ok: true, pattern: 'TextPattern' });
  });

  type GuardVerdict = { ok: true } | { ok: false; kind: 'revoked' | 'app-blocked'; reason: string };

  /**
   * Recording fake of `assertComputerUseAllowed`: mirrors the real gate
   * order (revoke first even for observations, then skipAppPolicy
   * short-circuit, then the app-policy verdict).
   */
  function recordingGuard(verdict: GuardVerdict) {
    const calls: Array<{ action: string; targetApp: unknown; skipAppPolicy?: boolean }> = [];
    const guard = async (input: {
      action: string;
      targetApp?: unknown;
      skipAppPolicy?: boolean;
    }): Promise<GuardVerdict> => {
      calls.push({ action: input.action, targetApp: input.targetApp ?? null, skipAppPolicy: input.skipAppPolicy });
      if (!verdict.ok && verdict.kind === 'revoked') return verdict;
      if (input.skipAppPolicy) return { ok: true };
      return verdict;
    };
    return { calls, guard };
  }

  it('observations are revocation-gated only and never consult the app policy', async () => {
    const { calls, guard } = recordingGuard({ ok: false, kind: 'app-blocked', reason: 'policy denies all apps' });
    const service = makeService(fake, makeNut(), { guard });
    await service.listApps();
    await service.listWindows();
    await service.getAppState({ pid: 11 }, 's');
    expect(calls.map((c) => c.action)).toEqual(['list_apps', 'list_windows', 'get_app_state']);
    expect(calls.every((c) => c.skipAppPolicy === true)).toBe(true);
    expect(calls.every((c) => c.targetApp === null)).toBe(true);
  });

  it('revoked → NOT_AUTHORIZED on every surface with nothing dispatched', async () => {
    const { guard } = recordingGuard({ ok: false, kind: 'revoked', reason: 'stopped' });
    const nut = makeNut();
    const service = makeService(fake, nut, { guard });
    await expect(service.getAppState({ pid: 11 }, 's')).rejects.toMatchObject({ code: 'NOT_AUTHORIZED' });
    await expect(service.scroll({ direction: 'down' }, 's')).rejects.toMatchObject({ code: 'NOT_AUTHORIZED' });
    await expect(service.typeText({ text: 'x' }, 's')).rejects.toMatchObject({ code: 'NOT_AUTHORIZED' });
    await expect(service.key({ key: 'a' }, 's')).rejects.toMatchObject({ code: 'NOT_AUTHORIZED' });
    expect(fake.enumerate).not.toHaveBeenCalled();
    expect(nut.mouse.scrollDown).not.toHaveBeenCalled();
    expect(nut.keyboard.type).not.toHaveBeenCalled();
    expect(nut.keyboard.pressKey).not.toHaveBeenCalled();
  });

  it('app-blocked → PERMISSION_DENIED on mutating tools; observations still pass', async () => {
    const { calls, guard } = recordingGuard({ ok: false, kind: 'app-blocked', reason: 'app not allowed' });
    const nut = makeNut();
    const clipboard: string[] = [];
    const service = makeService(fake, nut, { guard, writeClipboard: (t: string) => clipboard.push(t) });
    await service.getAppState({ pid: 11 }, 's');
    await expect(service.scroll({ direction: 'down' }, 's')).rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
    await expect(service.typeText({ text: 'x' }, 's')).rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
    await expect(service.key({ key: 'a' }, 's')).rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
    await expect(service.paste({ text: 'x' }, 's')).rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
    // Nothing was dispatched and the clipboard was never touched.
    expect(nut.mouse.scrollDown).not.toHaveBeenCalled();
    expect(nut.keyboard.type).not.toHaveBeenCalled();
    expect(nut.keyboard.pressKey).not.toHaveBeenCalled();
    expect(clipboard).toEqual([]);
    // Pixel-input tools ride foreground semantics (null target).
    const mutating = calls.filter((c) => !c.skipAppPolicy);
    expect(mutating.map((c) => c.action)).toEqual(['scroll', 'type', 'key', 'paste']);
    expect(mutating.every((c) => c.targetApp === null)).toBe(true);
  });

  it('element actions evaluate the owning process (target-aware policy)', async () => {
    const { calls, guard } = recordingGuard({ ok: true });
    const service = makeService(fake, makeNut(), { guard });
    await service.getAppState({ pid: 11 }, 's');
    await service.leftClick({ appRef: { pid: 11 }, target: { type: 'element', index: 0 } }, 's');
    await service.setValue({ appRef: { pid: 11 }, target: { type: 'element', index: 1 }, value: 'v' }, 's');
    await service.selectText({ appRef: { pid: 11 }, target: { type: 'element', index: 1 }, text: 'x' }, 's');
    const targeted = calls.filter(
      (c) => c.action === 'left_click' || c.action === 'set_value' || c.action === 'select_text',
    );
    expect(targeted).toHaveLength(3);
    for (const c of targeted) {
      expect(c.targetApp).toEqual({ pid: 11, title: 'DUYA' });
      expect(c.skipAppPolicy).toBeUndefined();
    }
  });

  it('left_click_drag is guard + approval gated on both paths', async () => {
    const { calls, guard } = recordingGuard({ ok: true });
    const approvals: string[] = [];
    const service = makeService(fake, makeNut(), {
      guard,
      approval: async (tool: string) => {
        approvals.push(tool);
        return { ok: true };
      },
      capture: async () => ({ base64: 'x', width: 400, height: 200 }),
    });
    await service.getAppState({ pid: 11, includeScreenshot: true }, 's');

    // Coordinate → coordinate: foreground semantics.
    await service.leftClickDrag(
      { from: { type: 'coordinate', x: 10, y: 10 }, to: { type: 'coordinate', x: 50, y: 50 } },
      's',
    );
    // Element end: the owning process is the policy target.
    await service.leftClickDrag(
      { appRef: { pid: 11 }, from: { type: 'element', index: 0 }, to: { type: 'coordinate', x: 50, y: 50 } },
      's',
    );
    const drags = calls.filter((c) => c.action === 'left_click_drag');
    expect(drags).toHaveLength(2);
    expect(drags[0]?.targetApp).toEqual({ pid: null, title: null });
    expect(drags[1]?.targetApp).toEqual({ pid: 11, title: 'DUYA' });
    expect(approvals).toEqual(['left_click_drag', 'left_click_drag']);
  });

  it('a denied drag moves no pixels', async () => {
    const { guard } = recordingGuard({ ok: true });
    const nut = makeNut();
    const service = makeService(fake, nut, {
      guard,
      approval: async () => ({ ok: false, reason: 'deny' }),
      capture: async () => ({ base64: 'x', width: 400, height: 200 }),
    });
    await service.getAppState({ pid: 11, includeScreenshot: true }, 's');
    await expect(
      service.leftClickDrag(
        { appRef: { pid: 11 }, from: { type: 'element', index: 0 }, to: { type: 'coordinate', x: 50, y: 50 } },
        's',
      ),
    ).rejects.toMatchObject({ code: 'NOT_AUTHORIZED', actionSent: false });
    expect(nut.mouse.setPosition).not.toHaveBeenCalled();
    expect(nut.mouse.click).not.toHaveBeenCalled();
  });
});

describe('CuaService — minimized windows (plan 578)', () => {
  let fake: FakeProbe;
  let service: CuaService;
  const captureCalls: Array<{ windowId: number | null; bounds: [number, number, number, number] | null }> = [];

  beforeEach(() => {
    vi.clearAllMocks();
    captureCalls.length = 0;
    fake = makeFakeProbe();
    // Fixture: hwnd 200 is minimized (title "B"), per the shared WINDOWS
    // table; the probe's windows op still reports minimized rows.
    fake.listWindows.mockResolvedValue(WINDOWS);
    fake.enumerate.mockResolvedValue({ elements: TREE, truncated: false, reason: null });
    fake.listApps.mockResolvedValue([{ pid: 22, exe: 'C:\\app\\b.exe', title: 'B', active: false }]);
    service = makeService(fake, makeNut(), {
      capture: async (windowId: number | null, bounds?: [number, number, number, number] | null) => {
        captureCalls.push({ windowId, bounds: bounds ?? null });
        return { base64: 'x', width: 300, height: 200 };
      },
    });
  });

  it('windowId targets a minimized window: tree reads fine with a minimized advisory', async () => {
    const { observation, text } = await service.getAppState({ windowId: 200 });
    expect(observation.window.windowId).toBe(200);
    expect(observation.window.minimized).toBe(true);
    expect(text).toContain('[window_minimized:');
  });

  it('name app_ref falls back to minimized windows when nothing visible matches', async () => {
    const { observation } = await service.getAppState({ name: 'B' });
    expect(observation.window.windowId).toBe(200);
  });

  it('pid app_ref falls back to minimized windows when nothing visible matches', async () => {
    const { observation } = await service.getAppState({ pid: 22 });
    expect(observation.window.windowId).toBe(200);
  });

  it('cloaked windowId is refused with the plan-578 guidance', async () => {
    await expect(service.getAppState({ windowId: 300 })).rejects.toMatchObject({
      code: 'INVALID_APP',
      message: expect.stringContaining('cloaked'),
    });
  });

  it('a truly gone windowId still fails STALE_STATE', async () => {
    await expect(service.getAppState({ windowId: 999 })).rejects.toMatchObject({ code: 'STALE_STATE' });
  });

  it('includeScreenshot on a minimized window restores first and captures the post-restore rect', async () => {
    const restoreCalls: number[] = [];
    const restored = WINDOWS.map((w) =>
      w.hwnd === 200 ? { ...w, minimized: false, rect: { x: 10, y: 20, w: 300, h: 200 } } : w,
    );
    fake.listWindows.mockResolvedValueOnce(WINDOWS).mockResolvedValue(restored);
    const withRestore = makeService(fake, makeNut(), {
      capture: async (windowId: number | null, bounds?: [number, number, number, number] | null) => {
        captureCalls.push({ windowId, bounds: bounds ?? null });
        return { base64: 'x', width: 300, height: 200 };
      },
      restoreWindow: async (windowId: number) => {
        restoreCalls.push(windowId);
        return true;
      },
    });

    const { observation, text, screenshot } = await withRestore.getAppState(
      { name: 'B', includeScreenshot: true },
      's',
    );

    expect(restoreCalls).toEqual([200]);
    // The capture rides the RE-QUERIED post-restore rect, never the
    // iconic position or the null bounds of the minimized resolution.
    expect(captureCalls).toEqual([{ windowId: 200, bounds: [10, 20, 300, 200] }]);
    expect(text).toContain('[window_restored:');
    expect(observation.window.minimized).toBe(false);
    expect(screenshot).toBeDefined();
  });

  it('a failed restore skips the capture and explains why', async () => {
    const withRestore = makeService(fake, makeNut(), {
      capture: async (windowId: number | null, bounds?: [number, number, number, number] | null) => {
        captureCalls.push({ windowId, bounds: bounds ?? null });
        return { base64: 'x', width: 300, height: 200 };
      },
      restoreWindow: async () => false,
    });
    const { observation, text, screenshot } = await withRestore.getAppState(
      { name: 'B', includeScreenshot: true },
      's',
    );
    expect(text).toContain('[restore_failed:');
    expect(captureCalls).toHaveLength(0);
    expect(screenshot).toBeUndefined();
    expect(observation.window.minimized).toBe(true);
  });

  it('no restore capability degrades to restore_unavailable (no blank capture)', async () => {
    const { text, screenshot } = await service.getAppState({ name: 'B', includeScreenshot: true }, 's');
    expect(text).toContain('[restore_unavailable:');
    expect(captureCalls).toHaveLength(0);
    expect(screenshot).toBeUndefined();
  });

  it('element action with NO app_ref falls back to the single observed window', async () => {
    fake.invoke.mockResolvedValue({ ok: true, element: { name: 'OK', controlType: 'Button' } });
    await service.getAppState({ pid: 11 }, 's');
    // Same session, no appRef on the action — ZCode bound-object parity.
    const receipt = await service.leftClick({ target: { type: 'element', index: 0 } }, 's');
    expect(receipt.dispatchStatus).toBe('accepted');
    expect(fake.invoke).toHaveBeenCalledWith(100, expect.objectContaining({ index: 1 }));
  });

  it('element action with NO app_ref and MULTIPLE observed windows stays fail-closed', async () => {
    fake.invoke.mockResolvedValue({ ok: true, element: {} });
    // Both observations in the SAME session → two candidate windows.
    await service.getAppState({ pid: 11 }, 's');
    await service.getAppState({ windowId: 200 }, 's');
    await expect(
      service.leftClick({ target: { type: 'element', index: 0 } }, 's'),
    ).rejects.toMatchObject({ code: 'ELEMENT_UNAVAILABLE' });
    expect(fake.invoke).not.toHaveBeenCalled();
  });

  it('an app_ref naming an unobserved window still fails closed (no silent wrong window)', async () => {
    fake.invoke.mockResolvedValue({ ok: true, element: {} });
    await service.getAppState({ pid: 11 }, 's');
    await expect(
      service.leftClick({ appRef: { pid: 999 }, target: { type: 'element', index: 0 } }, 's'),
    ).rejects.toMatchObject({ code: 'ELEMENT_UNAVAILABLE' });
    expect(fake.invoke).not.toHaveBeenCalled();
  });
});
