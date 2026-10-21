"use client";

import type { CanvasElement, CanvasPosition } from "../types/conductor";

/**
 * Tiny SVG renderer for a single canvas, used as the card thumbnail in
 * the asset library. It reads the snapshot's `elements` (cast through
 * `any` because the renderer-side `ConductorSnapshot` type predates the
 * `elements` field on the IPC payload) and paints:
 *   - native/sticky  → colored rounded rect
 *   - native/text    → neutral rect
 *   - native/shape   → rect / ellipse / diamond / hexagon / triangle / parallelogram
 *   - native/document→ rect + three faint rules
 *   - native/table   → mini grid
 *   - native/image | file | link → dashed rect
 *   - native/connector→ 2-segment elbow polyline
 *
 * The SVG viewBox is computed from the union of all element bounding
 * boxes plus a small padding, and `preserveAspectRatio="xMidYMid meet"`
 * lets the SVG fit the fixed-height container with letterboxing — the
 * container's background color shows through, matching the canvas
 * editor's main background.
 */

const STICKY: Record<string, { fill: string; stroke: string }> = {
  yellow: { fill: "rgb(250,238,218)", stroke: "rgb(133,79,11)" },
  blue:   { fill: "rgb(230,241,251)", stroke: "rgb(24,95,165)" },
  green:  { fill: "rgb(225,245,238)", stroke: "rgb(15,110,86)" },
  pink:   { fill: "rgb(252,235,235)", stroke: "rgb(163,45,45)" },
  purple: { fill: "rgb(238,237,254)", stroke: "rgb(83,74,183)" },
  gray:   { fill: "rgb(241,239,232)", stroke: "rgb(95,94,90)" },
};

const SURFACE = "var(--surface,#1e1e22)";
const MUTED = "var(--muted-foreground,#888)";

type ThumbItem = {
  id: string;
  kind: string;
  pos: CanvasPosition;
  config: Record<string, unknown>;
};

function pointOf(node: CanvasElement, u: number, v: number) {
  return { x: node.position.x + u * node.position.w, y: node.position.y + v * node.position.h };
}

/** A position is only usable when every coordinate is a finite number. */
function isValidPos(pos: CanvasPosition | undefined): pos is CanvasPosition {
  if (!pos) return false;
  return (
    Number.isFinite(pos.x) &&
    Number.isFinite(pos.y) &&
    Number.isFinite(pos.w) &&
    Number.isFinite(pos.h)
  );
}

function elbow(sx: number, sy: number, tx: number, ty: number): Array<[number, number]> {
  if (Math.abs(tx - sx) >= Math.abs(ty - sy)) {
    return [[sx, sy], [tx, sy], [tx, ty]];
  }
  return [[sx, sy], [sx, ty], [tx, ty]];
}

function ShapeGlyph({
  kind,
  x,
  y,
  w,
  h,
  fill,
  stroke,
}: {
  kind: string;
  x: number;
  y: number;
  w: number;
  h: number;
  fill: string;
  stroke: string;
}) {
  if (kind === "ellipse") {
    return <ellipse cx={x + w / 2} cy={y + h / 2} rx={w / 2} ry={h / 2} fill={fill} stroke={stroke} strokeWidth={0.1} />;
  }
  let pts: Array<[number, number]>;
  switch (kind) {
    case "diamond":
      pts = [[x + w / 2, y], [x + w, y + h / 2], [x + w / 2, y + h], [x, y + h / 2]];
      break;
    case "hexagon":
      pts = [[x + w / 4, y], [x + (3 * w) / 4, y], [x + w, y + h / 2], [x + (3 * w) / 4, y + h], [x + w / 4, y + h], [x, y + h / 2]];
      break;
    case "triangle":
      pts = [[x + w / 2, y], [x + w, y + h], [x, y + h]];
      break;
    case "parallelogram":
      pts = [[x + w * 0.2, y], [x + w, y], [x + w * 0.8, y + h], [x, y + h]];
      break;
    default:
      pts = [[x, y], [x + w, y], [x + w, y + h], [x, y + h]];
  }
  return <polygon points={pts.map((p) => p.join(",")).join(" ")} fill={fill} stroke={stroke} strokeWidth={0.1} strokeLinejoin="round" />;
}

export function CanvasThumbnail({
  snapshot,
  className,
}: {
  snapshot: unknown;
  className?: string;
}) {
  const elements = (snapshot as { elements?: CanvasElement[] } | null | undefined)?.elements ?? [];
  const widgets = (snapshot as { widgets?: Array<{ id: string; type: string; position?: CanvasPosition; config?: Record<string, unknown> }> } | null | undefined)?.widgets ?? [];

  const items: ThumbItem[] = [];
  for (const e of elements) {
    if (isValidPos(e.position)) {
      items.push({ id: e.id, kind: e.elementKind, pos: e.position, config: e.config ?? {} });
    }
  }
  for (const w of widgets) {
    if (isValidPos(w.position)) {
      items.push({ id: w.id, kind: `widget/${w.type}`, pos: w.position, config: w.config ?? {} });
    }
  }

  const containerClass = `w-full h-28 rounded-t-lg bg-[var(--main-bg,#0f1012)] border-b border-border overflow-hidden ${className ?? ""}`.trim();

  if (items.length === 0) {
    return (
      <div className={containerClass + " flex items-center justify-center"}>
        <span className="text-[10px] text-muted-foreground">空画布</span>
      </div>
    );
  }

  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const it of items) {
    minX = Math.min(minX, it.pos.x);
    minY = Math.min(minY, it.pos.y);
    maxX = Math.max(maxX, it.pos.x + it.pos.w);
    maxY = Math.max(maxY, it.pos.y + it.pos.h);
  }
  const pad = 0.8;
  minX -= pad; minY -= pad; maxX += pad; maxY += pad;
  let vbW = maxX - minX;
  let vbH = maxY - minY;
  // Defensive: a degenerate bounding box (non-finite or zero size) would
  // produce an invalid viewBox and spam the console with SVG attribute
  // errors. Fall back to a neutral box so the SVG stays renderable.
  if (!Number.isFinite(vbW) || !Number.isFinite(vbH) || vbW <= 0 || vbH <= 0) {
    minX = 0;
    minY = 0;
    vbW = 100;
    vbH = 100;
  }

  const nodeMap = new Map<string, CanvasElement>();
  for (const e of elements) nodeMap.set(e.id, e);

  return (
    <div className={containerClass}>
      <svg
        width="100%"
        height="100%"
        viewBox={`${minX} ${minY} ${vbW} ${vbH}`}
        preserveAspectRatio="xMidYMid meet"
        style={{ display: "block" }}
      >
        {items.map((it) => {
          const { x, y, w, h } = it.pos;
          const k = it.kind;
          const colorRaw = typeof it.config.color === "string" ? it.config.color : "";
          if (k === "native/sticky") {
            const c = STICKY[colorRaw] ?? STICKY.gray;
            return <rect key={it.id} x={x} y={y} width={w} height={h} fill={c.fill} stroke={c.stroke} strokeWidth={0.1} rx={0.2} />;
          }
          if (k === "native/text") {
            return <rect key={it.id} x={x} y={y} width={w} height={h} fill={SURFACE} stroke={MUTED} strokeWidth={0.1} rx={0.15} />;
          }
          if (k === "native/shape") {
            const shapeKind = typeof it.config.shape === "string" ? it.config.shape : "rect";
            const isHex = colorRaw.startsWith("#");
            const fill = isHex ? colorRaw : (STICKY[colorRaw]?.fill ?? MUTED);
            const stroke = isHex ? colorRaw : (STICKY[colorRaw]?.stroke ?? MUTED);
            return <ShapeGlyph key={it.id} kind={shapeKind} x={x} y={y} w={w} h={h} fill={fill} stroke={stroke} />;
          }
          if (k === "native/document") {
            return (
              <g key={it.id}>
                <rect x={x} y={y} width={w} height={h} fill={SURFACE} stroke={MUTED} strokeWidth={0.1} rx={0.15} />
                {[0.3, 0.5, 0.7].map((t, i) => (
                  <line key={i} x1={x + 0.3} y1={y + h * t} x2={x + w - 0.3} y2={y + h * t} stroke={MUTED} strokeWidth={0.07} />
                ))}
              </g>
            );
          }
          if (k === "native/table") {
            const cells = 2;
            const v = Array.from({ length: cells + 1 }, (_, i) => (
              <line key={`v${i}`} x1={x + (w * i) / cells} y1={y} x2={x + (w * i) / cells} y2={y + h} stroke={MUTED} strokeWidth={0.07} />
            ));
            const lns = Array.from({ length: cells + 1 }, (_, i) => (
              <line key={`h${i}`} x1={x} y1={y + (h * i) / cells} x2={x + w} y2={y + (h * i) / cells} stroke={MUTED} strokeWidth={0.07} />
            ));
            return (
              <g key={it.id}>
                <rect x={x} y={y} width={w} height={h} fill={SURFACE} stroke={MUTED} strokeWidth={0.1} rx={0.1} />
                {v}
                {lns}
              </g>
            );
          }
          if (k === "native/image" || k === "native/file" || k === "native/link") {
            return <rect key={it.id} x={x} y={y} width={w} height={h} fill={SURFACE} stroke={MUTED} strokeWidth={0.1} rx={0.1} strokeDasharray="0.3 0.2" />;
          }
          return <rect key={it.id} x={x} y={y} width={w} height={h} fill={MUTED} stroke={MUTED} strokeWidth={0.1} rx={0.1} opacity={0.5} />;
        })}
        {elements
          .filter((e) => e.elementKind === "native/connector")
          .map((e) => {
            const c = (e.config ?? {}) as Record<string, unknown>;
            const get = (side: unknown) => {
              if (!side || typeof side !== "object") return null;
              const s = side as { kind?: string; nodeId?: string; bindingPoint?: { u: number; v: number }; point?: { x: number; y: number } };
              if (s.kind === "bound" && s.nodeId) {
                const n = nodeMap.get(s.nodeId);
                if (!n) return null;
                const u = s.bindingPoint?.u ?? 0.5;
                const v = s.bindingPoint?.v ?? 0.5;
                return pointOf(n, u, v);
              }
              if (s.kind === "free" && s.point) return { x: s.point.x, y: s.point.y };
              return null;
            };
            const sp = get(c.source);
            const tp = get(c.target);
            if (!sp || !tp) return null;
            if (
              !Number.isFinite(sp.x) || !Number.isFinite(sp.y) ||
              !Number.isFinite(tp.x) || !Number.isFinite(tp.y)
            ) return null;
            const pts = elbow(sp.x, sp.y, tp.x, tp.y);
            const color = typeof c.color === "string" ? c.color : MUTED;
            return (
              <polyline
                key={e.id}
                points={pts.map((p) => p.join(",")).join(" ")}
                fill="none"
                stroke={color}
                strokeWidth={0.14}
                strokeLinejoin="round"
                strokeLinecap="round"
                opacity={0.85}
              />
            );
          })}
      </svg>
    </div>
  );
}
