import { describe, expect, it } from 'vitest';

import {
  centeredTranscriptButton,
  paintTranscriptSelection,
  selectedTranscriptText,
  transcriptSelection,
} from '../transcript-selection.js';

const TAG_VIEW = {
  renderer: 'own' as const,
  accent: { kind: 'named' as const, name: 'cyan' },
  muted: { kind: 'named' as const, name: 'gray' },
};

describe('transcriptSelection', () => {
  it('orders reverse drags and includes the endpoint cell', () => {
    expect(transcriptSelection({ row: 2, column: 4 }, { row: 1, column: 2 })).toEqual({
      start: { row: 1, column: 2 },
      end: { row: 2, column: 5 },
    });
    expect(transcriptSelection({ row: 1, column: 2 }, { row: 1, column: 2 })).toBeUndefined();
  });

  it('selects CJK glyphs by terminal cells and keeps their styles', () => {
    const rows = [[{ text: 'A中B', fg: { kind: 'named' as const, name: 'cyan' } }]];
    const selection = transcriptSelection({ row: 0, column: 1 }, { row: 0, column: 2 })!;
    expect(paintTranscriptSelection(rows[0]!, 1, 3, TAG_VIEW)).toContain('{inverse}{cyan-fg}中{/cyan-fg}{/inverse}');
    expect(selectedTranscriptText(rows, selection, 3)).toBe('中');
  });

  it('copies selected text across visible rows without including the sidebar', () => {
    const rows = [
      [{ text: 'one|sidebar' }],
      [{ text: 'two|sidebar' }],
      [{ text: 'three|sidebar' }],
    ];
    const selection = transcriptSelection({ row: 0, column: 1 }, { row: 2, column: 2 })!;
    expect(selectedTranscriptText(rows, selection, 3)).toBe('ne\ntwo\nthr');
  });

  it('centers a button on the transcript row while preserving text and selection outside it', () => {
    const row = [
      { text: 'left', fg: { kind: 'named' as const, name: 'cyan' } },
      { text: '.........................right' },
    ];
    const button = centeredTranscriptButton(row, 40, 'Go latest', TAG_VIEW, { start: 0, end: 4 });

    expect(button).toMatchObject({ column: 14, width: 11 });
    expect(button?.line).toContain('{inverse}{cyan-fg}left{/cyan-fg}{/inverse}');
    expect(button?.line).toContain('{inverse} Go latest {/inverse}');
    expect(button?.line).toContain('right');
  });
});
