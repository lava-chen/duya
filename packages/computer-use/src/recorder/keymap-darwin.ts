/**
 * keymap-darwin.ts — libuiohook VC code ↔ macOS Carbon kVK code maps
 * (plan 572 Phase 4).
 *
 * uiohook-napi normalizes events into the platform-independent VC_*
 * code space (Windows-scancode values) on ALL platforms, so the
 * existing `keymap.ts` tables reconstruct text on macOS unchanged.
 * This module is only needed for the opposite direction: posting
 * targeted keyboard events through the AX helper's `keyToPid` op,
 * which calls CGEventCreateKeyboardEvent — and CGEvent speaks Carbon
 * kVK virtual keycodes, not VC codes.
 *
 * Both directions are here so a single table stays authoritative:
 *   - VC_TO_MAC_VK:  recorder VC code → kVK (keyToPid path)
 *   - KEY_NAME_TO_MAC_VK: canonical key name → kVK (tool-layer path)
 *   - MAC_FLAG_MASKS: modifier name → CGEventFlags mask
 *
 * Sources: HIToolbox/Events.h kVK constants; libuiohook
 * keycode_scancode_table (the VC space keymap.ts documents).
 */

/** CGEventFlags masks (identical to NSEvent.modifierFlags raw values).
 * Both the canonical (`meta`) and macOS (`cmd`) vocabularies are accepted. */
export const MAC_FLAG_MASKS: Readonly<Record<string, number>> = {
  ctrl: 0x00040000, // kCGEventFlagMaskControl
  control: 0x00040000,
  alt: 0x00080000, // kCGEventFlagMaskAlternate
  option: 0x00080000,
  meta: 0x00100000, // kCGEventFlagMaskCommand
  cmd: 0x00100000,
  command: 0x00100000,
  shift: 0x00020000, // kCGEventFlagMaskShift
};

/** Canonical key name → Carbon kVK code (HIToolbox Events.h). */
export const KEY_NAME_TO_MAC_VK: Readonly<Record<string, number>> = {
  a: 0x00, s: 0x01, d: 0x02, f: 0x03, h: 0x04, g: 0x05, z: 0x06,
  x: 0x07, c: 0x08, v: 0x09, b: 0x0b, q: 0x0c, w: 0x0d, e: 0x0e,
  r: 0x0f, y: 0x10, t: 0x11, i: 0x22, o: 0x1f, p: 0x23, l: 0x25,
  j: 0x26, k: 0x28, n: 0x2d, m: 0x2e,
  u: 0x20,
  1: 0x12, 2: 0x13, 3: 0x14, 4: 0x15, 5: 0x17, 6: 0x16, 7: 0x1a,
  8: 0x1c, 9: 0x19, 0: 0x1d,
  enter: 0x24,
  tab: 0x30,
  space: 0x31,
  backspace: 0x33,
  escape: 0x35,
  delete: 0x75, // ForwardDelete
  home: 0x73,
  end: 0x77,
  pageup: 0x74,
  pagedown: 0x79,
  up: 0x7e,
  down: 0x7d,
  left: 0x7b,
  right: 0x7c,
  f1: 0x7a, f2: 0x78, f3: 0x63, f4: 0x76, f5: 0x60, f6: 0x61,
  f7: 0x62, f8: 0x64, f9: 0x65, f10: 0x6d, f11: 0x67, f12: 0x6f,
  minus: 0x1b,
  equal: 0x18,
};

/** libuiohook VC code → Carbon kVK code (keyToPid path). */
export const VC_TO_MAC_VK: ReadonlyMap<number, number> = new Map([
  // Letters (VC scancode space → kVK).
  [30, 0x00], [31, 0x01], [32, 0x02], [33, 0x03], [34, 0x04], [35, 0x05],
  [44, 0x06], [45, 0x07], [46, 0x08], [47, 0x09], [48, 0x0b], [16, 0x0c],
  [17, 0x0d], [18, 0x0e], [19, 0x0f], [20, 0x11], [21, 0x10], [22, 0x20],
  [23, 0x22], [24, 0x1f], [25, 0x23], [36, 0x26], [37, 0x28], [38, 0x25],
  [49, 0x2d], [50, 0x2e],
  // Digits.
  [2, 0x12], [3, 0x13], [4, 0x14], [5, 0x15], [6, 0x17], [7, 0x16],
  [8, 0x1a], [9, 0x1c], [10, 0x19], [11, 0x1d],
  // Punctuation.
  [12, 0x1b], [13, 0x18], [26, 0x21], [27, 0x1e], [43, 0x2a], [39, 0x29],
  [40, 0x27], [51, 0x2b], [52, 0x2f], [53, 0x2c], [41, 0x32],
  // Named keys.
  [28, 0x24], // enter
  [15, 0x30], // tab
  [57, 0x31], // space
  [14, 0x33], // backspace
  [1, 0x35], // escape
  [3667, 0x75], // forward delete
  [3655, 0x73], [3663, 0x77], [3657, 0x74], [3665, 0x79], // home/end/pgup/pgdn
  [57416, 0x7e], [57424, 0x7d], [57419, 0x7b], [57421, 0x7c], // arrows
  [59, 0x7a], [60, 0x78], [61, 0x63], [62, 0x76], [63, 0x60], [64, 0x61],
  [65, 0x62], [66, 0x64], [67, 0x65], [68, 0x6d], [87, 0x67], [88, 0x6f],
  [58, 0x39], // capslock
  [42, 0x38], [54, 0x3c], // shift / right shift
  [29, 0x3b], [3613, 0x3e], // ctrl / right ctrl
  [56, 0x3a], [3640, 0x3d], // alt / right alt
  [3675, 0x37], [3676, 0x36], // meta / right meta (kVK_Command / kVK_RightCommand)
]);

/**
 * Resolve the Carbon kVK code for a canonical key name, or null when
 * the name has no mac mapping (caller degrades to the foreground
 * nut.js path instead of posting a wrong keycode).
 */
export function resolveMacVk(keyName: string): number | null {
  const vk = KEY_NAME_TO_MAC_VK[keyName.toLowerCase()];
  return typeof vk === 'number' ? vk : null;
}

/** Combine modifier names into one CGEventFlags mask. */
export function macFlagsMask(modifiers: ReadonlyArray<string>): number {
  let mask = 0;
  for (const m of modifiers) {
    const bit = MAC_FLAG_MASKS[m.toLowerCase()];
    if (typeof bit === 'number') {
      mask |= bit;
    }
  }
  return mask;
}
