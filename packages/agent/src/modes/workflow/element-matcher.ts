/**
 * element-matcher.ts — replay-time bridge from recorded element
 * descriptors to a FRESH SOM index (plan 556 Phase 4, design §4.7).
 *
 * A recorded workflow never carries a usable SOM index: `som:<n>` in a
 * converter-produced definition is a GLOBAL counter over the recording
 * session (converter.ts), while a SOM index is only meaningful inside
 * the capture that produced it (backend/types.ts: "a new capture
 * invalidates old indices"). Something has to translate between the
 * two, and that something is this module.
 *
 * Three layers, first hit wins:
 *
 *   L1  name ↔ SOM label exact match. Candidates are ranked by
 *       accessibility provenance (axSource uia/msaa beat
 *       focused-entity/heuristic), then by controlType agreement, then
 *       by the distance between the fresh bbox centre and the recorded
 *       click point — the design's "多命中取 rect 中心距录制坐标最近者".
 *       → confidence 'exact' → verification 'verified'
 *
 *   L2  positional fallback. The recorded point is projected into the
 *       fresh frame (frame-normalized when both frames are known,
 *       absolute otherwise) and the candidate either CONTAINS the
 *       projected point or sits within a fraction of the frame diagonal.
 *       → confidence 'approx' → verification 'unconfirmed'
 *
 *   L3  nothing matched. The caller routes the step through the gui
 *       node's existing `on_stuck: 'agent'` ladder — AI fallback is a
 *       framework capability, this module does not invent one.
 *       → confidence 'agent-fallback' → verification 'unconfirmed'
 *
 * Pure: no I/O, no clock, no randomness. `matchRecordedElement` never
 * throws and always returns a result — "no match" is a value, not an
 * exception, because the caller must keep running.
 *
 * Scope note (556 §7): matching is Windows-UIA-shaped (label/controlType
 * come from the probe) but the algorithm itself is platform-agnostic —
 * any backend that can populate `SomCandidate` works.
 */

import type { Bbox, ElementDescriptor } from '@duya/computer-use';

import { SOM_ELEMENT_RE } from './schema.js';

// ─── inputs ───

/**
 * The slice of a fresh capture's SOM element the matcher needs. Kept
 * structural (instead of importing `SomElement`) so fixtures and
 * non-Electron backends can build one without the computer-use build.
 */
export interface SomCandidate {
  /** 1-based index inside the capture that produced this element. */
  index: number;
  bbox: Bbox;
  label: string;
  kind?: string;
  axSource?: 'uia' | 'msaa' | 'focused-entity' | 'heuristic';
}

/** A capture frame — logical pixels, top-left origin. */
export interface MatchFrame {
  width: number;
  height: number;
  /** Display origin; defaults to 0 (primary display at 0,0). */
  x?: number;
  y?: number;
}

/** Recorded geometry a `som:<n>` annotation carries (converter.ts). */
export interface RecordedElementRef {
  element: ElementDescriptor;
  /** Recorded click point (logical screen px); absent for `type` refs. */
  point?: { x: number; y: number };
  /** Recorded frame, when the recorder managed to store one. */
  frame?: MatchFrame;
}

// ─── outputs ───

export type MatchLayer = 'L1' | 'L2' | 'none';

export type MatchConfidence = 'exact' | 'approx' | 'agent-fallback';

export interface MatchResult {
  /** Fresh SOM index, or null when nothing matched (L3). */
  somIndex: number | null;
  /** `som:<index>` ref the backend consumes; null on L3. */
  ref: string | null;
  confidence: MatchConfidence;
  layer: MatchLayer;
  /**
   * 552 verification annotation (plan 556 §4.7: "confidence 映射 552 的
   * verified/unconfirmed 标注"). exact → verified, everything else →
   * unconfirmed.
   */
  verification: 'verified' | 'unconfirmed';
  /** Human-readable reason — journal evidence and run-console text. */
  reason: string;
  /** The matched candidate (absent on L3), for evidence rendering. */
  matched?: SomCandidate;
}

export interface MatchOptions {
  /** Fresh capture frame; enables L2 frame normalization. */
  frame?: MatchFrame;
  /**
   * Maximum accepted L2 distance as a fraction of the fresh frame
   * diagonal. Defaults to {@link MAX_APPROX_DISTANCE_RATIO} (~264px on
   * a 1920×1080 frame — wide enough for a moved window, tight enough
   * that a random far-away element never wins).
   */
  maxDistanceRatio?: number;
}

/** L2 acceptance threshold, as a fraction of the frame diagonal. */
export const MAX_APPROX_DISTANCE_RATIO = 0.12;

const AX_SOURCE_RANK: Record<NonNullable<SomCandidate['axSource']>, number> = {
  uia: 0,
  msaa: 1,
  'focused-entity': 2,
  heuristic: 3,
};

// ─── entry point ───

/**
 * Resolve one recorded element reference against a fresh capture's SOM
 * elements. Total function — returns an L3 result instead of throwing
 * when nothing matches.
 */
export function matchRecordedElement(
  recorded: RecordedElementRef,
  candidates: readonly SomCandidate[],
  options: MatchOptions = {},
): MatchResult {
  const anchor = recordedAnchor(recorded);
  const name = normalizeLabel(recorded.element.name);

  if (candidates.length === 0) {
    return fallback('fresh capture published no SOM elements');
  }

  // ── L1: label identity ──
  if (name.length > 0) {
    const hits = candidates.filter((c) => normalizeLabel(c.label) === name);
    if (hits.length > 0) {
      const best = rankByName(hits, recorded, anchor);
      return {
        somIndex: best.index,
        ref: somRef(best.index),
        confidence: 'exact',
        layer: 'L1',
        verification: 'verified',
        reason:
          `L1 name "${truncate(name)}" matched SOM #${best.index}` +
          `${hits.length > 1 ? ` (${hits.length} candidates, nearest picked)` : ''}`,
        matched: best,
      };
    }
  }

  // ── L2: positional ──
  if (anchor) {
    const projected = projectPoint(anchor, recorded.frame, options.frame);
    const ratio = options.maxDistanceRatio ?? MAX_APPROX_DISTANCE_RATIO;
    const diagonal = diagonalOf(options.frame);
    const limit = diagonal === null ? null : diagonal * ratio;

    const containing = candidates.filter((c) => bboxContains(c.bbox, projected));
    if (containing.length > 0) {
      const best = nearestByCentre(containing, projected);
      return {
        somIndex: best.index,
        ref: somRef(best.index),
        confidence: 'approx',
        layer: 'L2',
        verification: 'unconfirmed',
        reason: `L2 point (${round(projected.x)}, ${round(projected.y)}) landed inside SOM #${best.index}`,
        matched: best,
      };
    }

    const nearest = nearestByCentre(candidates, projected);
    const distance = centreDistance(nearest.bbox, projected);
    // Without a frame we cannot normalize — accept the nearest only when
    // it is close in absolute terms (< 120px), so an unanchored fallback
    // never grabs an arbitrary element.
    const accepted = limit === null ? distance <= 120 : distance <= limit;
    if (accepted) {
      return {
        somIndex: nearest.index,
        ref: somRef(nearest.index),
        confidence: 'approx',
        layer: 'L2',
        verification: 'unconfirmed',
        reason:
          `L2 nearest SOM #${nearest.index} at ${round(distance)}px ` +
          (limit === null ? '(absolute, no frame)' : `(limit ${round(limit)}px)`),
        matched: nearest,
      };
    }
    return fallback(
      `no SOM element near the recorded position ` +
        `(${round(distance)}px away` +
        (limit === null ? ', absolute threshold 120px)' : `, limit ${round(limit)}px)`),
    );
  }

  return fallback(
    name.length > 0
      ? `no SOM label matched "${truncate(name)}" and the recording has no click point`
      : 'recording carries neither a usable element name nor a click point',
  );
}

/**
 * Build a candidate list from a raw capture result (defensive: a
 * backend may hand back malformed elements, and a bad element must
 * never abort a run).
 */
export function toSomCandidates(raw: unknown): SomCandidate[] {
  if (!Array.isArray(raw)) return [];
  const out: SomCandidate[] = [];
  for (const item of raw) {
    if (typeof item !== 'object' || item === null) continue;
    const el = item as Partial<SomCandidate>;
    if (typeof el.index !== 'number' || !Number.isFinite(el.index)) continue;
    const bbox = el.bbox as Bbox | undefined;
    if (
      !bbox ||
      typeof bbox.x !== 'number' ||
      typeof bbox.y !== 'number' ||
      typeof bbox.w !== 'number' ||
      typeof bbox.h !== 'number'
    ) {
      continue;
    }
    out.push({
      index: el.index,
      bbox,
      label: typeof el.label === 'string' ? el.label : '',
      ...(typeof el.kind === 'string' ? { kind: el.kind } : {}),
      ...(isAxSource(el.axSource) ? { axSource: el.axSource } : {}),
    });
  }
  return out;
}

/** True when `ref` is a well-formed `som:<n>` reference. */
export function isSomRef(ref: unknown): ref is string {
  return typeof ref === 'string' && SOM_ELEMENT_RE.test(ref);
}

// ─── ranking ───

/**
 * Rank L1 name hits: accessibility provenance first (a UIA name is real
 * metadata, a heuristic label is a guess), then controlType agreement,
 * then proximity to the recorded click point.
 */
function rankByName(
  hits: readonly SomCandidate[],
  recorded: RecordedElementRef,
  anchor: { x: number; y: number } | null,
): SomCandidate {
  const wantKind = normalizeLabel(recorded.element.controlType);
  return [...hits].sort((a, b) => {
    const rank = axRank(a) - axRank(b);
    if (rank !== 0) return rank;
    if (wantKind.length > 0) {
      const kind = kindAgreement(b, wantKind) - kindAgreement(a, wantKind);
      if (kind !== 0) return kind;
    }
    if (anchor) {
      return centreDistance(a.bbox, anchor) - centreDistance(b.bbox, anchor);
    }
    return a.index - b.index;
  })[0]!;
}

function axRank(candidate: SomCandidate): number {
  return candidate.axSource ? AX_SOURCE_RANK[candidate.axSource] : 4;
}

function kindAgreement(candidate: SomCandidate, wantKind: string): number {
  return candidate.kind && normalizeLabel(candidate.kind) === wantKind ? 1 : 0;
}

// ─── geometry ───

/** Recorded click point, falling back to the element rect's centre. */
function recordedAnchor(recorded: RecordedElementRef): { x: number; y: number } | null {
  if (recorded.point) return recorded.point;
  const rect = recorded.element.rect;
  if (!rect) return null;
  return { x: rect.x + rect.w / 2, y: rect.y + rect.h / 2 };
}

/**
 * Project a recorded screen point into the fresh frame. When both
 * frames are known the point is expressed as a normalized fraction of
 * the recording frame and re-expanded into the fresh one (handles
 * resolution / DPI / display-origin drift, which is the whole reason
 * L2 is "窗口归一化比例位置" and not "绝对坐标"). Without a recorded
 * frame, absolute coordinates are the best available guess.
 */
function projectPoint(
  point: { x: number; y: number },
  recordedFrame: MatchFrame | undefined,
  freshFrame: MatchFrame | undefined,
): { x: number; y: number } {
  if (!recordedFrame || !freshFrame) return point;
  if (recordedFrame.width <= 0 || recordedFrame.height <= 0) return point;
  const rx = recordedFrame.x ?? 0;
  const ry = recordedFrame.y ?? 0;
  const fx = freshFrame.x ?? 0;
  const fy = freshFrame.y ?? 0;
  return {
    x: fx + ((point.x - rx) / recordedFrame.width) * freshFrame.width,
    y: fy + ((point.y - ry) / recordedFrame.height) * freshFrame.height,
  };
}

function diagonalOf(frame: MatchFrame | undefined): number | null {
  if (!frame || frame.width <= 0 || frame.height <= 0) return null;
  return Math.hypot(frame.width, frame.height);
}

function bboxContains(bbox: Bbox, point: { x: number; y: number }): boolean {
  return (
    point.x >= bbox.x &&
    point.x <= bbox.x + bbox.w &&
    point.y >= bbox.y &&
    point.y <= bbox.y + bbox.h
  );
}

function centreDistance(bbox: Bbox, point: { x: number; y: number }): number {
  return Math.hypot(bbox.x + bbox.w / 2 - point.x, bbox.y + bbox.h / 2 - point.y);
}

function nearestByCentre(
  candidates: readonly SomCandidate[],
  point: { x: number; y: number },
): SomCandidate {
  let best = candidates[0]!;
  let bestDistance = centreDistance(best.bbox, point);
  for (const candidate of candidates.slice(1)) {
    const distance = centreDistance(candidate.bbox, point);
    if (distance < bestDistance) {
      best = candidate;
      bestDistance = distance;
    }
  }
  return best;
}

// ─── helpers ───

/**
 * Label comparison key. SOM labels come from UIA names (or a heuristic
 * extraction) and routinely carry trailing spaces and punctuation-ish
 * padding; the recorder's descriptor name comes from a different read
 * of the same property. Case + whitespace normalization is the only
 * tolerance applied — everything else would make L1 "fuzzy" and the
 * 'exact' confidence a lie.
 */
function normalizeLabel(value: string | undefined): string {
  return (value ?? '').replace(/\s+/g, ' ').trim().toLowerCase();
}

function somRef(index: number): string {
  return `som:${index}`;
}

function fallback(reason: string): MatchResult {
  return {
    somIndex: null,
    ref: null,
    confidence: 'agent-fallback',
    layer: 'none',
    verification: 'unconfirmed',
    reason: `L3 ${reason}`,
  };
}

function isAxSource(value: unknown): value is NonNullable<SomCandidate['axSource']> {
  return value === 'uia' || value === 'msaa' || value === 'focused-entity' || value === 'heuristic';
}

function truncate(value: string): string {
  return value.length > 60 ? `${value.slice(0, 57)}...` : value;
}

function round(value: number): number {
  return Math.round(value);
}
