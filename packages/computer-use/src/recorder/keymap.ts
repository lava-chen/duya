/**
 * keymap.ts — keycode → character / canonical-name tables (plan 556 Phase 1, D6).
 *
 * uiohook-napi reports raw virtual keycodes with no character, so text
 * reconstruction needs a US-layout mapping table keyed by the `UiohookKey`
 * constant values. The numbers are hard-coded (not imported) on purpose:
 * they are stable Win32 virtual codes, and keeping this module free of the
 * `uiohook-napi` import lets the hook-worker ship with a single runtime
 * dependency while the main process can import the tables without ever
 * loading the native hook.
 *
 * Non-US keyboard layouts degrade to `<key:${keycode}>` placeholders in
 * the aggregator's text buffer (design decision D6) — the event stream
 * stays complete, only character fidelity is lost.
 */

export interface CharMapping {
  /** Character produced without Shift held. */
  base: string;
  /** Character produced with Shift held. */
  shifted: string;
}

function charMap(entries: ReadonlyArray<readonly [number, string, string]>): ReadonlyMap<number, CharMapping> {
  return new Map(entries.map(([code, base, shifted]) => [code, { base, shifted }]));
}

/**
 * Printable-key mapping: keycode → base/shifted character pair.
 * Values follow the `UiohookKey` constants (VK codes for letters/digits,
 * extended codes for numpad). Punctuation pairs are the US 101-key layout.
 */
export const KEYCODE_TO_CHAR: ReadonlyMap<number, CharMapping> = charMap([
  // Digits row (UiohookKey['1'] .. UiohookKey['0']).
  [2, '1', '!'],
  [3, '2', '@'],
  [4, '3', '#'],
  [5, '4', '$'],
  [6, '5', '%'],
  [7, '6', '^'],
  [8, '7', '&'],
  [9, '8', '*'],
  [10, '9', '('],
  [11, '0', ')'],
  // Letters (UiohookKey.A .. Z).
  [30, 'a', 'A'],
  [48, 'b', 'B'],
  [46, 'c', 'C'],
  [32, 'd', 'D'],
  [18, 'e', 'E'],
  [33, 'f', 'F'],
  [34, 'g', 'G'],
  [35, 'h', 'H'],
  [23, 'i', 'I'],
  [36, 'j', 'J'],
  [37, 'k', 'K'],
  [38, 'l', 'L'],
  [50, 'm', 'M'],
  [49, 'n', 'N'],
  [24, 'o', 'O'],
  [25, 'p', 'P'],
  [16, 'q', 'Q'],
  [19, 'r', 'R'],
  [31, 's', 'S'],
  [20, 't', 'T'],
  [22, 'u', 'U'],
  [47, 'v', 'V'],
  [17, 'w', 'W'],
  [45, 'x', 'X'],
  [21, 'y', 'Y'],
  [44, 'z', 'Z'],
  // US punctuation.
  [12, '-', '_'],
  [13, '=', '+'],
  [26, '[', '{'],
  [27, ']', '}'],
  [43, '\\', '|'],
  [39, ';', ':'],
  [40, "'", '"'],
  [51, ',', '<'],
  [52, '.', '>'],
  [53, '/', '?'],
  [41, '`', '~'],
  [57, ' ', ' '],
  // Numpad (best-effort: mapped as glyphs regardless of NumLock; the
  // NumLock-off nav behavior is not modeled).
  [82, '0', '0'],
  [79, '1', '1'],
  [80, '2', '2'],
  [81, '3', '3'],
  [75, '4', '4'],
  [76, '5', '5'],
  [77, '6', '6'],
  [71, '7', '7'],
  [72, '8', '8'],
  [73, '9', '9'],
  [83, '.', '.'],
  [78, '+', '+'],
  [74, '-', '-'],
  [55, '*', '*'],
  [3637, '/', '/'],
]);

/**
 * Canonical names for keys that never become text: the aggregator turns
 * these into standalone `key` events (and flushes the typing buffer)
 * instead of appending to the text stream.
 */
export const KEYCODE_TO_NAME: ReadonlyMap<number, string> = new Map([
  [28, 'enter'], // Enter
  [3612, 'enter'], // NumpadEnter
  [15, 'tab'],
  [1, 'escape'],
  [14, 'backspace'],
  [3667, 'delete'],
  [58, 'capslock'],
  [3666, 'insert'],
  [3655, 'home'],
  [3663, 'end'],
  [3657, 'pageup'],
  [3665, 'pagedown'],
  [57416, 'up'],
  [57424, 'down'],
  [57419, 'left'],
  [57421, 'right'],
  [59, 'f1'],
  [60, 'f2'],
  [61, 'f3'],
  [62, 'f4'],
  [63, 'f5'],
  [64, 'f6'],
  [65, 'f7'],
  [66, 'f8'],
  [67, 'f9'],
  [68, 'f10'],
  [87, 'f11'],
  [88, 'f12'],
]);

/** Modifier keycodes (left + right variants), per UiohookKey. */
export const MODIFIER_KEYCODES: ReadonlyMap<number, 'ctrl' | 'alt' | 'meta' | 'shift'> = new Map([
  [29, 'ctrl'], // Ctrl
  [3613, 'ctrl'], // CtrlRight
  [56, 'alt'], // Alt
  [3640, 'alt'], // AltRight
  [3675, 'meta'], // Meta
  [3676, 'meta'], // MetaRight
  [42, 'shift'], // Shift
  [54, 'shift'], // ShiftRight
]);

/**
 * Resolve the printable character for a keycode under a Shift state.
 * Returns null for non-printable keys (named keys, modifiers, unknowns) —
 * callers decide whether that becomes a `<key:N>` placeholder or a `key`
 * event.
 */
export function resolveChar(keycode: number, shift: boolean): string | null {
  const mapping = KEYCODE_TO_CHAR.get(keycode);
  if (!mapping) {
    return null;
  }
  return shift ? mapping.shifted : mapping.base;
}

/**
 * Resolve the text contribution of a keydown, falling back to the D6
 * `<key:${keycode}>` placeholder when the code has no US-layout mapping
 * (non-US layout keystroke, dead key, unmapped keycode).
 * Returns null for modifier presses and named special keys — those are
 * the aggregator's business, not text.
 */
export function resolveTextForKeycode(keycode: number, shift: boolean): string | null {
  if (MODIFIER_KEYCODES.has(keycode)) {
    return null;
  }
  if (KEYCODE_TO_NAME.has(keycode)) {
    return null;
  }
  return resolveChar(keycode, shift) ?? `<key:${keycode}>`;
}
