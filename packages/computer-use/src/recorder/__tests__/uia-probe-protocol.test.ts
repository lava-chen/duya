import { describe, expect, it } from 'vitest';

import {
  DEFAULT_INTERACTIVE_CONTROL_TYPES,
  buildRequestLine,
  elementToDescriptor,
  enumeratedElementToDescriptor,
  isBrowserProcess,
  isInteractiveOverlayElement,
  parseUiaProbeLine,
} from '../uia-probe-protocol';

describe('uia-probe-protocol — buildRequestLine', () => {
  it('builds probe/readUrl/ping request lines', () => {
    expect(buildRequestLine({ id: 1, op: 'probe', x: 123, y: 456 })).toBe(
      '{"id":1,"op":"probe","x":123,"y":456}',
    );
    expect(buildRequestLine({ id: 2, op: 'readUrl', hwnd: 197144 })).toBe(
      '{"id":2,"op":"readUrl","hwnd":197144}',
    );
    expect(buildRequestLine({ id: 3, op: 'ping' })).toBe('{"id":3,"op":"ping"}');
  });

  it('builds the enumerate request with optional knobs omitted', () => {
    expect(buildRequestLine({ id: 4, op: 'enumerate', hwnd: 197144 })).toBe(
      '{"id":4,"op":"enumerate","hwnd":197144}',
    );
    expect(
      buildRequestLine({
        id: 5,
        op: 'enumerate',
        hwnd: 7,
        maxDepth: 20,
        maxNodes: 100,
        controlTypes: ['Button', 'Edit'],
      }),
    ).toBe(
      '{"id":5,"op":"enumerate","hwnd":7,"maxDepth":20,"maxNodes":100,"controlTypes":["Button","Edit"]}',
    );
  });
});

describe('uia-probe-protocol — parseUiaProbeLine', () => {
  it('parses the ready line', () => {
    expect(parseUiaProbeLine('{"ready":true}')).toEqual({ kind: 'ready' });
  });

  it('parses a success response with a full element', () => {
    const line = JSON.stringify({
      id: 1,
      ok: true,
      element: {
        name: '确定',
        controlType: 'Button',
        automationId: 'btnOk',
        className: 'Button',
        rect: { x: 100, y: 200, w: 80, h: 28 },
        isPassword: false,
      },
    });
    const parsed = parseUiaProbeLine(line);
    expect(parsed).toMatchObject({ kind: 'response', id: 1, ok: true });
    if (parsed && parsed.kind === 'response' && parsed.ok) {
      expect(parsed.element).toMatchObject({ name: '确定', controlType: 'Button' });
      expect(parsed.url).toBeNull();
    }
  });

  it('parses ok:true element:null (nothing under the point)', () => {
    const parsed = parseUiaProbeLine('{"id":1,"ok":true,"element":null}');
    expect(parsed).toMatchObject({ kind: 'response', ok: true, element: null });
  });

  it('parses url responses and failures', () => {
    expect(parseUiaProbeLine('{"id":2,"ok":true,"url":"https://example.com"}')).toMatchObject({
      kind: 'response',
      id: 2,
      ok: true,
      url: 'https://example.com',
    });
    expect(parseUiaProbeLine('{"id":1,"ok":false,"reason":"timeout"}')).toEqual({
      kind: 'response',
      id: 1,
      ok: false,
      reason: 'timeout',
    });
    // reason omitted → generic error string
    expect(parseUiaProbeLine('{"id":9,"ok":false}')).toMatchObject({ kind: 'response', ok: false });
  });

  it('parses the enumerate success response with elements', () => {
    const parsed = parseUiaProbeLine(
      JSON.stringify({
        id: 4,
        ok: true,
        elements: [
          { name: '确定', controlType: 'Button', rect: { x: 1, y: 2, w: 30, h: 20 }, isPassword: false, interactive: true },
          { name: '搜索', controlType: 'Edit', rect: { x: 4, y: 5, w: 200, h: 24 }, isPassword: false, interactive: true },
        ],
        truncated: false,
      }),
    );
    expect(parsed).toMatchObject({ kind: 'response', id: 4, ok: true, truncated: false, reason: null });
    if (parsed && parsed.kind === 'response' && parsed.ok) {
      expect(parsed.elements).toHaveLength(2);
      expect(parsed.elements![0]).toMatchObject({ name: '确定', source: 'uia-probe', interactive: true });
    }
  });

  it('parses the enumerate truncated + elevated-reason shapes', () => {
    const truncated = parseUiaProbeLine(
      JSON.stringify({ id: 4, ok: true, elements: [], truncated: true }),
    );
    expect(truncated).toMatchObject({ kind: 'response', ok: true, truncated: true });

    const elevated = parseUiaProbeLine(
      JSON.stringify({ id: 5, ok: true, elements: [], reason: 'elevated' }),
    );
    expect(elevated).toMatchObject({ kind: 'response', ok: true, reason: 'elevated' });
  });

  it('returns null for garbage', () => {
    expect(parseUiaProbeLine('')).toBeNull();
    expect(parseUiaProbeLine('not json')).toBeNull();
    expect(parseUiaProbeLine('{"unknown":1}')).toBeNull();
    expect(parseUiaProbeLine('{"id":-3,"ok":true}')).toBeNull();
  });
});

describe('uia-probe-protocol — elementToDescriptor', () => {
  it('maps null/undefined to source none', () => {
    expect(elementToDescriptor(null)).toEqual({ source: 'none' });
    expect(elementToDescriptor(undefined)).toEqual({ source: 'none' });
    // Unknown keys are stripped; the rest is an (empty) valid descriptor.
    expect(elementToDescriptor({ bogus: true })).toEqual({ source: 'uia-probe' });
  });

  it('maps a full element payload and stamps the uia-probe source', () => {
    const descriptor = elementToDescriptor({
      name: '密码',
      controlType: 'Edit',
      automationId: 'pw',
      className: 'Edit',
      rect: { x: 10, y: 20, w: 200, h: 24 },
      isPassword: true,
    });
    expect(descriptor).toEqual({
      name: '密码',
      controlType: 'Edit',
      automationId: 'pw',
      className: 'Edit',
      rect: { x: 10, y: 20, w: 200, h: 24 },
      isPassword: true,
      source: 'uia-probe',
    });
  });
});

describe('uia-probe-protocol — isBrowserProcess', () => {
  it('matches the supported browsers case-insensitively', () => {
    expect(isBrowserProcess('chrome')).toBe(true);
    expect(isBrowserProcess('msedge')).toBe(true);
    expect(isBrowserProcess('Firefox')).toBe(true);
    expect(isBrowserProcess('notepad')).toBe(false);
    expect(isBrowserProcess('chrome_installer')).toBe(false);
  });
});

describe('uia-probe-protocol — enumerate element mapping', () => {
  const element = {
    name: '确定',
    controlType: 'Button',
    automationId: 'btnOk',
    className: 'Button',
    rect: { x: 10, y: 20, w: 80, h: 28 },
    isPassword: false,
    interactive: true,
  };

  it('maps an enumerate element and keeps interactive', () => {
    expect(enumeratedElementToDescriptor(element)).toEqual({
      name: '确定',
      controlType: 'Button',
      automationId: 'btnOk',
      className: 'Button',
      rect: { x: 10, y: 20, w: 80, h: 28 },
      isPassword: false,
      interactive: true,
      source: 'uia-probe',
    });
  });

  it('returns null for schema mismatches instead of source:none', () => {
    // rect.w must be nonnegative — a broken entry is dropped, not zeroed.
    expect(
      enumeratedElementToDescriptor({ ...element, rect: { x: 0, y: 0, w: -5, h: 10 } }),
    ).toBeNull();
    expect(enumeratedElementToDescriptor(null)).toBeNull();
  });

  it('DEFAULT_INTERACTIVE_CONTROL_TYPES covers the plan 562 whitelist', () => {
    expect(DEFAULT_INTERACTIVE_CONTROL_TYPES).toEqual([
      'Button',
      'Edit',
      'Hyperlink',
      'CheckBox',
      'RadioButton',
      'ComboBox',
      'TabItem',
      'MenuItem',
      'Slider',
      'ListItem',
      'ToggleSwitch',
    ]);
  });
});

describe('uia-probe-protocol — isInteractiveOverlayElement', () => {
  const rect = { x: 1, y: 2, w: 30, h: 20 };

  it('accepts whitelisted control types with a usable rect', () => {
    expect(
      isInteractiveOverlayElement({ controlType: 'Button', rect, source: 'uia-probe' }),
    ).toBe(true);
    expect(
      isInteractiveOverlayElement({ controlType: 'tabitem', rect, source: 'uia-probe', interactive: true }),
    ).toBe(true);
  });

  it('rejects non-whitelisted types, missing rects, and explicit non-interactive flags', () => {
    expect(isInteractiveOverlayElement({ controlType: 'Pane', rect, source: 'uia-probe' })).toBe(false);
    expect(isInteractiveOverlayElement({ controlType: 'Button', source: 'uia-probe' })).toBe(false);
    expect(
      isInteractiveOverlayElement({ controlType: 'Button', rect: { x: 0, y: 0, w: 0, h: 0 }, source: 'uia-probe' }),
    ).toBe(false);
    expect(
      isInteractiveOverlayElement({ controlType: 'Button', rect, source: 'uia-probe', interactive: false }),
    ).toBe(false);
    expect(isInteractiveOverlayElement({ rect, source: 'uia-probe' })).toBe(false);
  });

  it('honors a custom whitelist override', () => {
    expect(
      isInteractiveOverlayElement(
        { controlType: 'Custom', rect, source: 'uia-probe' },
        ['Custom'],
      ),
    ).toBe(true);
  });
});

describe('uia-probe-protocol — fg op (plan 562 phase 5)', () => {
  it('builds the fg request line', () => {
    expect(buildRequestLine({ id: 9, op: 'fg' })).toBe('{"id":9,"op":"fg"}');
  });

  it('parses an fg success response with the snapshot payload', () => {
    const parsed = parseUiaProbeLine(
      '{"id":9,"ok":true,"fg":{"hwnd":197144,"pid":30200,"processName":"explorer","title":"Documents"}}',
    );
    expect(parsed).toMatchObject({
      kind: 'response',
      id: 9,
      ok: true,
      fg: { hwnd: 197144, pid: 30200, processName: 'explorer', title: 'Documents' },
    });
  });

  it('maps non-fg success to fg:null and keeps the no-window failure shape', () => {
    expect(parseUiaProbeLine('{"id":1,"ok":true}')).toMatchObject({ ok: true, fg: null });
    expect(parseUiaProbeLine('{"id":2,"ok":false,"reason":"no-window"}')).toMatchObject({
      kind: 'response',
      ok: false,
      reason: 'no-window',
    });
  });
});
