/**
 * The working tail, as a function of frame index and label.
 *
 * The wiring — the timer, the chrome placement — is asserted in
 * `tui-working-tail.test.ts`. What this pins down is the part that is easy to
 * get quietly wrong: a spinner that stops, a spinner that stops on its last
 * glyph, and a line long enough to wrap.
 */

import { describe, expect, it } from 'vitest';

import {
  SPINNER_ASCII,
  SPINNER_UNICODE,
  nextSpinnerFrame,
  workingTailLine,
  WORKING_TAIL_INTERVAL_MS,
} from '../working-tail.js';
import { lineToAnsi } from '../terminal/line.js';

describe('nextSpinnerFrame', () => {
  it('advances and wraps', () => {
    expect(nextSpinnerFrame(0, true)).toBe(1);
    expect(nextSpinnerFrame(SPINNER_UNICODE.length - 1, true)).toBe(0);
    expect(nextSpinnerFrame(SPINNER_ASCII.length - 1, false)).toBe(0);
  });

  it('never sticks on the last glyph', () => {
    // The failure mode this exists to prevent: a spinner that advances to its
    // final frame and stops there reads as a hang, which is the opposite of what
    // it is for.
    const seen = new Set<number>();
    let frame = 0;
    for (let i = 0; i < SPINNER_UNICODE.length * 3; i += 1) {
      frame = nextSpinnerFrame(frame, true);
      seen.add(frame);
    }
    expect(seen.size).toBe(SPINNER_UNICODE.length);
  });

  it('survives a frame index that is negative or not a number', () => {
    // What matters is the invariant, not the exact wrap: whatever nonsense the
    // clock hands over, the result must be a frame that exists. A `NaN` index
    // producing `NaN` glyphs is a blank row where the spinner should be.
    for (const bad of [-1, -10, -11, -1000, Number.NaN, Number.POSITIVE_INFINITY, 1.7]) {
      const frame = nextSpinnerFrame(bad, true);
      expect(Number.isInteger(frame)).toBe(true);
      expect(SPINNER_UNICODE[frame]).toBeDefined();
    }
  });

  it('uses the ascii set where braille cannot be trusted', () => {
    expect(nextSpinnerFrame(0, false)).toBe(1);
  });

  it('has no glyph that the tag parser would treat as syntax', () => {
    // Not a style rule — a correctness rule. Each glyph is concatenated into
    // `{cyan-fg}<glyph>{/cyan-fg}` and parsed by `lineToAnsi`, where a backslash
    // before a brace is the escape for a literal brace. A `\` glyph consumed the
    // escape, printed `{/cyan-fg}` as text, and left the frame with half a
    // colour tag open. A brace would be worse: it would close the tag early.
    for (const set of [SPINNER_UNICODE, SPINNER_ASCII]) {
      for (const glyph of set) {
        expect(glyph).not.toBe('\\');
        expect(glyph).not.toBe('{');
        expect(glyph).not.toBe('}');
        expect(Array.from(glyph)).toHaveLength(1);
      }
    }
  });
});

describe('workingTailLine', () => {
  it('shows a glyph and the label', () => {
    const line = workingTailLine({ frame: 0, label: 'read_file', unicode: true, columns: 80 });
    // Frame 0 ADVANCES to frame 1: the tail shows where the clock has got to,
    // not the frame it was handed.
    expect(line).toContain(SPINNER_UNICODE[1]);
    expect(line).toContain('read_file');
  });

  it('emits a tag it can close', () => {
    const line = workingTailLine({ frame: 0, label: 'x', unicode: false, columns: 80 });
    expect(line).toMatch(/^\{cyan-fg\}[\.oO@]\{\/cyan-fg\} /u);
  });

  it('survives the tag parser whatever the glyph is', () => {
    // The end-to-end version of the glyph rule: run every frame of both sets
    // through the real converter and assert nothing leaks through as text.
    for (const unicode of [true, false]) {
      const set = unicode ? SPINNER_UNICODE : SPINNER_ASCII;
      for (let frame = 0; frame < set.length; frame += 1) {
        const line = workingTailLine({ frame, label: 'Working', unicode, columns: 80 });
        const ansi = lineToAnsi(line);
        expect(ansi).not.toContain('{');
        expect(ansi).not.toContain('}');
        expect(ansi).toContain('\x1b[36m');
        // The span serialiser resets the whole attribute set rather than the
        // colour alone (plan 615 Phase 5), so the close is `ESC[m`.
        expect(ansi).toContain('\x1b[m');
      }
    }
  });

  it('fits the terminal width and leaves a column spare', () => {
    // A row that exactly fills the width is the one that wraps, and a wrapped
    // row inside the live area pushes every row below it — measured happening on
    // ConPTY, which ignores the frame-level `?7l` meant to prevent it.
    const line = workingTailLine({
      frame: 0,
      label: 'a'.repeat(300),
      unicode: false,
      columns: 40,
    });
    // Measured on the RENDERED width: tags take no columns on screen, so
    // counting them would assert something the terminal never shows. The budget
    // is width-1, and the label gets width-1 minus the glyph and its space.
    const rendered = line.replace(/\{[^}]*\}/gu, '');
    expect(Array.from(rendered)).toHaveLength(39);
    expect(Array.from(rendered).length).toBeLessThan(40);
  });

  it('does not cut a tag in half while fitting', () => {
    // Fitting a line that already carries markup counts the tag as characters,
    // which leaves the terminal in the previous colour for the rest of the row.
    const line = workingTailLine({ frame: 0, label: 'b'.repeat(200), unicode: true, columns: 30 });
    const opens = line.split('{').length - 1;
    const closes = line.split('}').length - 1;
    expect(opens).toBe(closes);
    // Every brace belongs to a complete tag: no `{` is left dangling at the end
    // and none is orphaned.
    expect(line.replace(/\{[^}]*\}/gu, '')).not.toContain('{');
    expect(line.replace(/\{[^}]*\}/gu, '')).not.toContain('}');
    // The colour tag wraps only the glyph, so the label cannot inherit a colour
    // that the frame never resets.
    expect(line.startsWith('{cyan-fg}')).toBe(true);
    expect(line).toContain('{/cyan-fg}');
  });
});

describe('the clock', () => {
  it('is slower than the render throttle, so it is not wasted', () => {
    // Not a correctness rule — a rendering rule. At 90ms against a 70ms render
    // interval, roughly every other tick would be collapsed by the throttle.
    // Faster than that buys wakeups and no more motion.
    expect(WORKING_TAIL_INTERVAL_MS).toBeGreaterThanOrEqual(70);
  });
});
