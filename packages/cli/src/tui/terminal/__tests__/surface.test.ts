/**
 * The inline surface's frame loop, driven by a fake terminal.
 *
 * This is the closest thing to a real terminal that a unit test can be, and it
 * is deliberately dumb: a byte sink, a size, and a history of what was
 * written. Everything asserted here is about the ORDER and SHAPE of the writes
 * — that committed rows are printed once, that the live area is rewritten
 * rather than the screen, that nothing ever reaches upward.
 */

import { describe, expect, it } from 'vitest';

import { InlineSurface } from '../surface.js';

interface Harness {
  readonly surface: InlineSurface;
  readonly written: () => string;
  readonly setRows: (rows: number) => void;
}

function harness(rows = 10): Harness {
  const chunks: string[] = [];
  let screenRows = rows;
  const surface = new InlineSurface({
    output: { write: (chunk: string) => chunks.push(chunk) } as unknown as NodeJS.WritableStream,
    size: () => ({ rows: screenRows, columns: 80 }),
    strategy: 'standard',
  });
  return {
    surface,
    written: () => chunks.join(''),
    setRows: (next) => {
      screenRows = next;
    },
  };
}

/** Document rows whose index equals their label, delimited so `row 1` cannot
 *  be found inside `row 10`. */
function document(count: number): string[] {
  return Array.from({ length: count }, (_, i) => `<row ${i}>`);
}

describe('InlineSurface', () => {
  it('shows a short document without committing anything', () => {
    const h = harness(10);
    const result = h.surface.render(['a', 'b'], null);
    expect(result.committed).toBe(0);
    expect(h.written()).not.toContain('\x1b[1;10r');
  });

  it('commits rows once the document outgrows the screen', () => {
    const h = harness(4);
    h.surface.render(['a'], null);
    const result = h.surface.render(document(9), null);
    // 9 rows into a 4-row live area leaves 5 committed.
    expect(result.committed).toBe(5);
    expect(h.surface.committedRows).toBe(5);
  });

  it('prints each committed row exactly once', () => {
    const h = harness(3);
    h.surface.render(document(12), null);
    for (let i = 0; i < 12; i += 1) {
      expect(h.written().split(`<row ${i}>`).length - 1).toBe(1);
    }
  });

  it('never emits a sequence that erases scrollback or the screen', () => {
    const h = harness(5);
    h.surface.render(document(20), null);
    const out = h.written();
    expect(out).not.toContain('\x1b[3J');
    expect(out).not.toContain('\x1b[2J');
  });

  it('only ever addresses rows inside the conversation region', () => {
    const h = harness(6);
    h.surface.render(document(30), null);
    for (const match of h.written().matchAll(/\x1b\[(\d+);1H/gu)) {
      const row = Number.parseInt(match[1] ?? '0', 10);
      expect(row).toBeGreaterThanOrEqual(1);
      expect(row).toBeLessThanOrEqual(6);
    }
  });

  it('blanks the rows a shorter document no longer reaches', () => {
    const h = harness(6);
    h.surface.render(document(30), null);
    const before = h.written().length;
    h.surface.render(['only one'], null);
    const frame = h.written().slice(before);
    // Six rows painted, not one: a `/clear` that leaves the old conversation
    // on screen is indistinguishable from a rendering bug.
    expect(frame).toContain('\x1b[1;1H');
    expect(frame).toContain('\x1b[6;1H');
  });

  it('rewrites only the rows that changed on a steady frame', () => {
    const h = harness(6);
    h.surface.render(document(6), null);
    const before = h.written().length;
    const result = h.surface.render(['<row 0>', 'CHANGED', '<row 2>', '<row 3>', '<row 4>', '<row 5>'], null);
    expect(result.rewritten).toBe(1);
    expect(h.written().slice(before)).toContain('\x1b[2;1H');
  });

  it('keeps unchanged rows across a resize instead of repainting them', () => {
    const h = harness(6);
    h.surface.render(document(6), null);
    h.setRows(20);
    const result = h.surface.render(document(6), null);
    // The six rows that already held the right content are untouched; only the
    // fourteen rows the taller screen newly has are painted.
    expect(result.rewritten).toBe(14);
  });

  it('places the caret inside the live area and hides it when asked', () => {
    const h = harness(6);
    h.surface.render(document(6), 2);
    expect(h.written()).toContain('\x1b[?25h');
    h.surface.render(document(6), null);
    expect(h.written().endsWith('\x1b[?25l')).toBe(true);
  });

  it('does not commit when the document got shorter, which is a scroll-back', () => {
    const h = harness(6);
    h.surface.render(document(20), null);
    const committedBefore = h.surface.committedRows;
    // The user scrolled up: the document is now an earlier window, not a
    // longer one. Nothing new may be printed, because a committed row can
    // never be un-committed.
    h.surface.render(['earlier 0', 'earlier 1'], null);
    expect(h.surface.committedRows).toBe(committedBefore);
  });

  it('leaves the conversation on screen when it stops', () => {
    const h = harness(6);
    h.surface.render(document(6), null);
    const before = h.written().length;
    h.surface.stop();
    // Stopping restores the cursor and erases nothing.
    expect(h.written().slice(before)).toBe('\x1b[?25h');
  });
});
