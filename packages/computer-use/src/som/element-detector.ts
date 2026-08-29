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
import type { SomElement } from '../backend/types.js';

export interface ElementDetectorInput {
  /** Image dimensions in CSS pixels. */
  width: number;
  height: number;
  /**
   * Currently focused entity. Optional — when absent the detector
   * returns just a screen-center fallback.
   */
  focusedEntity?: FocusedEntity | null;
}

/**
 * Detect SOM elements.
 *
 * Returns 0..N elements. The contract is "best-effort — empty array
 * is valid when nothing is detectable". Tests should assert on
 * element count + indexes, never on shape variability.
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
      });
    }
  }

  // 2. Primary action fallback — a centered square that always
  //    exists so the LLM has a "safe" target when nothing else is
  //    detectable. Disabled in test fixtures via omitPrimaryAction.
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
    });
  }

  return elements;
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