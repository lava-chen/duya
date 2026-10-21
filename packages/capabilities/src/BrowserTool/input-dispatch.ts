/**
 * input-dispatch — shared low-level CDP input primitives.
 *
 * Implements the pointer/keyboard building blocks used by the computer-use
 * style actions (click_at, drag, key_combo, ...). All real backends
 * (extension daemon, sidebar webview, HumanLike wrapper) accept raw
 * `Input.*` dispatches via `send`, so these helpers work uniformly.
 *
 * When the active client is a HumanLikeCDPClient the helpers prefer its
 * smooth cursor movement so coordinate actions keep the human-like motion.
 */

import type { ICDPClient } from './CDPClient.js';

export type MouseButton = 'left' | 'right' | 'middle';
export type ModifierName = 'ctrl' | 'alt' | 'shift' | 'meta';

/** CDP modifiers bitmask: Alt=1, Ctrl=2, Meta/Command=4, Shift=8 */
export const MODIFIER_BITS: Record<ModifierName, number> = {
  alt: 1,
  ctrl: 2,
  meta: 4,
  shift: 8,
};

export function modifiersBitmask(mods: ModifierName[] = []): number {
  return mods.reduce((bits, m) => bits | (MODIFIER_BITS[m] ?? 0), 0);
}

interface KeyDef {
  key: string;
  code: string;
  keyCode: number;
}

const SPECIAL_KEYS: Record<string, KeyDef> = {
  backspace: { key: 'Backspace', code: 'Backspace', keyCode: 8 },
  tab: { key: 'Tab', code: 'Tab', keyCode: 9 },
  enter: { key: 'Enter', code: 'Enter', keyCode: 13 },
  escape: { key: 'Escape', code: 'Escape', keyCode: 27 },
  ' ': { key: ' ', code: 'Space', keyCode: 32 },
  space: { key: ' ', code: 'Space', keyCode: 32 },
  pageup: { key: 'PageUp', code: 'PageUp', keyCode: 33 },
  pagedown: { key: 'PageDown', code: 'PageDown', keyCode: 34 },
  end: { key: 'End', code: 'End', keyCode: 35 },
  home: { key: 'Home', code: 'Home', keyCode: 36 },
  arrowleft: { key: 'ArrowLeft', code: 'ArrowLeft', keyCode: 37 },
  arrowup: { key: 'ArrowUp', code: 'ArrowUp', keyCode: 38 },
  arrowright: { key: 'ArrowRight', code: 'ArrowRight', keyCode: 39 },
  arrowdown: { key: 'ArrowDown', code: 'ArrowDown', keyCode: 40 },
  delete: { key: 'Delete', code: 'Delete', keyCode: 46 },
};

const MODIFIER_KEY_DEFS: Record<ModifierName, KeyDef> = {
  ctrl: { key: 'Control', code: 'ControlLeft', keyCode: 17 },
  alt: { key: 'Alt', code: 'AltLeft', keyCode: 18 },
  shift: { key: 'Shift', code: 'ShiftLeft', keyCode: 16 },
  meta: { key: 'Meta', code: 'MetaLeft', keyCode: 91 },
};

for (let i = 1; i <= 12; i++) {
  SPECIAL_KEYS[`f${i}`] = { key: `F${i}`, code: `F${i}`, keyCode: 111 + i };
}

export function resolveKeyDef(key: string, shift = false): KeyDef {
  const lower = key.toLowerCase();
  if (lower.length === 1 && lower >= 'a' && lower <= 'z') {
    return {
      key: shift ? lower.toUpperCase() : lower,
      code: `Key${lower.toUpperCase()}`,
      keyCode: lower.toUpperCase().charCodeAt(0),
    };
  }
  if (lower.length === 1 && lower >= '0' && lower <= '9') {
    return { key: lower, code: `Digit${lower}`, keyCode: lower.charCodeAt(0) };
  }
  const special = SPECIAL_KEYS[lower];
  if (special) return special;
  // Fallback: single printable character (punctuation etc.)
  if (key.length === 1) {
    return { key, code: '', keyCode: key.toUpperCase().charCodeAt(0) };
  }
  // Named key not in the table — let Chromium resolve it by name.
  return { key, code: key, keyCode: 0 };
}

/**
 * HumanLikeCDPClient exposes moveMouseTo/clickAt; detect it structurally so
 * coordinate actions reuse bezier movement without importing the class
 * (avoids a circular dependency through CDPClient.ts).
 */
export interface HumanLikeCapable {
  moveMouseTo(x: number, y: number): Promise<void>;
  clickAt(x: number, y: number, opts?: { button?: MouseButton; clickCount?: 1 | 2 }): Promise<void>;
}

export function asHumanLike(cdp: ICDPClient): (ICDPClient & HumanLikeCapable) | null {
  const candidate = cdp as ICDPClient & Partial<HumanLikeCapable>;
  if (typeof candidate.moveMouseTo === 'function' && typeof candidate.clickAt === 'function') {
    return candidate as ICDPClient & HumanLikeCapable;
  }
  return null;
}

export async function dispatchMouseEvent(
  cdp: ICDPClient,
  params: {
    type: 'mouseMoved' | 'mousePressed' | 'mouseReleased' | 'mouseWheel';
    x: number;
    y: number;
    button?: MouseButton;
    clickCount?: number;
    deltaX?: number;
    deltaY?: number;
    modifiers?: number;
  },
): Promise<void> {
  await cdp.send('Input.dispatchMouseEvent', params as unknown as Record<string, unknown>);
}

export async function dispatchKeyEvent(
  cdp: ICDPClient,
  params: {
    type: 'keyDown' | 'keyUp' | 'rawKeyDown' | 'char';
    key: string;
    code?: string;
    windowsVirtualKeyCode?: number;
    text?: string;
    modifiers?: number;
  },
): Promise<void> {
  await cdp.send('Input.dispatchKeyEvent', params as unknown as Record<string, unknown>);
}

/** Press Backspace once (used by human-like typo correction). */
export async function dispatchBackspace(cdp: ICDPClient): Promise<void> {
  const def = SPECIAL_KEYS.backspace;
  await dispatchKeyEvent(cdp, {
    type: 'rawKeyDown',
    key: def.key,
    code: def.code,
    windowsVirtualKeyCode: def.keyCode,
  });
  await dispatchKeyEvent(cdp, {
    type: 'keyUp',
    key: def.key,
    code: def.code,
    windowsVirtualKeyCode: def.keyCode,
  });
}

/**
 * Press a key with optional modifiers, puppeteer style: modifiers go down
 * first, the main key is tapped with the full bitmask, modifiers release in
 * reverse order. Handles Ctrl+A/C/V, Shift+Tab, Ctrl+Enter, etc.
 */
export async function pressKeyWithModifiers(
  cdp: ICDPClient,
  key: string,
  modifiers: ModifierName[] = [],
): Promise<void> {
  const mask = modifiersBitmask(modifiers);
  const shift = modifiers.includes('shift');

  let accumulated = 0;
  for (const mod of modifiers) {
    const def = MODIFIER_KEY_DEFS[mod];
    accumulated |= MODIFIER_BITS[mod];
    await dispatchKeyEvent(cdp, {
      type: 'rawKeyDown',
      key: def.key,
      code: def.code,
      windowsVirtualKeyCode: def.keyCode,
      modifiers: accumulated,
    });
  }

  const def = resolveKeyDef(key, shift);
  const printable = key.length === 1 && mask === 0;
  await dispatchKeyEvent(cdp, {
    type: printable ? 'keyDown' : 'rawKeyDown',
    key: def.key,
    code: def.code,
    windowsVirtualKeyCode: def.keyCode,
    text: printable ? def.key : undefined,
    modifiers: mask,
  });
  await dispatchKeyEvent(cdp, {
    type: 'keyUp',
    key: def.key,
    code: def.code,
    windowsVirtualKeyCode: def.keyCode,
    modifiers: mask,
  });

  for (const mod of [...modifiers].reverse()) {
    const def = MODIFIER_KEY_DEFS[mod];
    accumulated &= ~MODIFIER_BITS[mod];
    await dispatchKeyEvent(cdp, {
      type: 'keyUp',
      key: def.key,
      code: def.code,
      windowsVirtualKeyCode: def.keyCode,
      modifiers: accumulated,
    });
  }
}
