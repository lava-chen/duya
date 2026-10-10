import { describe, it, expect } from 'vitest';
import { DeltaBuffer, DEFAULT_STALE_MS } from '../ui/delta-buffer.js';

describe('DeltaBuffer', () => {
  it('withholds a fragment that has neither a newline nor an age', () => {
    const b = new DeltaBuffer({ staleMs: 120 });
    b.append('Hello', 0);
    expect(b.take(0)).toBe('');
    expect(b.take(119)).toBe('');
  });

  it('commits immediately when a newline arrives', () => {
    const b = new DeltaBuffer({ staleMs: 120 });
    b.append('one\ntwo\nthree', 0);
    // Everything up to and including the LAST newline, keeping the tail: the
    // tail is still growing and committing it would show a half-written line.
    expect(b.take(0)).toBe('one\ntwo\n');
    expect(b.pendingLength).toBe('three'.length);
  });

  it('commits a newline-free fragment once it goes stale', () => {
    const b = new DeltaBuffer({ staleMs: 120 });
    b.append('a long paragraph', 0);
    expect(b.take(120)).toBe('a long paragraph');
    expect(b.isEmpty).toBe(true);
  });

  it('restarts the staleness clock after a commit, so a long paragraph streams', () => {
    const b = new DeltaBuffer({ staleMs: 120 });
    b.append('first line\n', 0);
    expect(b.take(0)).toBe('first line\n');
    expect(b.isEmpty).toBe(true);

    b.append('second', 0);
    // The clock restarted at the commit, so 119ms after the commit is not yet
    // stale for the text that arrived at t=0.
    expect(b.take(119)).toBe('');
    expect(b.take(120)).toBe('second');
  });

  it('measures age from the OLDEST fragment, not the newest', () => {
    const b = new DeltaBuffer({ staleMs: 120 });
    b.append('a', 0);
    b.append('b', 110);
    // The 'a' has been waiting 120ms even though 'b' just arrived, so the
    // whole fragment is visible. An age measured from the newest append
    // would hold text that has been on screen for 120ms already.
    expect(b.take(120)).toBe('ab');
  });

  it('ignores empty appends so they cannot starve the staleness clause', () => {
    const b = new DeltaBuffer({ staleMs: 120 });
    b.append('text', 0);
    // An empty frame must not reset `pendingSince`.
    b.append('', 200);
    expect(b.take(210)).toBe('text');
  });

  it('reports the oldest pending age for the pacer', () => {
    const b = new DeltaBuffer({ staleMs: 120 });
    expect(b.oldestPendingAge(1000)).toBe(0);
    b.append('x', 100);
    expect(b.oldestPendingAge(150)).toBe(50);
    // Never negative, even if the clock appears to go backwards.
    expect(b.oldestPendingAge(50)).toBe(0);
  });

  it('flush() commits everything regardless of the rules', () => {
    const b = new DeltaBuffer({ staleMs: 120 });
    b.append('no newline here', 0);
    expect(b.flush()).toBe('no newline here');
    expect(b.isEmpty).toBe(true);
    expect(b.flush()).toBe('');
  });

  it('reset() drops uncommitted text', () => {
    const b = new DeltaBuffer({ staleMs: 120 });
    b.append('x', 0);
    b.reset();
    expect(b.take(10000)).toBe('');
  });

  it('defaults staleMs to the documented bound', () => {
    const b = new DeltaBuffer();
    b.append('x', 0);
    expect(b.take(DEFAULT_STALE_MS - 1)).toBe('');
    expect(b.take(DEFAULT_STALE_MS)).toBe('x');
  });

  it('rejects a negative stale bound rather than rendering on every call', () => {
    expect(() => new DeltaBuffer({ staleMs: -1 })).toThrow(RangeError);
    expect(() => new DeltaBuffer({ staleMs: Number.NaN })).toThrow(RangeError);
  });

  it('never returns an empty string for a real commit', () => {
    const b = new DeltaBuffer({ staleMs: 120 });
    b.append('x', 0);
    const first = b.take(120);
    const second = b.take(200);
    expect(first).toBe('x');
    expect(second).toBe('');
  });
});
