/**
 * payload.test.ts — parseOSContext pass-through of the plan 519 SOM
 * fields (uiaInputs / msaaInputs / windowList) plus non-regression on
 * existing envelope fields.
 */

import { describe, expect, it } from 'vitest';
import { parseOSContext } from './payload.js';
import type { OSContext } from './types.js';

/** Valid v0.4.0 payload carrying all three plan 519 fields. */
const fullPayload = {
  schemaVersion: '0.4.0',
  capturedAt: '2026-09-11T00:00:00Z',
  cursor: { physX: 0, physY: 0 },
  mouseTarget: null,
  focus: {
    foregroundHwnd: '0x1',
    foregroundPid: 1234,
    foregroundProcessName: 'notepad.exe',
    focusControlHwnd: '0x2',
    focusControlClassName: 'Edit',
    focusControlText: 'hello',
    focusControlIsPassword: false,
    caret: null,
  },
  windowList: [
    {
      hwnd: '0x100',
      title: 'Untitled - Notepad',
      className: 'Notepad',
      processId: 1234,
      processName: 'notepad.exe',
      isFocused: true,
      bounds: { x: 0, y: 0, w: 800, h: 600 },
    },
    {
      hwnd: '0x101',
      title: 'doc.txt',
      className: 'Notepad',
      processId: 1234,
      processName: 'notepad.exe',
      isFocused: false,
      bounds: { x: 100, y: 100, w: 400, h: 300 },
    },
  ],
  textInputs: [],
  uia: {
    ok: true,
    source: 'focused',
    hwnd: '0x2',
    focused: null,
    root: null,
    inputs: [
      {
        name: 'Edit field',
        controlType: 'Edit',
        className: 'Edit',
        isPassword: false,
        value: 'typed text',
        hasTextPattern: true,
      },
    ],
    elapsedMs: 10,
  },
  msaa: {
    ok: true,
    hwnd: '0x2',
    root: null,
    inputs: [{ name: 'OK', value: 'OK' }],
    elapsedMs: 5,
  },
  browserPage: null,
  redaction: { redacted: false, reason: null, maskedFields: [], method: null },
  platform: 'win32',
  assembleDurationMs: 3,
} as const;

function parse(raw: unknown) {
  return parseOSContext(JSON.stringify(raw));
}

function minimalPayload(extra: Record<string, unknown>): unknown {
  return {
    schemaVersion: '0.4.0',
    capturedAt: '2026-09-11T00:00:00Z',
    cursor: { physX: 0, physY: 0 },
    mouseTarget: null,
    focus: {
      foregroundPid: 1,
      foregroundProcessName: 'app.exe',
      focusControlClassName: 'Edit',
    },
    textInputs: [],
    redaction: { redacted: false, reason: null },
    platform: 'win32',
    assembleDurationMs: 1,
    ...extra,
  };
}

describe('parseOSContext — plan 519 SOM pass-through', () => {
  it('passes uiaInputs / msaaInputs / windowList on a full payload', () => {
    const outcome = parse(fullPayload);
    if (!outcome.ok) throw new Error(`expected ok, got ${outcome.reason}`);

    const ctx = outcome.context;
    expect(ctx.uiaInputs?.length).toBe(1);
    expect(ctx.uiaInputs?.[0].name).toBe('Edit field');
    expect(ctx.uiaInputs?.[0].value).toBe('typed text');
    expect(ctx.msaaInputs?.length).toBe(1);
    expect(ctx.msaaInputs?.[0].name).toBe('OK');
    expect(ctx.msaaInputs?.[0].value).toBe('OK');
    expect(ctx.windowList?.length).toBe(2);
    expect(ctx.windowList?.[0].title).toBe('Untitled - Notepad');
    expect(ctx.windowList?.[0].hwnd).toBe('0x100');
  });

  it('leaves the SOM fields undefined when the payload omits them', () => {
    const outcome = parse(minimalPayload({}));
    if (!outcome.ok) throw new Error(`expected ok, got ${outcome.reason}`);

    const ctx: OSContext = outcome.context;
    expect(ctx.uiaInputs).toBeUndefined();
    expect(ctx.msaaInputs).toBeUndefined();
    expect(ctx.windowList).toBeUndefined();
    // Existing envelope fields intact.
    expect(ctx.foreground.pid).toBe(1);
    expect(ctx.focusedEntity).toBeNull();
  });

  it('degrades gracefully when uia.inputs is malformed (not an array)', () => {
    const outcome = parse(
      minimalPayload({ uia: { ok: true, source: 'focused', inputs: 'oops' } }),
    );
    if (!outcome.ok) throw new Error(`expected ok, got ${outcome.reason}`);
    expect(outcome.context.uiaInputs).toBeUndefined();
    expect(() => parse(minimalPayload({ uia: { ok: true, inputs: 'oops' } }))).not.toThrow();
  });

  it('degrades gracefully when uia / msaa holders are null or missing', () => {
    const outcome = parse(minimalPayload({ uia: null, msaa: null }));
    if (!outcome.ok) throw new Error(`expected ok, got ${outcome.reason}`);
    expect(outcome.context.uiaInputs).toBeUndefined();
    expect(outcome.context.msaaInputs).toBeUndefined();
  });

  it('caps windowList at MAX_WINDOW_LIST', () => {
    const many = Array.from({ length: 80 }, (_, i) => ({
      hwnd: `0x${i}`,
      title: `w${i}`,
      className: 'App',
      processId: i,
      processName: 'app.exe',
      isFocused: false,
      bounds: { x: 0, y: 0, w: 10, h: 10 },
    }));
    const outcome = parse(minimalPayload({ windowList: many }));
    if (!outcome.ok) throw new Error(`expected ok, got ${outcome.reason}`);
    expect(outcome.context.windowList?.length).toBe(64);
  });
});