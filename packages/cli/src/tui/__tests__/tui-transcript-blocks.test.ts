import { describe, it, expect } from 'vitest';
import { TranscriptModel } from '../blocks.js';
import { renderOneBlock, type RenderOptions } from '../transcript-view.js';

const OPTIONS: RenderOptions = { expanded: false, showToolResults: true, toolResultLines: 5 };

function assistant(text: string, options: RenderOptions = OPTIONS): string {
  const model = new TranscriptModel();
  model.finalizeText(text);
  return renderOneBlock(model.blocks[0]!, options);
}

describe('block shapes (plan 614 phase 3)', () => {
  it('renders levels 1-2 headings bold inside the heading colour, marker consumed', () => {
    expect(assistant('# Title')).toContain('{cyan-fg}{bold}Title{/bold}{/cyan-fg}');
    expect(assistant('## Section')).toContain('{cyan-fg}{bold}Section{/bold}{/cyan-fg}');
    expect(assistant('# Title')).not.toContain('#');
  });

  it('renders levels 3-6 headings in the heading colour only', () => {
    expect(assistant('### Detail')).toContain('{cyan-fg}Detail{/cyan-fg}');
    // The `● ` anchor is bold, so assert on the heading text specifically.
    expect(assistant('### Detail')).not.toContain('{bold}Detail');
    expect(assistant('###### Deep')).toContain('{cyan-fg}Deep{/cyan-fg}');
  });

  it('unifies -, *, and + into one bullet glyph; ordered markers keep their number', () => {
    expect(assistant('- a')).toContain('{cyan-fg}•{/cyan-fg} a');
    expect(assistant('* a')).toContain('{cyan-fg}•{/cyan-fg} a');
    expect(assistant('+ a')).toContain('{cyan-fg}•{/cyan-fg} a');
    expect(assistant('1. a')).toContain('{cyan-fg}1.{/cyan-fg} a');
    expect(assistant('1) a')).toContain('{cyan-fg}1){/cyan-fg} a');
  });

  it('keeps list indentation for nested items', () => {
    const rendered = assistant('- a\n  - b');
    // Row 0 is the anchor + first bullet; row 1 is the nested one. The anchor
    // indents continuation rows two columns, so `  - b` lands at four.
    const nested = rendered.split('\n')[1] ?? '';
    expect(nested.replace(/\{[^}]*\}/gu, '').startsWith('    • ')).toBe(true);
  });

  it('draws a horizontal rule at the fixed legacy width when width is absent', () => {
    const rendered = assistant('---');
    const rule = rendered.split('\n').find((line) => line.includes('─'));
    expect(rule?.replace(/\{[^}]*\}/gu, '').replace(/^● /u, '')).toBe('─'.repeat(8));
  });

  it('draws a horizontal rule spanning the injected width (V9)', () => {
    const rendered = assistant('---', { ...OPTIONS, width: 40 });
    const rule = rendered.split('\n').find((line) => line.includes('─'));
    expect(rule?.replace(/\{[^}]*\}/gu, '').replace(/^● /u, '')).toBe('─'.repeat(40));
  });

  it('never changes the block line count for these shapes (D10)', () => {
    const cases = [
      '# Title',
      '### Detail',
      '- a\n  - b',
      '1. a\n2. b',
      '---',
      '# T\n\n- a\n\n---',
    ];
    for (const text of cases) {
      const inputLines = text.split('\n').length;
      const rendered = assistant(text);
      expect(rendered.split('\n').length, JSON.stringify(text)).toBe(inputLines);
    }
  });
});
