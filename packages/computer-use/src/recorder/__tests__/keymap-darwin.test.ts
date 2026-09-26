/**
 * keymap-darwin.ts — unit tests (plan 572 Phase 4).
 *
 * The VC space is libuiohook's platform-independent code space (the
 * same table keymap.ts documents); the kVK column is Carbon
 * Events.h. Spot-check the identity anchors both directions.
 */

import { describe, expect, it } from 'vitest';

import { KEY_NAME_TO_MAC_VK, macFlagsMask, resolveMacVk, VC_TO_MAC_VK } from '../keymap-darwin.js';

describe('resolveMacVk (canonical key name → kVK)', () => {
  it('maps letters, digits, and named keys to the Carbon codes', () => {
    expect(resolveMacVk('a')).toBe(0x00);
    expect(resolveMacVk('s')).toBe(0x01);
    expect(resolveMacVk('1')).toBe(0x12);
    expect(resolveMacVk('0')).toBe(0x1d);
    expect(resolveMacVk('enter')).toBe(0x24);
    expect(resolveMacVk('space')).toBe(0x31);
    expect(resolveMacVk('escape')).toBe(0x35);
    expect(resolveMacVk('backspace')).toBe(0x33);
    expect(resolveMacVk('delete')).toBe(0x75); // ForwardDelete
    expect(resolveMacVk('up')).toBe(0x7e);
    expect(resolveMacVk('left')).toBe(0x7b);
    expect(resolveMacVk('f5')).toBe(0x60);
  });

  it('is case-insensitive and returns null for unknown names', () => {
    expect(resolveMacVk('ENTER')).toBe(0x24);
    expect(resolveMacVk('klingon')).toBeNull();
  });
});

describe('VC_TO_MAC_VK (recorder VC code → kVK)', () => {
  it('anchors the letters on both ends of the table', () => {
    expect(VC_TO_MAC_VK.get(30)).toBe(0x00); // VC_A → kVK_ANSI_A
    expect(VC_TO_MAC_VK.get(16)).toBe(0x0c); // VC_Q → kVK_ANSI_Q
    expect(VC_TO_MAC_VK.get(38)).toBe(0x25); // VC_L → kVK_ANSI_L
    expect(VC_TO_MAC_VK.get(50)).toBe(0x2e); // VC_M → kVK_ANSI_M
  });

  it('anchors enter / tab / modifiers', () => {
    expect(VC_TO_MAC_VK.get(28)).toBe(0x24); // VC_ENTER
    expect(VC_TO_MAC_VK.get(15)).toBe(0x30); // VC_TAB
    expect(VC_TO_MAC_VK.get(42)).toBe(0x38); // VC_SHIFT → kVK_Shift
    expect(VC_TO_MAC_VK.get(3675)).toBe(0x37); // VC_META → kVK_Command
  });
});

describe('macFlagsMask', () => {
  it('combines the CGEventFlags masks', () => {
    expect(macFlagsMask(['cmd'])).toBe(0x00100000);
    expect(macFlagsMask(['ctrl', 'shift'])).toBe(0x00040000 | 0x00020000);
    expect(macFlagsMask([])).toBe(0);
  });
});
