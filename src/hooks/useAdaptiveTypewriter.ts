import { useEffect, useRef, useState, useCallback } from 'react';

// Adaptive typewriter — paces displayed text to roughly match the SSE
// arrival rate so the user sees a smooth stream instead of SSE chunk
// jumps. Extracted from StreamingMessage so the per-block TextRow in
// ToolActionsGroup can reuse the same pacing logic.

const MEASURE_INTERVAL_MS = 500; // How often we recalculate typing speed
const MIN_CHARS_PER_FRAME = 1;   // Floor: at least one char per frame
const MAX_CHARS_PER_FRAME = 80;  // Cap: avoid giant single-frame jumps
const HEADROOM_FACTOR = 1.2;     // Stay 20% faster than arrival rate

// Build a `{ parity, lastBalanced }` snapshot of `text` up to `to`,
// skipping backticks inside fenced code blocks (``` ... ``` / ~~~ ...).
// A single linear pass is O(to); callers that need multiple snapshots
// across adjacent positions should reuse this directly instead of
// calling it from scratch each time.
interface BacktickSnapshot {
  parity: number;            // 0 = balanced, 1 = half-open at `to`
  lastBalanced: number;      // rightmost balanced prefix length, or -1
}
function buildBacktickSnapshot(text: string, to: number): BacktickSnapshot {
  if (to <= 0) return { parity: 0, lastBalanced: -1 };
  let parity = 0;
  let lastBalanced = -1;
  let fenceChar: string | null = null;
  let fenceLen = 0;
  let cursor = 0;
  while (cursor < to) {
    let lineEnd = text.indexOf('\n', cursor);
    if (lineEnd === -1 || lineEnd > to) lineEnd = to;
    const line = text.slice(cursor, lineEnd);
    const fenceMatch = line.match(/^[ ]{0,3}([`]{3,}|~{3,})/);
    if (fenceMatch) {
      const marker = fenceMatch[1]!;
      if (fenceChar === null) {
        fenceChar = marker[0]!;
        fenceLen = marker.length;
      } else if (marker[0] === fenceChar && marker.length >= fenceLen) {
        fenceChar = null;
        fenceLen = 0;
      }
    } else if (fenceChar === null) {
      for (let i = 0; i < line.length; i++) {
        if (line[i] !== '`') continue;
        parity ^= 1;
        if (parity === 0) lastBalanced = cursor + i + 1;
      }
    }
    if (lineEnd === to) break;
    cursor = lineEnd + 1;
  }
  return { parity, lastBalanced };
}

// Pull a candidate cut position back to the nearest point where the
// visible prefix of `text` contains an even number of backticks, so the
// rendered slice never contains an unterminated inline-code span. When
// the candidate already sits on a balanced boundary it is returned
// as-is. When it does not, the function rewinds to the most recent
// balanced boundary the snapshot can locate before `candidate`. The
// snapshot is built in a single O(to) pass, so the search itself is
// O(1) — no walk back one character at a time.
export function snapToBalancedBacktickBoundary(text: string, candidate: number): number {
  if (candidate <= 0) return candidate;
  // Clamp out-of-range candidates to the buffer length so callers don't
  // need a separate guard. Reaching the end of the buffer is a no-op for
  // the typewriter — the flush path bypasses this helper entirely.
  if (candidate >= text.length) return text.length;
  const snap = buildBacktickSnapshot(text, candidate);
  if (snap.parity === 0) return candidate;
  // Parity is odd at `candidate` — rewind to the most recent balanced
  // prefix we already located. If there is no prior boundary inside the
  // scanned prefix (lastBalanced === -1), fall back to 0 so the next
  // frame can finish rendering without a half-open code span.
  return snap.lastBalanced >= 0 ? snap.lastBalanced : 0;
}

// Snap a candidate index back to the start of the UTF-16 code unit it
// falls on, so we never slice a surrogate pair in half. The first high
// surrogate at position p is always followed by a low surrogate at p+1;
// if candidate lands on that low surrogate, step back one unit.
export function snapToCharBoundary(text: string, candidate: number): number {
  if (candidate <= 0 || candidate >= text.length) return candidate;
  const code = text.charCodeAt(candidate);
  // 0xDC00..0xDFFF = low surrogate. Step back so we return the whole pair.
  if (code >= 0xDC00 && code <= 0xDFFF) return candidate - 1;
  return candidate;
}

export function useAdaptiveTypewriter(fullText: string, isStreaming: boolean): string {
  // Displayed slice length (number of chars shown so far)
  const displayedRef = useRef(0);
  // Mutable target (avoids stale closures in rAF)
  const targetRef = useRef(fullText);
  const isStreamingRef = useRef(isStreaming);
  // Speed measurement state
  const lastMeasureRef = useRef<number>(performance.now());
  const charsAtMeasureRef = useRef(0); // target length at last measure point
  const charsPerFrameRef = useRef(MIN_CHARS_PER_FRAME);
  // rAF handle
  const rafRef = useRef<number | null>(null);
  // React state — only updated when the visible slice actually changes
  const [displayed, setDisplayed] = useState('');

  // Keep refs in sync with latest props on every render (no re-subscriptions)
  targetRef.current = fullText;
  isStreamingRef.current = isStreaming;

  // Main rAF loop — started once and kept alive while streaming
  const tick = useCallback(() => {
    const fullText = targetRef.current; // latest SSE text
    const targetLen = fullText.length;
    let cur = displayedRef.current;

    // Speed recalculation
    const elapsed = performance.now() - lastMeasureRef.current;
    if (elapsed >= MEASURE_INTERVAL_MS) {
      const newChars = targetLen - charsAtMeasureRef.current; // chars that arrived
      const frames = elapsed / 16.67; // ~60 fps
      const rawCPF = (newChars / frames) * HEADROOM_FACTOR;
      charsPerFrameRef.current = Math.min(
        MAX_CHARS_PER_FRAME,
        Math.max(MIN_CHARS_PER_FRAME, Math.ceil(rawCPF)),
      );
      lastMeasureRef.current = performance.now();
      charsAtMeasureRef.current = targetLen;
    }

    // Flush immediately when streaming has ended
    if (!isStreamingRef.current) {
      if (cur < targetLen) {
        displayedRef.current = targetLen;
        setDisplayed(targetRef.current);
      }
      rafRef.current = null;
      return; // stop the loop
    }

    // Advance cursor
    if (cur < targetLen) {
      let next = Math.min(targetLen, cur + charsPerFrameRef.current);
      // Never slice in the middle of a markdown inline-code span: an odd
      // number of backticks inside the visible slice turns into a half-
      // open span that react-markdown will pair against the *next* matching
      // backtick (potentially across a list item or paragraph), producing
      // a string of orphaned code pills mid-stream. Snap the cut to the
      // nearest character where the prefix has an even backtick count, so
      // every visible frame is a well-formed slice of the cumulative text.
      next = snapToBalancedBacktickBoundary(fullText, next);
      // And never slice a UTF-16 surrogate pair in half.
      next = snapToCharBoundary(fullText, next);
      displayedRef.current = next;
      setDisplayed(fullText.slice(0, next));
    }

    rafRef.current = requestAnimationFrame(tick);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Start / stop the loop based on streaming state
  useEffect(() => {
    if (isStreaming) {
      if (rafRef.current === null) {
        // Reset measurement baseline when a new stream begins
        lastMeasureRef.current = performance.now();
        charsAtMeasureRef.current = displayedRef.current;
        rafRef.current = requestAnimationFrame(tick);
      }
    } else {
      // Streaming just ended — cancel the scheduled frame
      if (rafRef.current !== null) {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }
      // Flush synchronously so there's zero tail-lag.
      if (displayedRef.current < targetRef.current.length) {
        displayedRef.current = targetRef.current.length;
        setDisplayed(targetRef.current);
      }
    }
  }, [isStreaming, tick]);

  // When new text arrives while we have no active loop (e.g. first chars),
  // kick off the loop again.
  useEffect(() => {
    if (isStreaming && fullText.length > displayedRef.current && rafRef.current === null) {
      lastMeasureRef.current = performance.now();
      charsAtMeasureRef.current = displayedRef.current;
      rafRef.current = requestAnimationFrame(tick);
    }
  }, [fullText, isStreaming, tick]);

  // On session reset (text shrinks back to ''), reset all state
  useEffect(() => {
    if (fullText === '') {
      displayedRef.current = 0;
      charsPerFrameRef.current = MIN_CHARS_PER_FRAME;
      lastMeasureRef.current = performance.now();
      charsAtMeasureRef.current = 0;
      setDisplayed('');
    }
  }, [fullText]);

  return displayed;
}
