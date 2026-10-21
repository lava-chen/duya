/**
 * decide/describe.ts — state constructor for the decide channel
 * (plan 551 Phase 3, jev-browser "describe" step).
 *
 * jev-browser's 11 fixes were 8 describe gaps, not model gaps — so this
 * module computes EVERYTHING code can compute before a single question
 * is asked (design rules #3/#5): elements in human-visible label form,
 * code-computed metrics, repeated-element counts, and a diff against
 * the previous round. The model never compares raw lists; it reads the
 * digests.
 *
 * Pure module: CaptureResult in, PageState out. Fixture-testable with
 * no backend, no network.
 */

import type { CaptureResult } from '../backend/types.js';

/**
 * Cardinality cap mirrored from the decision API. A page with more
 * elements is described with the FIRST 255 in stable page order and
 * `metrics.truncated = true`; the controller treats a truncated page as
 * honest uncertainty rather than pretending full coverage (official
 * guidance: higher cardinality wants a two-stage score→choice flow).
 */
export const MAX_DESCRIBED_ELEMENTS = 255;

export interface DescribedElement {
  /** SOM index (1-based, stable page order). */
  index: number;
  /** Center in logical screen pixels — lets the model reason about position. */
  x: number;
  y: number;
  /** Human-visible label text. */
  label: string;
  /** Heuristic/accessibility category. */
  kind?: string;
  /** Where the metadata came from (uia/msaa labels are trustworthy). */
  axSource?: string;
}

export interface PageMetrics {
  elementCount: number;
  /** Total characters of visible label text on the page. */
  labelTextChars: number;
  /** kind → count. */
  kindCounts: Record<string, number>;
  /** True when the page had more elements than MAX_DESCRIBED_ELEMENTS. */
  truncated: boolean;
}

/** Diff against the previous round, computed in code — never asked of the model. */
export interface PageChange {
  appeared: number[];
  disappeared: number[];
  /** Same index whose center moved more than MOVED_THRESHOLD_PX. */
  moved: number[];
}

export interface PageState {
  elements: DescribedElement[];
  metrics: PageMetrics;
  /** Labels appearing more than once (duplicate buttons, list rows). */
  repeatedElements: Array<{ label: string; count: number }>;
  /** Null on the first round. */
  lastChange: PageChange | null;
  capturedAt: string;
}

const MOVED_THRESHOLD_PX = 8;

function center(el: { bbox: { x: number; y: number; w: number; h: number } }): { x: number; y: number } {
  return { x: Math.round(el.bbox.x + el.bbox.w / 2), y: Math.round(el.bbox.y + el.bbox.h / 2) };
}

function diffPage(current: DescribedElement[], prev: DescribedElement[]): PageChange {
  const prevByIndex = new Map(prev.map((el) => [el.index, el]));
  const currByIndex = new Map(current.map((el) => [el.index, el]));
  const appeared: number[] = [];
  const disappeared: number[] = [];
  const moved: number[] = [];
  for (const el of current) {
    const before = prevByIndex.get(el.index);
    if (!before) {
      appeared.push(el.index);
    } else if (Math.abs(before.x - el.x) > MOVED_THRESHOLD_PX || Math.abs(before.y - el.y) > MOVED_THRESHOLD_PX) {
      moved.push(el.index);
    }
  }
  for (const el of prev) {
    if (!currByIndex.has(el.index)) disappeared.push(el.index);
  }
  return { appeared, disappeared, moved };
}

/** Build the structured page state for one decide round. */
export function describePage(capture: CaptureResult, prev?: PageState): PageState {
  const all = capture.elements;
  const kept = all.slice(0, MAX_DESCRIBED_ELEMENTS);

  const elements: DescribedElement[] = kept.map((el) => {
    const c = center(el);
    const described: DescribedElement = {
      index: el.index,
      x: c.x,
      y: c.y,
      label: el.label,
    };
    if (el.kind) described.kind = el.kind;
    if (el.axSource) described.axSource = el.axSource;
    return described;
  });

  const kindCounts: Record<string, number> = {};
  let labelTextChars = 0;
  const labelCounts = new Map<string, number>();
  for (const el of elements) {
    labelTextChars += el.label.length;
    const kind = el.kind ?? 'Unknown';
    kindCounts[kind] = (kindCounts[kind] ?? 0) + 1;
    const key = el.label.trim().toLowerCase();
    if (key) labelCounts.set(key, (labelCounts.get(key) ?? 0) + 1);
  }
  const repeatedElements: Array<{ label: string; count: number }> = [];
  for (const el of elements) {
    const key = el.label.trim().toLowerCase();
    const count = key ? (labelCounts.get(key) ?? 0) : 0;
    if (count > 1) {
      repeatedElements.push({ label: el.label, count });
      labelCounts.delete(key);
    }
  }

  const state: PageState = {
    elements,
    metrics: {
      elementCount: all.length,
      labelTextChars,
      kindCounts,
      truncated: all.length > MAX_DESCRIBED_ELEMENTS,
    },
    repeatedElements,
    lastChange: prev ? diffPage(elements, prev.elements) : null,
    capturedAt: capture.capturedAt,
  };
  return state;
}

/**
 * Compact, model-facing projection of a PageState: labels with indexes
 * in page order, the code-computed digests, and the caller's task.
 * Everything the fan-out questions reference lives here (rule #3:
 * options by index, objects in state).
 */
export function pageStateToDecisionState(task: string, page: PageState, values?: readonly string[]): Record<string, unknown> {
  const state: Record<string, unknown> = {
    task,
    elements: page.elements.map(
      (el) => `#${el.index} [${el.kind ?? 'Unknown'}] "${el.label}" at (${el.x},${el.y})`,
    ),
    metrics: page.metrics,
    repeated_elements: page.repeatedElements,
    last_change: page.lastChange,
  };
  if (values && values.length > 0) state.values = values;
  return state;
}
