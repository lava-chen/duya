/**
 * payload.test.ts — parseOSContext keeps the supported OS context envelope
 * while ignoring rich legacy accessibility and window payloads.
 */

import { describe, expect, it } from 'vitest';
import { parseOSContext } from '../../src/worker-os-context/payload.js';
import type { OSContext } from '../../src/worker-os-context/types.js';

/** Valid v0.4.0 payload with legacy fields no longer projected into OSContext. */
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

describe('parseOSContext — supported envelope', () => {
  it('ignores removed SOM arrays while preserving supported envelope fields', () => {
    const outcome = parse(fullPayload);
    if (!outcome.ok) throw new Error(`expected ok, got ${outcome.reason}`);

    const ctx = outcome.context;
    expect(ctx).not.toHaveProperty('uiaInputs');
    expect(ctx).not.toHaveProperty('msaaInputs');
    expect(ctx).not.toHaveProperty('windowList');
    expect(ctx.foreground.pid).toBe(1234);
    expect(ctx.foreground.exeName).toBe('notepad.exe');
  });

  it('preserves supported envelope fields on a minimal payload', () => {
    const outcome = parse(minimalPayload({}));
    if (!outcome.ok) throw new Error(`expected ok, got ${outcome.reason}`);

    const ctx: OSContext = outcome.context;
    // Existing envelope fields intact.
    expect(ctx.foreground.pid).toBe(1);
    expect(ctx.focusedEntity).toBeNull();
  });

});
