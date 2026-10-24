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

/** Scroll rows whose index equals their label, delimited so `row 1` cannot
 *  be found inside `row 10`. */
function document(count: number): string[] {
  return Array.from({ length: count }, (_, i) => `<row ${i}>`);
}

/** The bytes written for one frame, i.e. everything since `from`. */
function since(text: string, from: number): string {
  return text.slice(from);
}

/** How many times `needle` appears, as an exact count rather than a boolean. */
function occurrences(text: string, needle: string): number {
  return text.split(needle).length - 1;
}

/**
 * What the LAST write put on a screen row, with colour stripped.
 *
 * The last write is the one the user ends up looking at, so asserting on it is
 * asserting on the screen rather than on the history of writes that led there.
 * A row that was never addressed reports that, which is itself worth knowing:
 * the diff left it alone because it was already right.
 */
function rowAt(out: string, row: number): string {
  const marker = `\x1b[${row};1H`;
  const start = out.lastIndexOf(marker);
  if (start === -1) return '<never written>';
  const rest = out.slice(start + marker.length);
  const end = rest.indexOf('\x1b[K');
  return (end === -1 ? rest : rest.slice(0, end)).replace(/\x1b\[[0-9;]*m/gu, '');
}

describe('InlineSurface', () => {
  it('places a chrome caret after the blank slack of a short conversation', () => {
    const h = harness(10);
    h.surface.render({
      scroll: ['short conversation'],
      chrome: ['rule', 'prompt', 'rule', 'status'],
      caret: { region: 'chrome', row: 1, column: 3 },
    });
    expect(h.written()).toContain('\x1b[8;3H');
  });
  it('shows a short document without committing anything', () => {
    const h = harness(10);
    const result = h.surface.render({ scroll: ['a', 'b'], chrome: ['S'], caret: null });
    expect(result.committed).toBe(0);
    expect(h.written()).not.toContain('\x1b[1;9r');
  });

  it('commits every row the moment it leaves the live area', () => {
    const h = harness(4);
    // One chrome row leaves three for the conversation. A row is printed as
    // soon as it leaves the live area, which is the side of the trade that
    // cannot leave text unwritten anywhere: the scrollback can never be short
    // of a row the agent has already produced.
    h.surface.render({ scroll: document(1), chrome: ['S'], caret: null });
    const result = h.surface.render({ scroll: document(9), chrome: ['S'], caret: null });
    expect(result.committed).toBe(6);
    expect(h.surface.committedRows).toBe(6);
    // Nothing between the committed head and the visible tail: every row is
    // either in the scrollback or on screen.
    expect(occurrences(h.written(), '<row 8>')).toBe(1);
    expect(occurrences(h.written(), '<row 7>')).toBe(1);
  });

  it('holds nothing back: every row is either committed or on screen', () => {
    const h = harness(4);
    h.surface.render({ scroll: document(200), chrome: ['S'], caret: null });
    // Three live rows: the first 197 are committed and 197-199 are on screen.
    // There is no hold buffer between them, and that is a correctness property
    // rather than a tuning choice. A commit prints the row at the TOP of the
    // scroll region; extra uncommitted rows would therefore scroll the rows the
    // reader is looking at into the scrollback while the rows actually being
    // committed were overwritten before they were ever printed — losing them
    // and reordering the history.
    expect(h.surface.committedRows).toBe(197);
    for (const index of [0, 100, 196]) {
      expect(occurrences(h.written(), `<row ${index}>`)).toBe(1);
    }
    expect(rowAt(h.written(), 1)).toBe('<row 197>');
    expect(rowAt(h.written(), 3)).toBe('<row 199>');
  });

  it('prints each committed row exactly once', () => {
    const h = harness(3);
    h.surface.render({ scroll: document(12), chrome: ['S'], caret: null });
    // Two live rows: rows 0-9 are committed, 10-11 are the live area. So every
    // row is printed exactly once — never twice, and nothing outside the live
    // area is printed early or printed twice.
    for (let i = 0; i < 10; i += 1) {
      expect(occurrences(h.written(), `<row ${i}>`)).toBe(1);
    }
    expect(occurrences(h.written(), '<row 10>')).toBe(1);
    expect(occurrences(h.written(), '<row 11>')).toBe(1);
  });

  it('never emits a sequence that erases scrollback or the screen', () => {
    const h = harness(5);
    h.surface.render({ scroll: document(20), chrome: ['S'], caret: null });
    const out = h.written();
    expect(out).not.toContain('\x1b[3J');
    expect(out).not.toContain('\x1b[2J');
  });

  it('only ever addresses rows inside the conversation region', () => {
    const h = harness(6);
    h.surface.render({ scroll: document(30), chrome: ['S'], caret: null });
    for (const match of h.written().matchAll(/\x1b\[(\d+);1H/gu)) {
      const row = Number.parseInt(match[1] ?? '0', 10);
      expect(row).toBeGreaterThanOrEqual(1);
      expect(row).toBeLessThanOrEqual(6);
    }
  });

  it('pins chrome to the bottom row and leaves the slack above it', () => {
    const h = harness(6);
    h.surface.render({ scroll: document(2), chrome: ['STATUS'], caret: null });
    const out = h.written();
    // Row 6 is the last row on screen, and it is where chrome belongs. Padding
    // the composed document instead would have put the blank rows under the
    // status line — the one row that must never be blank.
    expect(rowAt(out, 6)).toBe('STATUS');
    expect(rowAt(out, 5)).toBe('');
    expect(rowAt(out, 2)).toBe('<row 1>');
  });

  it('blanks the slack between a short conversation and the chrome', () => {
    const h = harness(6);
    h.surface.render({ scroll: document(2), chrome: ['STATUS'], caret: null });
    const out = h.written();
    // Rows 3, 4 and 5 are written with no text: the erase-to-end-of-line is the
    // only thing there, which is what "blanked" means on a terminal.
    for (const row of [3, 4, 5]) {
      expect(rowAt(out, row)).toBe('');
      expect(since(out, out.indexOf(`\x1b[${row};1H`))).toMatch(/^\x1b\[\d+;1H\x1b\[K/);
    }
  });

  it('restarts the live area when the document was replaced, not appended to', () => {
    const h = harness(6);
    h.surface.render({ scroll: document(40), chrome: ['S'], caret: null });
    expect(h.surface.committedRows).toBeGreaterThan(0);
    // A `/clear`: the document is shorter than what has already been committed.
    // Without a restart the new conversation would sit behind rows that no
    // longer exist, and the screen would look empty after a successful clear.
    h.surface.render({ scroll: ['after the clear'], chrome: ['S'], caret: null });
    expect(h.surface.committedRows).toBe(0);
    expect(h.written()).toContain('after the clear');
  });

  it('leaves no stale pixels when the chrome grows into the slack', () => {
    const h = harness(6);
    h.surface.render({ scroll: document(2), chrome: ['S'], caret: null });
    expect(rowAt(h.written(), 5)).toBe('');
    const before = h.written().length;
    // The popup opening takes three rows from the slack. Those rows now hold
    // chrome, and every one of them is written — a row the diff skipped would
    // leave the shell's previous contents on screen looking like output.
    h.surface.render({ scroll: document(2), chrome: ['p0', 'p1', 'p2'], caret: null });
    const frame = since(h.written(), before);
    expect(rowAt(frame, 4)).toBe('p0');
    expect(rowAt(frame, 5)).toBe('p1');
    expect(rowAt(frame, 6)).toBe('p2');
  });

  it('rewrites only the rows that changed on a steady frame', () => {
    const h = harness(6);
    h.surface.render({ scroll: document(5), chrome: ['S'], caret: null });
    const before = h.written().length;
    const result = h.surface.render({
      scroll: ['<row 0>', 'CHANGED', '<row 2>', '<row 3>', '<row 4>'],
      chrome: ['S'],
      caret: null,
    });
    expect(result.rewritten).toBe(1);
    expect(since(h.written(), before)).toContain('\x1b[2;1H');
  });

  it('repaints every row after a resize', () => {
    const h = harness(6);
    h.surface.render({ scroll: document(5), chrome: ['S'], caret: null });
    h.setRows(20);
    const result = h.surface.render({ scroll: document(5), chrome: ['S'], caret: null });
    // Not an optimisation target: a real terminal REWRAPS what is already on
    // screen when its width changes, so the previous frame's row positions are
    // not a thing that can be reused. Diffing against them repaints stale
    // content into rows that now hold something else.
    expect(result.rewritten).toBe(20);
  });

  it('never commits a chrome row', () => {
    const h = harness(4);
    h.surface.render({ scroll: document(30), chrome: ['UNCOMMITTED-CHROME'], caret: null });
    // Exactly one write of it: the live frame. A commit would be a second.
    expect(occurrences(h.written(), 'UNCOMMITTED-CHROME')).toBe(1);
  });

  it('clamps chrome that is taller than the screen', () => {
    const h = harness(3);
    const result = h.surface.render({
      scroll: document(5),
      chrome: ['c0', 'c1', 'c2', 'c3', 'c4'],
      caret: null,
    });
    // Three chrome rows fill a three-row screen, so the conversation gets none
    // and nothing may be committed — there is nowhere for it to go.
    expect(result.rewritten).toBe(3);
    expect(result.committed).toBe(0);
    expect(h.surface.committedRows).toBe(0);
    expect(rowAt(h.written(), 3)).toBe('c2');
  });

  it('places the caret at the row and column it was given', () => {
    const h = harness(6);
    h.surface.render({ scroll: document(4), chrome: ['S'], caret: { row: 2, column: 7 } });
    expect(h.written()).toContain('\x1b[3;7H');
    expect(h.written()).toContain('\x1b[?25h');
    const before = h.written().length;
    h.surface.render({ scroll: document(4), chrome: ['S'], caret: null });
    expect(since(h.written(), before).endsWith('\x1b[?25l')).toBe(true);
  });

  it('commits ANSI, never the markup the renderers speak', () => {
    const h = harness(4);
    // The renderers emit `{gray-fg}` and blessed converts it. A committed row is
    // printed into the scrollback permanently, so a tag that survives the trip is
    // literal text in the user's history that no later frame can take back.
    h.surface.render({
      scroll: Array.from({ length: 20 }, (_, i) => `{gray-fg}<row ${i}>{/gray-fg}`),
      chrome: ['S'],
      caret: null,
    });
    const out = h.written();
    // Rows are converted once, through the span serializer, so the reset is the
    // full `ESC[m` rather than the paired `ESC[39m`. The contract being pinned is
    // the same: what reaches the scrollback is ANSI, never a tag.
    expect(out).toContain('\x1b[90m<row 0>\x1b[m');
    expect(out).not.toContain('{gray-fg}');
    expect(out).not.toContain('{/gray-fg}');
  });

  it('leaves the conversation on screen when it stops', () => {
    const h = harness(6);
    h.surface.render({ scroll: document(4), chrome: ['S'], caret: null });
    const before = h.written().length;
    h.surface.stop();
    // Stopping restores the cursor and erases nothing.
    expect(since(h.written(), before)).toBe('\x1b[?25h');
  });
});

describe('span rows (plan 615 Phase 5)', () => {
  /**
   * The seam takes a line in either spelling, and the inline writer must not be
   * able to tell which one it got: it converts once, at composition time, so a
   * span row and its tag spelling produce THE SAME BYTES.
   *
   * That is the whole point of the phase. If they differed, moving a renderer
   * from strings to spans would silently change the scrollback it commits — and
   * a committed row cannot be taken back.
   */
  it('writes a span row exactly as it writes the tagged spelling', () => {
    const tagged = harness(6);
    tagged.surface.render({
      scroll: ['{red-fg}a{/red-fg}', '{bold}b{/bold}'],
      chrome: ['{cyan-fg}S{/cyan-fg}'],
      caret: null,
    });

    const spanned = harness(6);
    spanned.surface.render({
      scroll: [
        [{ text: 'a', fg: { kind: 'named', name: 'red' } }],
        [{ text: 'b', attrs: ['bold'] }],
      ],
      chrome: [[{ text: 'S', fg: { kind: 'named', name: 'cyan' } }]],
      caret: null,
    });

    expect(spanned.written()).toBe(tagged.written());
    expect(spanned.written()).not.toContain('{');
  });

  it('commits a span row as ANSI, not as tags', () => {
    // The commit path is separate from the live-area write, so it has to be
    // checked separately: a tag that survives into the user's scrollback is
    // printed once and can never be corrected.
    const h = harness(3);
    h.surface.render({
      scroll: [
        [{ text: 'gone', fg: { kind: 'named', name: 'red' } }],
        [{ text: 'gone2' }],
        [{ text: 'a' }],
        [{ text: 'b' }],
      ],
      chrome: ['S'],
      caret: null,
    });
    const written = h.written();
    expect(written).toContain('\x1b[31mgone');
    expect(written).not.toContain('StyledSpan');
  });
});
