import { describe, it, expect } from 'vitest';
import { renderOneBlock } from '../transcript-view.js';
import { visibleWidth } from '../width.js';

/**
 * GFM pipe tables must render as ruled, aligned text — the raw `|---|`
 * source is browser markup, and in a terminal it reads as corruption. The
 * interesting failures are all width-related: CJK cells padded by `.length`
 * instead of visible width, and delimiters misaligned by one.
 */

const OPTIONS = { expanded: false, showToolResults: true, toolResultLines: 5 };

function renderAssistant(text: string): string {
  return renderOneBlock({ kind: 'assistant', id: 'a', finalized: true, text }, OPTIONS);
}

/** Tag-free display text, so alignment can be measured like the terminal sees it. */
function stripTags(rendered: string): string[] {
  return rendered.split('\n')
    .map((line) => line.replace(/\{\/?[a-z0-9-]+\}/gu, '').replace(/\\\{/gu, '{'));
}

describe('assistant markdown tables', () => {
  it('renders a pipe table as ruled text without the raw delimiter source', () => {
    const rendered = renderAssistant([
      '| 技能 | 说明 |',
      '|-------|-------|',
      '| computer-use | 控制原生桌面应用 |',
      '| memory-search | 检索记忆系统 |',
    ].join('\n'));

    expect(rendered).toContain('│'); // cell separators
    expect(rendered).toContain('┼'); // the rule junction
    expect(rendered).toContain('─────'); // the rule
    expect(rendered).not.toContain('|---');
    expect(rendered).not.toContain('| 技能 |'); // raw source is gone
  });

  it('aligns columns with CJK-aware visible width', () => {
    const rendered = renderAssistant([
      '| name | desc |',
      '|------|------|',
      '| computer-use | 控制原生桌面应用 UI 或 Windows 系统操作 |',
      '| 检索 | 短 |',
    ].join('\n'));

    // Every body row's cell separator sits at the same DISPLAY column: strip
    // the tags, then measure the visible width ahead of the first '│'. (Raw
    // string offsets would count tag characters and CJK as 1, which is
    // exactly the bug class this assertion exists to catch.)
    const separators = stripTags(rendered)
      .filter((line) => line.includes('│'))
      .map((line) => visibleWidth(line.slice(0, line.indexOf('│'))));
    expect(separators.length).toBeGreaterThanOrEqual(3);
    expect(new Set(separators).size).toBe(1);
  });

  it('honors right alignment from the delimiter row', () => {
    const rendered = renderAssistant([
      '| left | right |',
      '|------|------:|',
      '| a | b |',
    ].join('\n'));

    // Right-aligned content sits against the cell's trailing edge, so after
    // tag stripping the body row must END with the content, not padding.
    const bodyLine = stripTags(rendered)
      .find((line) => line.includes('│') && !line.includes('left')) ?? '';
    expect(bodyLine.trimEnd()).toMatch(/b$/u);
    expect(bodyLine).toContain('  b'); // padded from the LEFT
  });

  it('keeps a sentence containing a pipe as plain text', () => {
    const rendered = renderAssistant('choose a | b when the next line is not a delimiter\n\nplain text');
    expect(rendered).not.toContain('┼');
    expect(rendered).toContain('choose a | b');
  });

  it('expands \\| escapes instead of splitting the cell', () => {
    const rendered = renderAssistant([
      '| expr | out |',
      '|------|-----|',
      '| a\\|b | 2 |',
    ].join('\n'));

    expect(rendered).toContain('a|b');
    // The escaped pipe must not have created a third column.
    const dataLine = rendered.split('\n').find((line) => line.includes('a|b')) ?? '';
    expect(dataLine).not.toContain('a|b │');
  });

  it('truncates an over-wide cell with an ellipsis', () => {
    const long = 'x'.repeat(80);
    const rendered = renderAssistant([
      '| col |',
      '|-----|',
      `| ${long} |`,
    ].join('\n'));

    expect(rendered).toContain('…');
    // The truncated row's DISPLAY width stays near the cell cap, so a wide
    // table cannot blow out the terminal.
    const body = stripTags(rendered).find((line) => line.includes('…')) ?? '';
    expect(visibleWidth(body)).toBeLessThanOrEqual(54);
  });

  it('renders header cells flat (no nested tags inside the accent)', () => {
    const rendered = renderAssistant([
      '| code | meaning |',
      '|------|---------|',
      '| `x` | backticked |',
    ].join('\n'));

    // Header line: accent wrapping escaped text, and nothing nested inside.
    const headerLine = rendered.split('\n')[0] ?? '';
    expect(headerLine).not.toMatch(/\{muted\}.*\{accent\}.*\{\/muted\}/u);
    // Body still renders inline code as muted (the muted token is gray-fg in
    // the dark palette).
    expect(rendered).toContain('{gray-fg}x{/gray-fg}');
  });
});
