import { describe, expect, it } from 'vitest';
import { buildComposerLayout } from '../composer-layout.js';
import { visibleWidth } from '../width.js';

describe('buildComposerLayout', () => {
  it('keeps a cursor in view after the default eight-row window', () => {
    const result = buildComposerLayout('x'.repeat(80), 80, {
      columns: 10,
      terminalRows: 24,
    });

    expect(result.bodyRows).toBe(8);
    expect(result.firstVisibleRow).toBeGreaterThan(0);
    expect(result.cursorRow).toBeLessThan(result.lines.length);
    expect(result.cursorRow).toBe(result.bodyRows + 1);
  });

  it('moves the window back up when the caret moves upward', () => {
    const text = 'x'.repeat(80);
    const atEnd = buildComposerLayout(text, 80, {
      columns: 10,
      terminalRows: 24,
    });
    const movedUp = buildComposerLayout(text, 47, {
      columns: 10,
      terminalRows: 24,
    });

    expect(atEnd.firstVisibleRow).toBeGreaterThan(0);
    expect(movedUp.firstVisibleRow).toBe(0);
    expect(movedUp.cursorRow).toBeLessThanOrEqual(movedUp.bodyRows + 1);
  });

  it('uses terminal cell widths for CJK at the right edge', () => {
    const result = buildComposerLayout('中文中', 3, {
      columns: 8,
      terminalRows: 20,
    });

    expect(result.lines[1]).toBe('❯ 中文中');
    expect(visibleWidth(result.lines[1] ?? '')).toBe(8);
    expect(result.cursorColumn).toBe(8);
  });

  it('handles an empty composer and clips a one-column terminal safely', () => {
    const result = buildComposerLayout('', 0, {
      columns: 1,
      terminalRows: 1,
    });

    expect(result.lines).toHaveLength(1);
    expect(result.lines[0]).toMatch(/^(❯|>)/u);
    expect(result.bodyRows).toBe(1);
    expect(result.cursorRow).toBe(1);
    expect(result.cursorColumn).toBe(1);
    expect(result.firstVisibleRow).toBe(0);
    expect(visibleWidth(result.lines[0] ?? '')).toBeLessThanOrEqual(1);
  });

  it('bounds the composer on a short terminal and offers ASCII borders', () => {
    const result = buildComposerLayout('hello', 5, {
      columns: 12,
      terminalRows: 4,
      unicode: false,
    });

    expect(result.lines).toEqual(['------------', '> hello', '------------']);
    expect(result.bodyRows).toBe(1);
    expect(result.lines.length).toBeLessThanOrEqual(4);
  });

  it('tracks a cursor across hard newlines', () => {
    const result = buildComposerLayout('first\nsecond', 9, {
      columns: 20,
      terminalRows: 16,
    });

    expect(result.lines[1]).toBe('❯ first');
    expect(result.lines[2]).toBe('  second');
    expect(result.cursorRow).toBe(3);
    expect(result.cursorColumn).toBe(6);
  });

  it('shows the predicted next prompt as a placeholder while the editor is empty', () => {
    const result = buildComposerLayout('', 0, {
      columns: 20,
      terminalRows: 16,
      placeholder: '跑一下测试',
    });

    expect(result.hasPlaceholder).toBe(true);
    expect(result.lines[1]).toBe('❯ 跑一下测试');
    // The cursor stays at the start of the text area, right after the prompt.
    expect(result.cursorColumn).toBe(3);
  });

  it('drops the placeholder as soon as the editor holds text', () => {
    const result = buildComposerLayout('hello', 5, {
      columns: 20,
      terminalRows: 16,
      placeholder: '跑一下测试',
    });

    expect(result.hasPlaceholder).toBe(false);
    expect(result.lines[1]).toBe('❯ hello');
  });
});
