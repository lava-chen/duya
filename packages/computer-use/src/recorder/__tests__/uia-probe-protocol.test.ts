import { describe, expect, it } from 'vitest';

import {
  buildRequestLine,
  elementToDescriptor,
  isBrowserProcess,
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
