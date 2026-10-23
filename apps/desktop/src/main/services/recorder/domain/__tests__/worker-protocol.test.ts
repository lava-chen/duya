import { describe, expect, it } from 'vitest';

import { isComboKeyDown, parseWorkerLine } from '../worker-protocol';

describe('worker-protocol — parseWorkerLine', () => {
  it('parses a full keydown line', () => {
    const event = parseWorkerLine(
      JSON.stringify({
        kind: 'keydown',
        ts: 123,
        keycode: 30,
        name: null,
        char: 'a',
        shiftKey: false,
        ctrlKey: false,
        altKey: false,
        metaKey: false,
      }),
    );
    expect(event).toMatchObject({ kind: 'keydown', keycode: 30, char: 'a' });
  });

  it('parses mousedown/mouseup/wheel lines', () => {
    expect(
      parseWorkerLine(JSON.stringify({ kind: 'mousedown', ts: 1, x: 10, y: 20, button: 1, clicks: 2 })),
    ).toMatchObject({ kind: 'mousedown', clicks: 2, button: 1 });
    expect(
      parseWorkerLine(JSON.stringify({ kind: 'mouseup', ts: 2, x: 10, y: 20, button: 2 })),
    ).toMatchObject({ kind: 'mouseup', button: 2 });
    expect(
      parseWorkerLine(JSON.stringify({ kind: 'wheel', ts: 3, rotation: 1, amount: 3 })),
    ).toMatchObject({ kind: 'wheel', rotation: 1 });
  });

  it('parses the dual-field heartbeat line', () => {
    expect(
      parseWorkerLine(JSON.stringify({ kind: 'heartbeat', type: 'heartbeat', ts: 4 })),
    ).toMatchObject({ kind: 'heartbeat' });
  });

  it('returns null for garbage', () => {
    expect(parseWorkerLine('')).toBeNull();
    expect(parseWorkerLine('not json')).toBeNull();
    expect(parseWorkerLine('{"kind":"mousedown"}')).toBeNull(); // missing fields
    expect(
      parseWorkerLine(JSON.stringify({ kind: 'mousedown', ts: 1, x: 0, y: 0, button: 9, clicks: 1 })),
    ).toBeNull(); // button 9 is not a libuiohook button
    expect(
      parseWorkerLine(JSON.stringify({ kind: 'teleport', ts: 1 })),
    ).toBeNull(); // unknown kind
  });

  it('isComboKeyDown keys off the event flags', () => {
    const base = {
      kind: 'keydown' as const,
      ts: 1,
      keycode: 31,
      name: null,
      char: 's',
      shiftKey: false,
      ctrlKey: false,
      altKey: false,
      metaKey: false,
    };
    expect(isComboKeyDown(base)).toBe(false);
    expect(isComboKeyDown({ ...base, ctrlKey: true })).toBe(true);
    expect(isComboKeyDown({ ...base, altKey: true })).toBe(true);
    expect(isComboKeyDown({ ...base, metaKey: true })).toBe(true);
    // Shift alone is not a combo — shift+h must stay text.
    expect(isComboKeyDown({ ...base, shiftKey: true, char: 'S' })).toBe(false);
  });
});
