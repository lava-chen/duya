/**
 * Paste-burst detection.
 *
 * ## Why this is needed even though bracketed paste is enabled
 *
 * The TUI enables `?2004` itself (blessed never does — `program.js` has no
 * `?2004` anywhere). Measured, that is safe: feeding `\x1b[200~ab\x1b[201~`
 * through a real blessed `Program` emits only `a` and `b`; blessed's
 * `_listenInput` drops the `ESC[200~` / `ESC[201~` markers because they parse
 * to the name string `'undefined'`. So enabling the mode does not leak markers
 * into the editor.
 *
 * But the markers do not deliver the paste either. Measured on the same
 * harness, a bracketed paste arrives as ordinary per-character keypresses.
 * That is this module's actual job: recognise the character run as one paste
 * so that a pasted newline can be told from a submitted prompt.
 *
 * ## Why that distinction is load-bearing
 *
 * Without it, pasting a three-line snippet submits on its first embedded
 * newline and then submits again on each of the others — three agent runs
 * started from one paste, with the text after the first newline silently sent
 * as a separate prompt.
 *
 * ## Why idle timeout differs on Windows
 *
 * The number is an empirical artifact of the platform, not a preference:
 * Windows Terminal and PowerShell deliver a pasted run in spaced bursts rather
 * than as one tight write, so the gap that means "the paste ended" is much
 * wider there than on a POSIX terminal.
 */

export interface PasteBurstOptions {
  /** Max gap between characters still counted within one burst window. */
  readonly burstWindowMs?: number;
  /** Characters within one window that constitute a burst. */
  readonly minBurstChars?: number;
  /** How long after a burst an Enter is treated as a pasted newline. */
  readonly enterWithinMs?: number;
  /** How long after the last character a burst still accepts more characters. */
  readonly idleTimeoutMs?: number;
}

const DEFAULTS = {
  burstWindowMs: 8,
  minBurstChars: 3,
  enterWithinMs: 120,
  // Chosen by the caller (`windowsIdleTimeoutMs`); see `isWindows`.
} as const;

/** The empirical Windows idle gap, in ms. See the module comment. */
export const WINDOWS_IDLE_TIMEOUT_MS = 60;

/** The empirical POSIX idle gap, in ms. See the module comment. */
export const POSIX_IDLE_TIMEOUT_MS = 8;

/** The idle timeout appropriate to the running platform. */
export function platformIdleTimeoutMs(platform: NodeJS.Platform = process.platform): number {
  return platform === 'win32' ? WINDOWS_IDLE_TIMEOUT_MS : POSIX_IDLE_TIMEOUT_MS;
}

export class PasteBurstDetector {
  private readonly burstWindowMs: number;
  private readonly minBurstChars: number;
  private readonly enterWithinMs: number;
  private readonly idleTimeoutMs: number;

  private windowStart = -1;
  private windowCount = 0;
  private bursting = false;
  private lastCharAt = -1;

  constructor(options: PasteBurstOptions = {}) {
    this.burstWindowMs = options.burstWindowMs ?? DEFAULTS.burstWindowMs;
    this.minBurstChars = options.minBurstChars ?? DEFAULTS.minBurstChars;
    this.enterWithinMs = options.enterWithinMs ?? DEFAULTS.enterWithinMs;
    this.idleTimeoutMs = options.idleTimeoutMs ?? platformIdleTimeoutMs();
  }

  /** True while a burst is in progress. */
  get isBursting(): boolean {
    return this.bursting;
  }

  /**
   * Feed one delivery of typed or pasted characters.
   *
   * Iterates CODE POINTS, not UTF-16 units, so a run of CJK counts as the
   * characters the user typed rather than as half as many surrogate halves.
   * That matters here: a Chinese paste delivered raw would otherwise read as
   * a burst of one and never be recognised. The same applies to an astral
   * ideograph, which is two UTF-16 units but one character.
   *
   * @returns whether a burst is ACTIVE after this feed.
   *
   * State, not "did this feed reach the threshold". A character arriving
   * inside the idle timeout joins an already-open burst without reaching the
   * threshold again, and a caller asking "am I inside a paste?" needs the
   * true answer to that, not a report that this particular call changed
   * nothing.
   */
  feed(text: string, now: number): boolean {
    if (text.length === 0) return this.bursting;

    // A pause longer than the platform idle timeout ends the previous burst:
    // these characters are a new event, not a continuation.
    if (this.bursting && now - this.lastCharAt > this.idleTimeoutMs) {
      this.bursting = false;
      this.windowStart = -1;
      this.windowCount = 0;
    }

    for (const _cp of text) {
      if (this.windowStart < 0 || now - this.windowStart > this.burstWindowMs) {
        this.windowStart = now;
        this.windowCount = 0;
      }
      this.windowCount += 1;
      this.lastCharAt = now;
      if (this.windowCount >= this.minBurstChars) {
        this.bursting = true;
      }
    }
    return this.bursting;
  }

  /**
   * Whether an Enter arriving now is a pasted newline rather than a submit.
   *
   * Uses the enter window (120ms), NOT the idle timeout. They answer different
   * questions: the idle timeout decides whether more characters join the
   * CURRENT burst, while this decides how long after the last character an
   * Enter still belongs to it. Collapsing them would make the shorter of the
   * two silently govern both.
   */
  isPastedEnter(now: number): boolean {
    if (!this.bursting) return false;
    return now - this.lastCharAt <= this.enterWithinMs;
  }

  /**
   * Clear burst state after an Enter is handled, so the next character starts
   * a fresh burst rather than inheriting this one's window.
   */
  clear(now: number): void {
    this.bursting = false;
    this.windowStart = -1;
    this.windowCount = 0;
    this.lastCharAt = now;
  }

  reset(): void {
    this.bursting = false;
    this.windowStart = -1;
    this.windowCount = 0;
    this.lastCharAt = -1;
  }
}
