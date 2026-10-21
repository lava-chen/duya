import { describe, expect, it } from 'vitest';

import {
  KEYCODE_TO_CHAR,
  KEYCODE_TO_NAME,
  MODIFIER_KEYCODES,
  resolveChar,
  resolveTextForKeycode,
} from '../keymap';

describe('keymap — US layout tables', () => {
  it('resolves letters with and without shift', () => {
    expect(resolveChar(30, false)).toBe('a'); // UiohookKey.A
    expect(resolveChar(30, true)).toBe('A');
    expect(resolveChar(44, true)).toBe('Z'); // UiohookKey.Z
  });

  it('resolves the digits row with shifted symbols', () => {
    expect(resolveChar(2, false)).toBe('1');
    expect(resolveChar(2, true)).toBe('!');
    expect(resolveChar(11, true)).toBe(')'); // UiohookKey['0'] = 11
  });

  it('resolves US punctuation pairs', () => {
    expect(resolveChar(39, false)).toBe(';');
    expect(resolveChar(39, true)).toBe(':');
    expect(resolveChar(53, true)).toBe('?');
    expect(resolveChar(57, false)).toBe(' '); // Space
  });

  it('resolves numpad glyphs regardless of NumLock', () => {
    expect(resolveChar(82, false)).toBe('0'); // Numpad0
    expect(resolveChar(78, false)).toBe('+'); // NumpadAdd
  });

  it('returns null for named keys and modifiers', () => {
    expect(resolveChar(28, false)).toBeNull(); // Enter
    expect(resolveChar(15, false)).toBeNull(); // Tab
    expect(resolveChar(29, false)).toBeNull(); // Ctrl
    expect(resolveChar(42, false)).toBeNull(); // Shift
    expect(resolveChar(999999, false)).toBeNull(); // unknown
  });

  it('naming table covers the keys the converter cares about', () => {
    expect(KEYCODE_TO_NAME.get(28)).toBe('enter');
    expect(KEYCODE_TO_NAME.get(15)).toBe('tab');
    expect(KEYCODE_TO_NAME.get(1)).toBe('escape');
    expect(KEYCODE_TO_NAME.get(57419)).toBe('left');
    expect(KEYCODE_TO_NAME.get(88)).toBe('f12');
    // Space is a text char, not a named key.
    expect(KEYCODE_TO_NAME.has(57)).toBe(false);
  });

  it('modifier table has both left and right variants', () => {
    expect(MODIFIER_KEYCODES.get(29)).toBe('ctrl');
    expect(MODIFIER_KEYCODES.get(3613)).toBe('ctrl');
    expect(MODIFIER_KEYCODES.get(56)).toBe('alt');
    expect(MODIFIER_KEYCODES.get(3640)).toBe('alt');
    expect(MODIFIER_KEYCODES.get(3675)).toBe('meta');
    expect(MODIFIER_KEYCODES.get(54)).toBe('shift');
  });

  it('resolveTextForKeycode: printable → char, unmapped printable → placeholder', () => {
    expect(resolveTextForKeycode(30, false)).toBe('a');
    expect(resolveTextForKeycode(3, true)).toBe('@');
    // Unknown printable keycode degrades to the D6 placeholder.
    expect(resolveTextForKeycode(250, false)).toBe('<key:250>');
    // Named keys and modifiers contribute nothing to text.
    expect(resolveTextForKeycode(28, false)).toBeNull();
    expect(resolveTextForKeycode(29, true)).toBeNull();
  });

  it('char table keys and name table keys are disjoint', () => {
    for (const code of KEYCODE_TO_CHAR.keys()) {
      expect(KEYCODE_TO_NAME.has(code)).toBe(false);
    }
  });
});
