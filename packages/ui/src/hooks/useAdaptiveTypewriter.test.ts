import { describe, expect, it } from 'vitest';
import {
  balanceMarkdownSlice,
  computeTypewriterStep,
  snapToCharBoundary,
} from './useAdaptiveTypewriter';

// ── balanceMarkdownSlice ──────────────────────────────────────────────

describe('balanceMarkdownSlice', () => {
  it('returns empty string untouched', () => {
    expect(balanceMarkdownSlice('')).toBe('');
  });

  it('returns plain text untouched', () => {
    expect(balanceMarkdownSlice('hello world')).toBe('hello world');
  });

  it('returns balanced inline code untouched', () => {
    expect(balanceMarkdownSlice('run `npm test` now')).toBe('run `npm test` now');
  });

  it('closes an unterminated inline-code span', () => {
    expect(balanceMarkdownSlice('run `npm')).toBe('run `npm`');
  });

  it('leaves an even number of stray backticks alone', () => {
    // Two stray backticks = even parity = no synthetic closer.
    expect(balanceMarkdownSlice('a ` b ` c')).toBe('a ` b ` c');
  });

  it('closes an unterminated fence', () => {
    expect(balanceMarkdownSlice('```js\nconst x = 1;')).toBe('```js\nconst x = 1;\n```');
  });

  it('leaves a closed fence untouched', () => {
    const text = '```js\nconst x = 1;\n```';
    expect(balanceMarkdownSlice(text)).toBe(text);
  });

  it('matches tilde fences with tilde closers', () => {
    expect(balanceMarkdownSlice('~~~\ncode')).toBe('~~~\ncode\n~~~');
  });

  it('matches longer fence markers with equal-length closers', () => {
    expect(balanceMarkdownSlice('````md\n```nested\n```')).toBe(
      '````md\n```nested\n```\n````',
    );
  });

  it('ignores backticks inside a fence when balancing', () => {
    // The lone backtick inside the fence must not trigger the inline fix;
    // the fence closer is the right repair.
    expect(balanceMarkdownSlice('```\nx ` y')).toBe('```\nx ` y\n```');
  });

  it('recognizes fences indented by up to three spaces', () => {
    expect(balanceMarkdownSlice('   ```py\nprint(1)')).toBe('   ```py\nprint(1)\n```');
  });

  it('keeps a partially streamed show-widget fence stable', () => {
    // While the widget fence is still streaming, the slice renders as a
    // generic (closed) code block instead of flipping to raw paragraph text.
    expect(balanceMarkdownSlice('```show-widget\n<Chart />')).toBe(
      '```show-widget\n<Chart />\n```',
    );
  });

  it('never removes characters (purely additive)', () => {
    for (const input of ['`abc', '```\ncode', 'text', '~~~\nx', 'a `b` c ` d']) {
      const out = balanceMarkdownSlice(input);
      expect(out.startsWith(input)).toBe(true);
      expect(out.length).toBeGreaterThanOrEqual(input.length);
    }
  });
});

// ── snapToCharBoundary ───────────────────────────────────────────────

describe('snapToCharBoundary', () => {
  const emoji = '😀'; // surrogate pair: D83D DE00
  const text = `a${emoji}b`; // 'a', high, low, 'b'

  it('passes ASCII candidates through', () => {
    expect(snapToCharBoundary('abcd', 2)).toBe(2);
  });

  it('steps back when landing on a low surrogate', () => {
    expect(snapToCharBoundary(text, 2)).toBe(1);
  });

  it('keeps a candidate on a high surrogate', () => {
    expect(snapToCharBoundary(text, 1)).toBe(1);
  });

  it('returns boundary positions untouched', () => {
    expect(snapToCharBoundary(text, 0)).toBe(0);
    expect(snapToCharBoundary(text, text.length)).toBe(text.length);
  });
});

// ── computeTypewriterStep ────────────────────────────────────────────

describe('computeTypewriterStep', () => {
  it('always advances at least one char', () => {
    expect(computeTypewriterStep(10, 0)).toBeGreaterThanOrEqual(1);
    expect(computeTypewriterStep(0, 16)).toBeGreaterThanOrEqual(1);
  });

  it('uses the floor rate for tiny backlogs', () => {
    // 60 cps × 16.67ms ≈ 1 char per frame.
    expect(computeTypewriterStep(1, 16.67)).toBe(1);
  });

  it('scales with backlog for catch-up', () => {
    // 1600-char backlog drained over ~16 frames → 100 chars/frame.
    expect(computeTypewriterStep(1600, 16.67)).toBe(100);
  });

  it('caps the per-frame step', () => {
    expect(computeTypewriterStep(1_000_000, 250)).toBeLessThanOrEqual(400);
  });

  it('is monotonically non-decreasing in backlog', () => {
    let prev = 0;
    for (let backlog = 1; backlog <= 5000; backlog += 137) {
      const step = computeTypewriterStep(backlog, 16.67);
      expect(step).toBeGreaterThanOrEqual(prev);
      prev = step;
    }
  });

  it('drains a bursty stream smoothly and completely (simulation)', () => {
    // Simulate bursty SSE arrivals: 300-char chunks every 8 frames, cursor
    // advancing each frame. Invariants per frame:
    //   • never overshoots the target,
    //   • never stalls while behind (strict progress),
    //   • never jumps more than the per-frame cap,
    // and once arrivals stop the backlog fully drains.
    let target = 0;
    let shown = 0;
    const dtMs = 16.67;
    const CAP = 400;

    for (let frame = 0; frame < 200; frame++) {
      if (frame % 8 === 0) target += 300; // burst arrives

      const before = shown;
      if (shown < target) {
        shown = Math.min(target, shown + computeTypewriterStep(target - shown, dtMs));
      }
      expect(shown).toBeLessThanOrEqual(target);
      expect(shown - before).toBeLessThanOrEqual(CAP);
      if (before < target) expect(shown).toBeGreaterThan(before); // no stall
    }

    // After arrivals stop, the bulk drains quickly…
    let bulkFrames = 0;
    while (bulkFrames < 48 && shown < target * 0.99) {
      shown = Math.min(target, shown + computeTypewriterStep(target - shown, dtMs));
      bulkFrames++;
    }
    expect(shown).toBeGreaterThanOrEqual(Math.floor(target * 0.99));

    // …and the exponential-decay tail (which intentionally settles to the
    // floor typewriter rate near zero backlog) still finishes.
    let allFrames = 0;
    while (allFrames < 200 && shown < target) {
      shown = Math.min(target, shown + computeTypewriterStep(target - shown, dtMs));
      allFrames++;
    }
    expect(shown).toBe(target);
  });
});
