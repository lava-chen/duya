/**
 * The thinking cell: head text, preview window, and disclosure row.
 *
 * Ported from minimax-code (`mcode`)'s thinking cell, so these tests pin the
 * three things that port decides:
 *
 *  - the head reports what the block DID (`Thinking…` / `Thought for 1.2s`)
 *    rather than how many characters it holds;
 *  - a collapsed block is a ONE-line preview whose edge follows the state —
 *    tail while streaming (the newest thought is on screen), head once closed
 *    (the premise is);
 *  - the head's `[+]`/`[-]` IS the disclosure; the folded rows carry no
 *    overflow row of their own.
 *
 * `strip` removes blessed tags so an assertion can quote the text the reader
 * sees instead of the tagged form the renderer emits.
 */

import { describe, expect, it } from 'vitest';
import { TranscriptModel } from '../blocks.js';
import { DEFAULT_RENDER_OPTIONS, renderTranscript } from '../transcript-view.js';

/** Strip blessed tags, leaving the text a reader sees. */
function strip(text: string): string {
  return text.replace(/\{[^}]*\}/gu, '');
}

const FIVE_LINES = 'first thought\nsecond thought\nthird thought\nfourth thought\nfifth thought';

/** One thinking block, optionally sealed at a known clock reading. */
function thinkingModel(text: string, sealedAtMs?: number): TranscriptModel {
  const model = new TranscriptModel();
  model.appendThinkingDelta(text, null, 0);
  if (sealedAtMs !== undefined) model.finalizeThinking(text, null, sealedAtMs);
  return model;
}

describe('thinking head', () => {
  it('says Thinking while the block is still streaming', () => {
    expect(strip(renderTranscript(thinkingModel('pondering')))).toContain('• Thinking…');
  });

  it('reports the measured duration once the block closes', () => {
    expect(strip(renderTranscript(thinkingModel('pondering', 1_200)))).toContain('• Thought for 1.2s');
  });

  it('omits the duration for a block that was never watched streaming', () => {
    // A reloaded transcript creates the block already complete: there is no
    // measured duration to claim, so the head stops at `Thought`.
    const model = new TranscriptModel();
    model.apply({ type: 'thinking', data: { content: 'pondering' } });
    const rendered = strip(renderTranscript(model));
    expect(rendered).toContain('• Thought');
    expect(rendered).not.toContain('Thought for');
  });

  it('formats a duration past a minute as minutes and seconds', () => {
    expect(strip(renderTranscript(thinkingModel('pondering', 125_000)))).toContain('• Thought for 2m05s');
  });

  it('marks the toggle state on the head', () => {
    const model = thinkingModel('pondering');
    const block = model.activeThinking;
    expect(strip(renderTranscript(model))).toContain('[+]');
    const expanded = strip(renderTranscript(model, {
      ...DEFAULT_RENDER_OPTIONS,
      expandedBlockIds: new Set([block?.id ?? '']),
    }));
    expect(expanded).toContain('[−]');
  });
});

describe('thinking preview window', () => {
  it('follows the tail while the block streams', () => {
    const rendered = strip(renderTranscript(thinkingModel(FIVE_LINES))).split('\n');
    // The newest line is the one on screen. A folded thought is ONE row, and
    // the head's `[+]` is what says there is more — there is no overflow row.
    expect(rendered).toEqual(['└ • Thinking… [+]', '    fifth thought']);
  });

  it('snaps to the head once the block closes', () => {
    const rendered = strip(renderTranscript(thinkingModel(FIVE_LINES, 800))).split('\n');
    expect(rendered).toEqual(['└ • Thought for 0.8s [+]', '    first thought']);
  });

  it('shows a short block without an omission row', () => {
    const rendered = strip(renderTranscript(thinkingModel('one thought', 800))).split('\n');
    // Thinking is an execution node, so it carries the trail connector: the
    // `└` says "nothing follows this in the turn".
    expect(rendered).toEqual(['└ • Thought for 0.8s [+]', '    one thought']);
  });

  it('shows nothing below a head with no text yet', () => {
    // Whitespace-only content is the shape a block takes between "the model
    // started thinking" and "the first visible token arrived".
    expect(strip(renderTranscript(thinkingModel(' ')))).toBe('└ • Thinking… [+]');
  });
});

describe('thinking expansion', () => {
  it('shows every line with no omission row when expanded', () => {
    const model = thinkingModel(FIVE_LINES, 800);
    const rendered = strip(renderTranscript(model, {
      ...DEFAULT_RENDER_OPTIONS,
      expanded: true,
    })).split('\n');
    expect(rendered[0]).toContain('• Thought for 0.8s [−]');
    expect(rendered.slice(1)).toEqual([
      '    first thought',
      '    second thought',
      '    third thought',
      '    fourth thought',
      '    fifth thought',
    ]);
    expect(rendered.join('\n')).not.toContain('more lines');
  });
});

describe('thinking character bound', () => {
  it('keeps the character-bound preview to one row', () => {
    const model = thinkingModel('x'.repeat(2_500), 800);
    const rendered = strip(renderTranscript(model)).split('\n');
    // The character bound cut the block, and the preview is ONE row: the
    // head's `[+]` is the disclosure, so there is no overflow row that could
    // miscount what the cut hid.
    expect(rendered[0]).toContain('• Thought for 0.8s');
    expect(rendered.length).toBe(2);
    expect(rendered.join('\n').length).toBeLessThan(2_500);
  });
});

describe('thinking markdown (plan 614 phase 5)', () => {
  it('stacks bold over the muted base for **strong** spans', () => {
    const rendered = renderTranscript(thinkingModel('plan **A** then B'));
    expect(rendered).toContain('{bold}{gray-fg}A{/gray-fg}{/bold}');
  });

  it('keeps the muted base for plain text and folds emphasis markers away', () => {
    const rendered = renderTranscript(thinkingModel('plain *quiet* text'));
    expect(strip(rendered)).toContain('plain quiet text');
    expect(rendered).not.toContain('*quiet*');
  });

  it('does not change the preview line count (D10 invariant)', () => {
    const text = FIVE_LINES.replace('second thought', 'has **bold** and `code`');
    // Sealed, so the preview reads from the HEAD and row 1 is on screen.
    const rendered = renderTranscript(thinkingModel(text, 1_000));
    const bodyRows = strip(rendered).split('\n').filter((line) =>
      ['first thought', 'has bold and code'].some((prefix) => line.includes(prefix)),
    ).length;
    // ONE preview row; the tagged spans inside a row may never turn into
    // extra rows.
    expect(bodyRows).toBe(1);
  });
});
