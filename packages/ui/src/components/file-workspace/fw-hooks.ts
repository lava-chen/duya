/**
 * fw-hooks.ts — the two primitives the workspace needs to stay at 60fps:
 *
 *   useVirtualRows      — which rows are inside the viewport right now
 *   useChunkedHighlight — tokenize a 100-line chunk the first time a row in
 *                         it becomes visible, then reuse it (LRU bounded)
 */
import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from "react";
import { tokenizeBlock } from "./fw-tokenize";

export interface RowRange {
  start: number;
  end: number;
}

/**
 * Windowed row range for a scroll container. Recomputes at most once per
 * animation frame, so a fast flick does not queue one render per scroll event.
 */
export function useVirtualRows(
  ref: RefObject<HTMLElement | null>,
  count: number,
  rowHeight: number,
  overscan = 10,
): RowRange {
  const [range, setRange] = useState<RowRange>(() => ({ start: 0, end: Math.min(count, 48) }));

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    let raf = 0;

    const compute = () => {
      const top = el.scrollTop;
      const height = el.clientHeight || 480;
      const start = Math.max(0, Math.floor(top / rowHeight) - overscan);
      const end = Math.min(count, Math.ceil((top + height) / rowHeight) + overscan);
      setRange((prev) => (prev.start === start && prev.end === end ? prev : { start, end }));
    };

    const onScroll = () => {
      if (raf) return;
      raf = requestAnimationFrame(() => {
        raf = 0;
        compute();
      });
    };

    compute();
    el.addEventListener("scroll", onScroll, { passive: true });
    const observer = new ResizeObserver(compute);
    observer.observe(el);
    return () => {
      el.removeEventListener("scroll", onScroll);
      observer.disconnect();
      if (raf) cancelAnimationFrame(raf);
    };
  }, [ref, count, rowHeight, overscan]);

  return range;
}

export interface HighlightStore {
  /** HTML for one line, computed on first access. */
  line: (index: number) => string;
  /** Chunks currently cached (for the perf readout). */
  size: () => number;
}

export function useChunkedHighlight(
  lines: string[],
  chunkLines = 100,
  maxChunks = 48,
): HighlightStore {
  const cache = useMemo(() => new Map<number, string[]>(), [lines]);

  const line = useCallback(
    (index: number) => {
      const chunkIndex = Math.floor(index / chunkLines);
      let html = cache.get(chunkIndex);
      if (html) {
        // LRU bump: delete + set moves the key to the end.
        cache.delete(chunkIndex);
        cache.set(chunkIndex, html);
        return html[index % chunkLines] ?? "";
      }
      const from = chunkIndex * chunkLines;
      html = tokenizeBlock(lines.slice(from, from + chunkLines).join("\n"));
      cache.set(chunkIndex, html);
      if (cache.size > maxChunks) {
        const oldest = cache.keys().next().value;
        if (oldest !== undefined) cache.delete(oldest);
      }
      return html[index % chunkLines] ?? "";
    },
    [cache, lines, chunkLines, maxChunks],
  );

  return { line, size: () => cache.size };
}

/** Escape text for `dangerouslySetInnerHTML` outside the tokenizer. */
export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/** Line index (0-based) for a DOM node inside the code surface. */
export function lineIndexFromNode(node: Node | null): number {
  if (!node) return -1;
  const el = node instanceof Element ? node : node.parentElement;
  const line = el?.closest<HTMLElement>(".fw-line");
  if (!line) return -1;
  const value = Number(line.dataset.line);
  return Number.isFinite(value) ? value : -1;
}
