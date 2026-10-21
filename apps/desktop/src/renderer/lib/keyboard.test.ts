import { describe, expect, it } from 'vitest';
import {
  isEditableTarget,
  isImeEvent,
  isShortcutEventNoise,
  matchesShortcut,
  type ShortcutEventLike,
} from './keyboard';

function key(overrides: Partial<ShortcutEventLike> & { key: string }): ShortcutEventLike {
  return overrides;
}

describe('isImeEvent', () => {
  it('detects composition state', () => {
    expect(isImeEvent(key({ key: 'Enter', isComposing: true }))).toBe(true);
    expect(isImeEvent(key({ key: 'Enter', isComposing: false }))).toBe(false);
  });

  it('detects the Process/Dead keys browsers emit during composition', () => {
    expect(isImeEvent(key({ key: 'Process' }))).toBe(true);
    expect(isImeEvent(key({ key: 'Dead' }))).toBe(true);
  });

  it('falls back to legacy keyCode 229 for IMEs that never set isComposing', () => {
    expect(isImeEvent(key({ key: 'Enter', keyCode: 229 }))).toBe(true);
    expect(isImeEvent(key({ key: 'Enter', keyCode: 13 }))).toBe(false);
  });
});

describe('isShortcutEventNoise', () => {
  it('treats key repeat as noise so long-press does not fire N times', () => {
    expect(isShortcutEventNoise(key({ key: 'ArrowDown', repeat: true }))).toBe(true);
    expect(isShortcutEventNoise(key({ key: 'ArrowDown', repeat: false }))).toBe(false);
  });

  it('treats IME composition as noise', () => {
    expect(isShortcutEventNoise(key({ key: 'Escape', isComposing: true }))).toBe(true);
  });
});

describe('matchesShortcut', () => {
  it('requires declared modifiers to be pressed and undeclared ones to be released', () => {
    // mod 在非 Apple 平台映射到 Ctrl。
    expect(matchesShortcut(key({ key: 'k', ctrlKey: true }), { key: 'k', mod: true })).toBe(true);

    // 声明了 mod 但没按 → 不匹配。
    expect(matchesShortcut(key({ key: 'k' }), { key: 'k', mod: true })).toBe(false);

    // 未声明 shift，用户多按了 shift → 不匹配（避免 mod+K 误命中 mod+shift+K）。
    expect(
      matchesShortcut(key({ key: 'k', ctrlKey: true, shiftKey: true }), { key: 'k', mod: true }),
    ).toBe(false);
  });

  it('compares keys case-insensitively', () => {
    expect(matchesShortcut(key({ key: 'K', ctrlKey: true }), { key: 'k', mod: true })).toBe(true);
  });

  it('never matches noisy events', () => {
    expect(
      matchesShortcut(key({ key: 'k', ctrlKey: true, isComposing: true }), { key: 'k', mod: true }),
    ).toBe(false);
    expect(
      matchesShortcut(key({ key: 'k', ctrlKey: true, repeat: true }), { key: 'k', mod: true }),
    ).toBe(false);
  });
});

describe('isEditableTarget', () => {
  it('recognises text entry surfaces', () => {
    expect(isEditableTarget({ tagName: 'INPUT' } as unknown as EventTarget)).toBe(true);
    expect(isEditableTarget({ tagName: 'textarea' } as unknown as EventTarget)).toBe(true);
    expect(isEditableTarget({ tagName: 'DIV', isContentEditable: true } as unknown as EventTarget)).toBe(
      true,
    );
  });

  it('rejects non-editable targets and null', () => {
    expect(isEditableTarget({ tagName: 'DIV' } as unknown as EventTarget)).toBe(false);
    expect(isEditableTarget(null)).toBe(false);
  });
});
