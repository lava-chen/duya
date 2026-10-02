import { useEffect, useRef, useState, useCallback } from 'react';

// Adaptive typewriter — paces displayed text to follow the SSE arrival
// rate so the user sees a smooth stream instead of SSE chunk jumps.
// Used by TextRow (growing prose block) and ThinkingRow (expanded body).
//
// ── Pacing model ────────────────────────────────────────────────────
// Backlog-driven drain, recomputed every frame:
//
//   step = clamp(max(floorRate·dt, backlog / CATCHUP_FRAMES), 1, MAX)
//
//   • floorRate keeps a gentle trickle when caught up (typewriter feel).
//   • backlog / CATCHUP_FRAMES drains any burst smoothly over ~16 frames,
//     self-adjusting to the arrival rate with no measurement windows. The
//     previous 500 ms measurement-window design whipsawed between its MAX
//     and MIN chars-per-frame on bursty SSE traffic, which read as
//     stop-start pulsing rather than a steady stream.
//   • The cursor is strictly monotonic — it never rewinds. Rewinding was
//     the core of the "疯狂闪烁" flicker: every open inline-code span or
//     fence pulled the cut point back, hiding already-rendered characters
//     until the delimiter closed.
//
// ── Well-formed slices ──────────────────────────────────────────────
// Instead of rewinding to dodge unterminated markdown delimiters, the
// displayed slice is *balanced* by appending synthetic closers: an open
// inline span gets a trailing backtick, an open fence gets a trailing
// fence line. Every frame is therefore valid markdown on its own:
// code boxes appear as soon as their opening fence arrives and grow
// smoothly, instead of flipping between paragraph text and a collapsed
// code block (a large layout jump per fence).

const FLOOR_CHARS_PER_SECOND = 60; // trickle rate when caught up with the stream
const CATCHUP_FRAMES = 16;        // frames (~270ms at 60fps) to drain the backlog over
const MAX_CHARS_PER_FRAME = 400;  // hard cap for pathological dumps

// Scan `text` up to `to` for markdown delimiter state, skipping
// backticks inside fenced code blocks (``` ... ``` / ~~~ ... ).
export interface MarkdownScanState {
  /** 0 = balanced, 1 = slice ends inside an inline-code span. */
  inlineBacktickParity: number;
  /** Non-null when the scan ends inside a fenced code block. */
  fenceChar: '`' | '~' | null;
  /** Length of the opening fence marker (3..∞); the closer must match it. */
  fenceLen: number;
}

function scanMarkdownDelimiters(text: string, to: number): MarkdownScanState {
  const state: MarkdownScanState = { inlineBacktickParity: 0, fenceChar: null, fenceLen: 0 };
  if (to <= 0) return state;
  let cursor = 0;
  while (cursor < to) {
    let lineEnd = text.indexOf('\n', cursor);
    if (lineEnd === -1 || lineEnd > to) lineEnd = to;
    const line = text.slice(cursor, lineEnd);
    const fenceMatch = line.match(/^[ ]{0,3}([`]{3,}|~{3,})/);
    if (fenceMatch) {
      const marker = fenceMatch[1]!;
      if (state.fenceChar === null) {
        state.fenceChar = marker[0] as '`' | '~';
        state.fenceLen = marker.length;
      } else if (marker[0] === state.fenceChar && marker.length >= state.fenceLen) {
        state.fenceChar = null;
        state.fenceLen = 0;
      }
    } else if (state.fenceChar === null) {
      for (let i = 0; i < line.length; i++) {
        if (line[i] !== '`') continue;
        state.inlineBacktickParity ^= 1;
      }
    }
    if (lineEnd === to) break;
    cursor = lineEnd + 1;
  }
  return state;
}

/**
 * Return `slice` extended, if needed, so it is self-consistent markdown:
 * an unterminated fenced block gets a synthetic closing fence line and an
 * unterminated inline-code span gets a synthetic closing backtick. Purely
 * additive — never removes characters, so rendering never flickers by
 * hiding previously shown text.
 */
export function balanceMarkdownSlice(slice: string): string {
  if (!slice) return slice;
  const state = scanMarkdownDelimiters(slice, slice.length);
  if (state.fenceChar !== null) {
    return slice + '\n' + state.fenceChar.repeat(state.fenceLen);
  }
  if (state.inlineBacktickParity === 1) {
    return slice + '`';
  }
  return slice;
}

/**
 * Snap a candidate index back onto the start of the UTF-16 code unit it
 * falls on, so we never slice a surrogate pair in half. The first high
 * surrogate at position p is always followed by a low surrogate at p+1;
 * if candidate lands on that low surrogate, step back one unit.
 */
export function snapToCharBoundary(text: string, candidate: number): number {
  if (candidate <= 0 || candidate >= text.length) return candidate;
  const code = text.charCodeAt(candidate);
  // 0xDC00..0xDFFF = low surrogate. Step back so we return the whole pair.
  if (code >= 0xDC00 && code <= 0xDFFF) return candidate - 1;
  return candidate;
}

/**
 * Pure pacing step computation, extracted for testability.
 *
 * @param backlog    chars received but not yet displayed (> 0)
 * @param dtMs       milliseconds since the previous frame (clamped by caller)
 * @returns integer chars to advance this frame, at least 1
 */
export function computeTypewriterStep(backlog: number, dtMs: number): number {
  const floorStep = Math.max(1, (FLOOR_CHARS_PER_SECOND * Math.max(dtMs, 0)) / 1000);
  const catchupStep = Math.max(backlog, 0) / CATCHUP_FRAMES;
  const raw = Math.max(floorStep, catchupStep);
  return Math.max(1, Math.min(MAX_CHARS_PER_FRAME, Math.floor(raw)));
}

const FRAME_MS = 16.67;
const MAX_DT_MS = 250; // clamp tab-throttle gaps so one wake-up can't dump MAX chars

export function useAdaptiveTypewriter(fullText: string, isStreaming: boolean): string {
  // Number of chars of `fullText` shown so far. Monotonic while streaming;
  // reset only when the buffer itself resets. Storing the count (not the
  // sliced string) keeps the balanced view derivable at render time.
  const [shownLen, setShownLen] = useState(() => (isStreaming ? 0 : fullText.length));
  const shownLenRef = useRef(shownLen);
  // Mutable target (avoids stale closures in rAF)
  const targetRef = useRef(fullText);
  const isStreamingRef = useRef(isStreaming);
  const lastFrameRef = useRef<number | null>(null);
  const rafRef = useRef<number | null>(null);

  // Keep refs in sync with latest props on every render (no re-subscriptions)
  targetRef.current = fullText;
  isStreamingRef.current = isStreaming;

  const advance = useCallback((len: number) => {
    shownLenRef.current = len;
    setShownLen(len);
  }, []);

  // One frame of the typing loop. Returns whether another frame should be
  // scheduled (true while streaming).
  const tick = useCallback((): boolean => {
    const now = performance.now();
    const text = targetRef.current;
    const targetLen = text.length;
    const cur = shownLenRef.current;

    // Streaming ended — flush the remainder and stop. The effect below also
    // flushes synchronously on the isStreaming transition; this covers the
    // loop's own final frame.
    if (!isStreamingRef.current) {
      lastFrameRef.current = null;
      if (cur < targetLen) advance(targetLen);
      return false;
    }

    if (cur < targetLen) {
      const dtMs = lastFrameRef.current === null ? FRAME_MS : Math.min(now - lastFrameRef.current, MAX_DT_MS);
      let next = cur + computeTypewriterStep(targetLen - cur, dtMs);
      if (next >= targetLen) next = targetLen;
      next = snapToCharBoundary(text, next);
      // Surrogate snap-back could land on `cur` (cursor sits on a high
      // surrogate); skip the whole pair so progress never stalls.
      if (next <= cur) next = Math.min(targetLen, cur + 2);
      advance(next);
    }
    // Caught-up frames stay idle but keep the loop alive so pacing resumes
    // seamlessly when the next delta lands.

    lastFrameRef.current = now;
    return true;
  }, [advance]);

  useEffect(() => {
    if (!isStreaming) {
      // Flush synchronously so there's zero tail-lag when the stream ends.
      if (shownLenRef.current < targetRef.current.length) advance(targetRef.current.length);
      return;
    }
    lastFrameRef.current = null;
    let active = true;
    const loop = () => {
      if (!active) return;
      rafRef.current = null;
      if (tick()) rafRef.current = requestAnimationFrame(loop);
    };
    rafRef.current = requestAnimationFrame(loop);
    return () => {
      active = false;
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
      lastFrameRef.current = null;
    };
  }, [isStreaming, tick, advance]);

  // On session reset (text shrinks back to ''), reset all state
  useEffect(() => {
    if (fullText === '' && shownLenRef.current !== 0) {
      shownLenRef.current = 0;
      setShownLen(0);
    }
  }, [fullText]);

  // Derive the visible text at render time: cut at the shown length, then
  // balance the slice so every frame is well-formed markdown (synthetic
  // closers for an open fence / inline span — see file header). A complete,
  // settled text passes through unchanged.
  const len = Math.min(shownLen, fullText.length);
  const shown = shownLen >= fullText.length ? fullText : fullText.slice(0, len);
  return balanceMarkdownSlice(shown);
}
