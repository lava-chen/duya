/**
 * element-detector.ts — heuristic SOM element detection (plan 454 §5 Task D).
 *
 * Phase 1 detector is intentionally simple:
 *   1. Take the focused entity from OSContextBridge (preferred — it's
 *      already labeled by the daemon with role + bounding box).
 *   2. Generate a single "primary action" element at a heuristic
 *      location (screen center) so the LLM always has at least one
 *      element to interact with.
 *
 * Phase 2 may add ML-based detection (YOLO / DETR). For now we keep
 * this purely functional and side-effect free so tests can assert
 * on the output.
 */

import type { FocusedEntity } from '@duya/computer-use-demo';
import type { ElementDescriptor } from '../recorder/events.js';
import type { SomElement } from '../backend/types.js';

/**
 * Minimal structural view of an accessibility-tree input (plan 519 §3.4).
 * Structurally compatible with the daemon's `UiaInfo.inputs` /
 * `MsaaInfo.inputs` — the wiring passes them straight through, so extra
 * fields on the source object are fine.
 */
export interface AxInput {
  /** Label / accessible name (e.g. "Sign In"). */
  name?: string;
  /** UIA ControlType (Edit / Button / ComboBox / TabItem / ...). */
  controlType?: string;
  /** Current value for text-bearing controls. */
  value?: string;
  isPassword?: boolean;
  urlCandidate?: string;
}

/** Accessibility-tree snapshots made available to the detector. */
export interface AxInfo {
  /** UIA sidecar inputs (Chromium / Electron reachable only here). */
  uia: readonly AxInput[];
  /** MSAA sidecar inputs (Qt / WPS / WeChat fallback). */
  msaa: readonly AxInput[];
}

export interface ElementDetectorInput {
  /** Image dimensions in CSS pixels. */
  width: number;
  height: number;
  /**
   * Currently focused entity. Optional — when absent the detector
   * returns just a screen-center fallback.
   */
  focusedEntity?: FocusedEntity | null;
  /**
   * Accessibility-tree labels (plan 519 §3.4). When present, each
   * UIA / MSAA input becomes a labeled SOM element tagged with an
   * `axSource`. AX elements carry no screen coordinates, so their bboxes
   * are a heuristic grid — prefer focused-entity markers for precision.
   */
  axInfo?: AxInfo | null;
  /**
   * Full-tree enumerated element descriptors WITH real bounding
   * rectangles (plan 562 Phase 2 — uia-probe `enumerate` output, later
   * the macOS AX helper). Takes priority over the `axInfo` heuristic
   * grid: when non-empty, grid elements are not emitted. Entries
   * without a usable `rect` are skipped (they cannot be placed).
   */
  axElements?: ElementDescriptor[] | null;
  /**
   * Which tree `axElements` came from — tags the emitted `axSource`.
   * Defaults to `'uia-tree'`; the macOS AX helper (plan 562 Phase 4)
   * passes `'ax-tree'`.
   */
  axElementsSource?: 'uia-tree' | 'ax-tree';
}

/**
 * Detect SOM elements.
 *
 * Returns 0..N elements. The contract is "best-effort — empty array
 * is valid when nothing is detectable". Tests should assert on
 * element count + indexes, never on shape variability.
 *
 * Sources, in priority order:
 *   1. focusedEntity   → one element at its bbox, `axSource: 'focused-entity'`
 *   2. axElements      → tree-enumerated elements at their REAL rects
 *                        (plan 562 Phase 2), `axSource: 'uia-tree'|'ax-tree'`;
 *                        when non-empty the AxInfo grid below is skipped
 *   3. UIA inputs      → labeled elements, `axSource: 'uia'`
 *   4. MSAA inputs     → labeled elements, `axSource: 'msaa'`
 *   5. centered fallback → one 'primary' element, `axSource: 'heuristic'`
 *      (only when none of the above produced anything)
 */
export function detectSomElements(input: ElementDetectorInput): SomElement[] {
  const elements: SomElement[] = [];
  let nextIndex = 1;

  // 1. focusedEntity → one element anchored at its bbox center.
  if (input.focusedEntity) {
    const bbox = extractBbox(input.focusedEntity);
    if (bbox) {
      elements.push({
        index: nextIndex++,
        bbox,
        label: focusedEntityLabel(input.focusedEntity),
        kind: kindFromFocusedEntity(input.focusedEntity),
        axSource: 'focused-entity',
      });
    }
  }

  // 2. Tree enumeration → elements with REAL coordinates. When it
  //    yields anything, the coordinate-less AxInfo grid is not emitted
  //    (the grid is the no-coordinate degradation path).
  const treeElements = axElementsToSom(
    input.axElements ?? null,
    input.axElementsSource ?? 'uia-tree',
    nextIndex,
  );
  if (treeElements.length > 0) {
    for (const el of treeElements) elements.push(el);
    nextIndex = lastIndex(elements) + 1;
    return elements;
  }

  // 3 + 4. AX tree → labeled elements filling an otherwise element-poor
  // capture. bboxes are a heuristic grid (AX carries no coordinates);
  // `axSource` lets the model weigh label confidence.
  const ax = input.axInfo;
  if (ax) {
    const uiaElements = axInputsToSom(
      ax.uia,
      'uia',
      input.width,
      input.height,
      nextIndex,
    );
    for (const el of uiaElements) elements.push(el);
    nextIndex = lastIndex(elements) + 1;

    const msaaElements = axInputsToSom(
      ax.msaa,
      'msaa',
      input.width,
      input.height,
      nextIndex,
    );
    for (const el of msaaElements) elements.push(el);
  }

  // 5. Primary action fallback — a centered square that always exists so
  //    the LLM has a "safe" target when nothing else is detectable.
  if (elements.length === 0 && input.width > 0 && input.height > 0) {
    const size = Math.min(120, Math.floor(input.width / 6));
    elements.push({
      index: nextIndex++,
      bbox: {
        x: Math.floor((input.width - size) / 2),
        y: Math.floor((input.height - size) / 2),
        w: size,
        h: size,
      },
      label: 'primary',
      kind: 'Unknown',
      axSource: 'heuristic',
    });
  }

  return elements;
}

/**
 * Map tree-enumerated descriptors (plan 562 Phase 2) to SOM elements at
 * their REAL bounding rectangles. Entries without a usable rect are
 * skipped — they cannot be placed, and the coordinate-less grid path
 * stays the degradation for that case.
 *
 * Labels use the raw accessible name (not the grid's `Type: 'name'`
 * wrapper): the matcher's L1 compares the recorded element name against
 * this label, so a raw name is what makes exact matches land on
 * real-coordinate candidates.
 */
function axElementsToSom(
  descriptors: ElementDescriptor[] | null,
  source: 'uia-tree' | 'ax-tree',
  startIndex: number,
): SomElement[] {
  if (!descriptors || descriptors.length === 0) return [];
  const result: SomElement[] = [];
  let index = startIndex;
  for (const d of descriptors) {
    const rect = d.rect;
    if (
      !rect ||
      rect.w <= 0 ||
      rect.h <= 0
    ) {
      continue;
    }
    const controlType = d.controlType ?? 'Control';
    const name = (d.name ?? '').trim();
    result.push({
      index: index++,
      bbox: { x: rect.x, y: rect.y, w: rect.w, h: rect.h },
      label: (name.length > 0 ? name : controlType).slice(0, 48),
      kind: kindFromControlType(controlType),
      axSource: source,
    });
  }
  return result;
}

/**
 * Map accessibility-tree inputs to labeled SOM elements. AX records carry
 * no screen coordinates, so bboxes are drawn as a left-aligned grid to
 * keep indexes stable and bounded. `axSource` tags the origin.
 */
function axInputsToSom(
  inputs: readonly AxInput[],
  source: 'uia' | 'msaa',
  width: number,
  height: number,
  startIndex: number,
): SomElement[] {
  const result: SomElement[] = [];
  const cap = Math.max(0, Math.floor((height - AX_GRID_MARGIN) / (AX_GRID_ROW_H + AX_GRID_GAP)));
  const n = Math.min(inputs.length, cap);
  for (let i = 0; i < n; i++) {
    const ax = inputs[i];
    if (!ax) continue;
    const controlType = ax.controlType ?? 'Control';
    const name = ax.name ?? ax.value ?? '';
    result.push({
      index: startIndex + i,
      bbox: axGridBbox(i, width),
      label: `${controlType}: '${name}'`.slice(0, 48),
      kind: kindFromControlType(controlType),
      axSource: source,
    });
  }
  return result;
}

/** Left-edge grid position for the i-th AX element. */
function axGridBbox(i: number, width: number): { x: number; y: number; w: number; h: number } {
  return {
    x: AX_GRID_MARGIN,
    y: AX_GRID_MARGIN + i * (AX_GRID_ROW_H + AX_GRID_GAP),
    w: Math.min(220, Math.max(80, Math.floor(width * 0.3))),
    h: AX_GRID_ROW_H,
  };
}

/** Grid metrics for AX label placement. */
const AX_GRID_MARGIN = 8;
const AX_GRID_ROW_H = 26;
const AX_GRID_GAP = 4;

/** Map a UIA ControlType to the extended SomElement kind union. */
function kindFromControlType(controlType: string): SomElement['kind'] {
  const t = controlType.toLowerCase();
  if (t === 'edit' || t === 'document') return t === 'edit' ? 'Edit' : 'Document';
  if (t === 'combobox') return 'ComboBox';
  if (t === 'button') return 'Button';
  if (t === 'tab' || t === 'tabitem') return 'Tab';
  if (t === 'text') return 'Text';
  if (t === 'image') return 'Image';
  return 'Input';
}

function lastIndex(elements: SomElement[]): number {
  const last = elements[elements.length - 1];
  return last ? last.index : 0;
}

/**
 * Pull a bounding box out of a FocusedEntity. The schema varies by
 * `kind` (Browser / Text / Form / etc.); we handle the common shapes.
 *
 * Returns null when the entity has no usable bbox. Callers must then
 * use the centered fallback.
 */
function extractBbox(entity: FocusedEntity): { x: number; y: number; w: number; h: number } | null {
  // The FocusedEntity shape is owned by @duya/computer-use-demo. We
  // read fields by name and tolerate missing ones.
  const raw = entity as unknown as Record<string, unknown>;

  // Common case: `bbox: { x, y, w, h }` directly on the entity.
  const direct = raw['bbox'];
  if (direct && typeof direct === 'object') {
    const bb = direct as Record<string, unknown>;
    if (isFiniteNumber(bb['x']) && isFiniteNumber(bb['y']) && isFiniteNumber(bb['w']) && isFiniteNumber(bb['h'])) {
      return { x: bb['x'], y: bb['y'], w: bb['w'], h: bb['h'] };
    }
  }

  // Browser form fields: { rect: { x, y, w, h } }.
  const rect = raw['rect'];
  if (rect && typeof rect === 'object') {
    const r = rect as Record<string, unknown>;
    if (isFiniteNumber(r['x']) && isFiniteNumber(r['y']) && isFiniteNumber(r['w']) && isFiniteNumber(r['h'])) {
      return { x: r['x'], y: r['y'], w: r['w'], h: r['h'] };
    }
  }

  return null;
}

function isFiniteNumber(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

/**
 * Produce a short label for a focused entity. Used as the marker
 * text in the overlay (in addition to the numeric index).
 */
function focusedEntityLabel(entity: FocusedEntity): string {
  const raw = entity as unknown as Record<string, unknown>;
  const kind = typeof raw['kind'] === 'string' ? raw['kind'] : 'Unknown';
  const name = typeof raw['name'] === 'string' ? raw['name'] : '';
  const role = typeof raw['role'] === 'string' ? raw['role'] : '';
  // Prefer the most specific descriptor available.
  if (role) return `${kind}:${role}`;
  if (name) return `${kind}:${name}`.slice(0, 24);
  return kind;
}

function kindFromFocusedEntity(entity: FocusedEntity): SomElement['kind'] {
  const raw = entity as unknown as Record<string, unknown>;
  const k = typeof raw['kind'] === 'string' ? raw['kind'] : '';
  if (k === 'Input' || k === 'Edit') return 'Input';
  if (k === 'Button') return 'Button';
  if (k === 'Text') return 'Text';
  if (k === 'Image') return 'Image';
  return 'Unknown';
}