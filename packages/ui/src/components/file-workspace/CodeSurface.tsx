/**
 * CodeSurface.tsx — the code viewport.
 *
 * Renders only the rows inside the viewport (plus overscan) and highlights
 * them in 100-line chunks. A 10,000-line file therefore keeps ~60 row nodes
 * and ~1 chunk of tokens alive at any time.
 */
import { useEffect, useRef, type CSSProperties, type MouseEvent as ReactMouseEvent, type ReactNode } from "react";
import { CaretRightIcon } from "@/components/icons";
import { lineIndexFromNode, useChunkedHighlight, useVirtualRows } from "./fw-hooks";

export const CODE_ROW_HEIGHT = 18;

export interface CodeSelection {
  /** 1-indexed first line. */
  start: number;
  /** 1-indexed last line. */
  end: number;
  text: string;
  rect: DOMRect;
}

export interface CodeSurfaceProps {
  lines: string[];
  /** Rows to render, in order; already projected through the fold state. */
  view: number[];
  /** Indent level per source line. */
  guides: number[];
  folds: Map<number, number>;
  collapsed: Set<number>;
  onToggleFold: (line: number) => void;
  /** 1-indexed line numbers that carry a comment. */
  commentLines: ReadonlySet<number>;
  onComment: (line: number) => void;
  /** 0-indexed line currently being commented on. */
  editingLine: number | null;
  onSelection: (selection: CodeSelection | null) => void;
  onContextMenu: (x: number, y: number, line: number) => void;
  /** Bump this to scroll a specific 1-indexed line into view. */
  scrollTo?: { line: number; token: number } | null;
  /**
   * Inline composer slot: rows after `line` shift down by `height` so the
   * editor is inserted between rows instead of floating over them.
   */
  reserve?: { line: number; height: number; node: ReactNode } | null;
}

export function CodeSurface({
  lines,
  view,
  guides,
  folds,
  collapsed,
  onToggleFold,
  commentLines,
  onComment,
  editingLine,
  onSelection,
  onContextMenu,
  scrollTo,
  reserve,
}: CodeSurfaceProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const range = useVirtualRows(scrollRef, view.length, CODE_ROW_HEIGHT);
  const highlight = useChunkedHighlight(lines);

  useEffect(() => {
    if (!scrollTo || !scrollRef.current) return;
    const el = scrollRef.current;
    const index = view.indexOf(scrollTo.line - 1);
    if (index < 0) return;
    const target = index * CODE_ROW_HEIGHT - el.clientHeight / 2 + CODE_ROW_HEIGHT;
    el.scrollTo({ top: Math.max(0, target), behavior: "smooth" });
  }, [scrollTo, view]);

  const handleMouseUp = () => {
    const sel = window.getSelection();
    const container = scrollRef.current;
    if (!sel || sel.isCollapsed || !sel.rangeCount || !container) {
      onSelection(null);
      return;
    }
    const domRange = sel.getRangeAt(0);
    if (!container.contains(domRange.commonAncestorContainer)) {
      onSelection(null);
      return;
    }
    const text = sel.toString();
    if (!text.trim()) {
      onSelection(null);
      return;
    }
    const a = lineIndexFromNode(domRange.startContainer);
    const b = lineIndexFromNode(domRange.endContainer);
    if (a < 0 || b < 0) {
      onSelection(null);
      return;
    }
    onSelection({
      start: Math.min(a, b) + 1,
      end: Math.max(a, b) + 1,
      text: text.slice(0, 8000),
      rect: domRange.getBoundingClientRect(),
    });
  };

  const handleContextMenu = (event: ReactMouseEvent<HTMLDivElement>) => {
    event.preventDefault();
    const line = lineIndexFromNode(event.target as Node);
    onContextMenu(event.clientX, event.clientY, line >= 0 ? line + 1 : 1);
  };

  const reserveIndex = reserve ? view.indexOf(reserve.line - 1) : -1;
  const reserveHeight = reserve && reserveIndex >= 0 ? reserve.height : 0;

  const rows = [];
  for (let k = range.start; k < range.end; k++) {
    const index = view[k];
    if (index === undefined) continue;
    const lineNo = index + 1;
    const hasFold = folds.has(lineNo);
    const isFolded = collapsed.has(lineNo);
    const hasComment = commentLines.has(lineNo);
    const depth = Math.min(guides[index] ?? 0, 14);
    const shift = reserveIndex >= 0 && k > reserveIndex ? reserveHeight : 0;

    const classes = ["fw-line"];
    if (editingLine === index) classes.push("is-editing");
    if (hasComment) classes.push("has-cmt");

    rows.push(
      <div
        key={k}
        className={classes.join(" ")}
        data-line={index}
        style={{ transform: `translateY(${k * CODE_ROW_HEIGHT + shift}px)` }}
      >
        <span className="fw-gut">
          <button
            type="button"
            className="fw-plus"
            title="添加评论"
            aria-label="添加评论"
            onClick={() => onComment(lineNo)}
          >
            +
          </button>
          {hasFold ? (
            <button
              type="button"
              className={`fw-fold${isFolded ? " is-folded" : ""}`}
              title={isFolded ? "展开" : "折叠"}
              aria-label={isFolded ? "展开" : "折叠"}
              aria-expanded={!isFolded}
              onClick={() => onToggleFold(lineNo)}
            >
              <CaretRightIcon size={12} />
            </button>
          ) : null}
        </span>
        <span className="fw-ln">{lineNo}</span>
        <span
          className="fw-code"
          style={{ "--fw-g": depth } as CSSProperties}
          dangerouslySetInnerHTML={{ __html: highlight.line(index) }}
        />
      </div>,
    );
  }

  return (
    <div
      className="fw-code-scroll"
      ref={scrollRef}
      onMouseUp={handleMouseUp}
      onContextMenu={handleContextMenu}
    >
      <div
        className="fw-code-phantom"
        style={{ height: view.length * CODE_ROW_HEIGHT + reserveHeight }}
      >
        {rows}
        {reserve && reserveIndex >= 0 ? (
          <div
            className="fw-cmt-slot"
            style={{ transform: `translateY(${(reserveIndex + 1) * CODE_ROW_HEIGHT}px)` }}
          >
            {reserve.node}
          </div>
        ) : null}
      </div>
    </div>
  );
}
