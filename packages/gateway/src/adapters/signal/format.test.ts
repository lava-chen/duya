import { describe, expect, it } from 'vitest';

import { markdownToSignal, splitSignalMessage } from './format.js';

/** Apply the produced ranges to check what the receiver would see. */
function styled(input: string): Array<{ text: string; style: string }> {
  const { text, textStyle } = markdownToSignal(input);
  return textStyle.map((range) => {
    const [start, length, style] = range.split(':');
    const from = Number(start);
    return { text: text.slice(from, from + Number(length)), style };
  });
}

describe('markdownToSignal', () => {
  it('strips markers and reports UTF-16 ranges', () => {
    const { text, textStyle } = markdownToSignal('a **bold** b');
    expect(text).toBe('a bold b');
    expect(textStyle).toEqual(['2:4:BOLD']);
  });

  it('supports italic, strikethrough and monospace', () => {
    expect(styled('*it* ~~cut~~ `code`')).toEqual([
      { text: 'it', style: 'ITALIC' },
      { text: 'cut', style: 'STRIKETHROUGH' },
      { text: 'code', style: 'MONOSPACE' },
    ]);
  });

  it('reads ** as BOLD before * as ITALIC', () => {
    expect(styled('**strong**')).toEqual([{ text: 'strong', style: 'BOLD' }]);
  });

  it('leaves snake_case and unpaired markers alone', () => {
    expect(markdownToSignal('call get_user_name()').text).toBe('call get_user_name()');
    expect(markdownToSignal('2 * 3 = 6').text).toBe('2 * 3 = 6');
  });

  it('converts headings to bold and bullets to dots', () => {
    const { text } = markdownToSignal('# Title\n- one\n- two');
    expect(text).toBe('Title\n• one\n• two');
  });

  it('leaves empty emphasis untouched', () => {
    expect(markdownToSignal('****').text).toBe('****');
  });

  it('counts astral characters by UTF-16 units, matching Signal offsets', () => {
    const { text, textStyle } = markdownToSignal('😀 **hi**');
    // The emoji occupies two UTF-16 units, so the range must start at 3.
    expect(text).toBe('😀 hi');
    expect(textStyle).toEqual(['3:2:BOLD']);
  });
});

describe('splitSignalMessage', () => {
  it('returns a single chunk under the limit', () => {
    const chunks = splitSignalMessage('short text');
    expect(chunks).toHaveLength(1);
    expect(chunks[0].text).toBe('short text');
  });

  it('splits on paragraph boundaries and keeps styling per chunk', () => {
    const paragraph = `**${'a'.repeat(30)}**`;
    const chunks = splitSignalMessage([paragraph, paragraph, paragraph].join('\n\n'), 70);
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(chunk.text.length).toBeLessThanOrEqual(70);
      expect(chunk.textStyle.length).toBeGreaterThan(0);
    }
  });
});
