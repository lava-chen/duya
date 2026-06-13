import { useEffect, useRef, useState, useCallback } from 'react';

// Adaptive typewriter — paces displayed text to roughly match the SSE
// arrival rate so the user sees a smooth stream instead of SSE chunk
// jumps. Extracted from StreamingMessage so the per-block TextRow in
// ToolActionsGroup can reuse the same pacing logic.

const MEASURE_INTERVAL_MS = 500; // How often we recalculate typing speed
const MIN_CHARS_PER_FRAME = 1;   // Floor: at least one char per frame
const MAX_CHARS_PER_FRAME = 80;  // Cap: avoid giant single-frame jumps
const HEADROOM_FACTOR = 1.2;     // Stay 20% faster than arrival rate

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
      const next = Math.min(targetLen, cur + charsPerFrameRef.current);
      displayedRef.current = next;
      // Slice at a safe UTF-16 boundary (avoid splitting surrogates)
      setDisplayed(targetRef.current.slice(0, next));
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
