import { describe, it, expect } from 'vitest';
import { isInteractiveTty, shouldUseTui } from '../ui/tty.js';
import { findSafeCut } from '../ui/bounded-writer.js';

/**
 * The TTY guard decides whether a terminal may be claimed at all. Constructing
 * `blessed.screen()` with stdout piped writes cursor and erase-screen sequences
 * into that pipe — measured on this repo's blessed 0.1.81:
 * `ESC[1;1H ESC[H ESC[J ESC[H ESC[J`. For `--print` piped into a file or
 * another program those bytes are corruption of the result, so this guard is a
 * correctness requirement rather than polish.
 */
describe('isInteractiveTty', () => {
  it('is true only when both ends are a terminal', () => {
    expect(isInteractiveTty({ stdin: { isTTY: true }, stdout: { isTTY: true } })).toBe(true);
  });

  it('is false when stdout is a pipe', () => {
    expect(isInteractiveTty({ stdin: { isTTY: true }, stdout: {} })).toBe(false);
  });

  it('is false when stdin is redirected from a file', () => {
    expect(isInteractiveTty({ stdin: {}, stdout: { isTTY: true } })).toBe(false);
  });

  it('is false for the ordinary piped case, neither end a terminal', () => {
    expect(isInteractiveTty({ stdin: {}, stdout: {} })).toBe(false);
  });

  it('is false when a stream is missing entirely', () => {
    expect(isInteractiveTty({ stdin: null, stdout: null })).toBe(false);
  });

  it('treats isTTY values other than true as not a terminal', () => {
    // A truthy non-boolean would slip through a `?:` check.
    expect(isInteractiveTty({ stdin: { isTTY: 1 as never }, stdout: { isTTY: true } })).toBe(false);
  });
});

describe('shouldUseTui', () => {
  it('allows the TUI in a real terminal', () => {
    expect(shouldUseTui({ stdin: { isTTY: true }, stdout: { isTTY: true } }, {})).toBe(true);
  });

  it('refuses the TUI when stdout is piped', () => {
    expect(shouldUseTui({ stdin: { isTTY: true }, stdout: {} }, {})).toBe(false);
  });

  it('honours the DUYA_CLI_TUI=0 escape hatch', () => {
    expect(shouldUseTui({ stdin: { isTTY: true }, stdout: { isTTY: true } }, { DUYA_CLI_TUI: '0' })).toBe(
      false,
    );
  });

  it('does not treat any other value as a disable', () => {
    expect(shouldUseTui({ stdin: { isTTY: true }, stdout: { isTTY: true } }, { DUYA_CLI_TUI: '1' })).toBe(
      true,
    );
  });
});

/**
 * A cut that lands inside an escape sequence splits one control sequence
 * across two writes, which a terminal may render as a literal `[2J` or a stray
 * colour change. These are the boundaries that must never happen.
 */
describe('findSafeCut', () => {
  const enc = (s: string): Buffer => Buffer.from(s, 'utf8');

  it('takes the whole buffer when it fits', () => {
    expect(findSafeCut(enc('hello'), 100)).toBe(5);
  });

  it('cuts at max when the boundary lands in plain text', () => {
    const buf = enc('0123456789');
    expect(findSafeCut(buf, 4)).toBe(4);
  });

  it('cuts before a CSI that begins before the scan window', () => {
    // `\x1b[2;1m` is six bytes and `max` is 5, so the sequence STARTS before
    // the cut but ends after it. Searching only the last `max` bytes would
    // find no ESC at all and split the sequence.
    const buf = enc('\x1b[2;1mHELLO');
    const cut = findSafeCut(buf, 5);
    expect(cut).toBe(0);
    expect(buf.subarray(cut).toString()).toBe('\x1b[2;1mHELLO');
  });

  it('cuts after a complete CSI, not through the one that follows it', () => {
    const buf = enc('\x1b[2J\x1b[2;1mHELLO');
    // The second CSI is incomplete within the first 8 bytes (its final 'm'
    // sits at index 8), so the cut moves back to before its ESC at index 4.
    const cut = findSafeCut(buf, 8);
    expect(cut).toBe(4);
    expect(buf.subarray(0, cut).toString()).toBe('\x1b[2J');
  });

  it('holds back an incomplete OSC', () => {
    const buf = enc('\x1b]0;title');
    expect(findSafeCut(buf, 5)).toBe(0);
  });

  it('treats a terminated OSC as complete', () => {
    const buf = enc('\x1b]0;title\x07HELLO');
    expect(findSafeCut(buf, 12)).toBe(12);
  });

  it('treats a lone trailing ESC as incomplete', () => {
    const buf = enc('HELLO\x1b');
    const cut = findSafeCut(buf, 6);
    expect(cut).toBe(5);
  });

  it('never returns a negative or beyond-length cut', () => {
    for (const size of [0, 1, 2, 3, 4, 8]) {
      const cut = findSafeCut(enc('\x1b[1;1m' + 'x'.repeat(20)), size);
      expect(cut).toBeGreaterThanOrEqual(0);
      expect(cut).toBeLessThanOrEqual(Math.min(size, 26));
    }
  });

  it('never cuts inside a CJK character', () => {
    // The cap is byte-based and a CJK code point is three bytes, so a cap of
    // 7 lands mid-character. Cutting there would emit a replacement glyph on
    // the far side of the write, so the cut backs off to the lead byte.
    const buf = enc('中'.repeat(10));
    const cut = findSafeCut(buf, 7);
    expect(cut).toBe(6);
    expect(buf.subarray(cut).toString()).not.toContain('\ufffd');
  });
});
