import { describe, it, expect } from 'vitest';
import {
  PasteBurstDetector,
  platformIdleTimeoutMs,
  WINDOWS_IDLE_TIMEOUT_MS,
  POSIX_IDLE_TIMEOUT_MS,
} from '../ui/paste-burst.js';

/**
 * The burst heuristic decides whether an Enter submits or is pasted content.
 * Getting it wrong either submits three times for one paste, or makes a real
 * Enter feel dead after fast typing — so both directions are pinned here.
 */
describe('PasteBurstDetector', () => {
  it('does not fire on ordinary slow typing', () => {
    const d = new PasteBurstDetector();
    d.feed('a', 0);
    d.feed('b', 100);
    d.feed('c', 200);
    expect(d.isBursting).toBe(false);
    expect(d.isPastedEnter(210)).toBe(false);
  });

  it('fires on three characters inside one window', () => {
    const d = new PasteBurstDetector();
    d.feed('h', 0);
    d.feed('e', 1);
    expect(d.isBursting).toBe(false);
    d.feed('l', 2);
    expect(d.isBursting).toBe(true);
  });

  it('treats one multi-character delivery as a burst', () => {
    const d = new PasteBurstDetector();
    expect(d.feed('hello world', 0)).toBe(true);
    expect(d.isPastedEnter(10)).toBe(true);
  });

  it('treats an Enter shortly after a burst as a pasted newline', () => {
    const d = new PasteBurstDetector();
    d.feed('abc', 0);
    expect(d.isPastedEnter(119)).toBe(true);
  });

  it('treats an Enter well after a burst as a real submit', () => {
    const d = new PasteBurstDetector();
    d.feed('abc', 0);
    expect(d.isPastedEnter(121)).toBe(false);
  });

  it('clears burst state once the Enter is handled', () => {
    const d = new PasteBurstDetector();
    d.feed('abc', 0);
    d.clear(5);
    // A second Enter immediately after the first must submit, not paste.
    expect(d.isPastedEnter(6)).toBe(false);
  });

  it('ends a burst after the platform idle timeout, and starts a new window', () => {
    const d = new PasteBurstDetector({ idleTimeoutMs: 60 });
    d.feed('abc', 0);
    expect(d.isBursting).toBe(true);

    // 100ms later these are new typing, not a continuation of the paste, so
    // the window restarts and one char cannot re-trigger the burst.
    expect(d.feed('x', 100)).toBe(false);
    expect(d.isBursting).toBe(false);
  });

  it('continues a burst inside the idle timeout', () => {
    const d = new PasteBurstDetector({ idleTimeoutMs: 60 });
    d.feed('abc', 0);
    expect(d.feed('d', 30)).toBe(true);
    expect(d.isBursting).toBe(true);
  });

  it('counts CJK by code point, not by UTF-16 unit', () => {
    const d = new PasteBurstDetector();
    // Three ideographs: 3 code points, 3 UTF-16 units here. The point of the
    // distinction is the supplementary-plane case below.
    d.feed('你好', 0);
    expect(d.isBursting).toBe(false);
    d.feed('世', 1);
    expect(d.isBursting).toBe(true);
  });

  it('counts an astral CJK character as ONE character', () => {
    const d = new PasteBurstDetector();
    // U+20000 is a surrogate pair: two UTF-16 units, one code point. Counting
    // UTF-16 units would call this a 2-char burst and fire too early.
    expect(d.feed('\u{20000}', 0)).toBe(false);
    expect(d.feed('\u{20001}', 1)).toBe(false);
    expect(d.feed('\u{20002}', 2)).toBe(true);
  });

  it('ignores empty appends', () => {
    const d = new PasteBurstDetector();
    d.feed('ab', 0);
    expect(d.feed('', 1)).toBe(false);
    expect(d.isBursting).toBe(false);
  });

  it('reset() clears everything', () => {
    const d = new PasteBurstDetector();
    d.feed('abc', 0);
    d.reset();
    expect(d.isBursting).toBe(false);
    expect(d.isPastedEnter(1)).toBe(false);
  });
});

describe('platformIdleTimeoutMs', () => {
  it('uses the measured Windows gap on win32', () => {
    expect(platformIdleTimeoutMs('win32')).toBe(WINDOWS_IDLE_TIMEOUT_MS);
  });

  it('uses the measured POSIX gap elsewhere', () => {
    expect(platformIdleTimeoutMs('linux')).toBe(POSIX_IDLE_TIMEOUT_MS);
    expect(platformIdleTimeoutMs('darwin')).toBe(POSIX_IDLE_TIMEOUT_MS);
  });
});
