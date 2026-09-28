/**
 * Select useful UIA targets for the on-screen overlay. Accessibility trees
 * often contain several interactive nodes with identical or nested bounds;
 * showing every one makes the overlay unreadable and can hide the real target.
 */

const INTERACTIVE_CONTROL_TYPES = new Set([
  'button',
  'edit',
  'hyperlink',
  'checkbox',
  'radiobutton',
  'combobox',
  'tabitem',
  'menuitem',
  'slider',
  'listitem',
  'toggleswitch',
]);

export const OVERLAY_VISIBLE_ELEMENT_LIMIT = 36;

interface RectLike {
  x: number;
  y: number;
  w: number;
  h: number;
}

interface Candidate {
  element: Record<string, unknown>;
  index: number;
  rect: RectLike;
  area: number;
}

function rectOf(element: Record<string, unknown>): RectLike | null {
  const rect = element['rect'];
  if (typeof rect !== 'object' || rect === null || Array.isArray(rect)) return null;
  const value = rect as Record<string, unknown>;
  const { x, y, w, h } = value;
  if (
    typeof x !== 'number' || !Number.isFinite(x) ||
    typeof y !== 'number' || !Number.isFinite(y) ||
    typeof w !== 'number' || !Number.isFinite(w) || w <= 0 ||
    typeof h !== 'number' || !Number.isFinite(h) || h <= 0
  ) {
    return null;
  }
  return { x, y, w, h };
}

function intersectionArea(a: RectLike, b: RectLike): number {
  const width = Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x));
  const height = Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y));
  return width * height;
}

function isDuplicateOrContained(candidate: Candidate, kept: Candidate): boolean {
  const overlap = intersectionArea(candidate.rect, kept.rect);
  const smallerArea = Math.min(candidate.area, kept.area);
  return smallerArea > 0 && overlap / smallerArea >= 0.9;
}

/**
 * Return a compact list in UIA enumeration order. `overlayIndex` preserves
 * the original 1-based UIA index even when an overlapping entry is omitted.
 */
export function selectVisibleOverlayElements(
  elements: readonly Record<string, unknown>[],
  displayBounds: { width: number; height: number },
): Record<string, unknown>[] {
  const displayArea = displayBounds.width * displayBounds.height;
  if (!Number.isFinite(displayArea) || displayArea <= 0) return [];

  const candidates: Candidate[] = [];
  for (let index = 0; index < elements.length; index += 1) {
    const element = elements[index];
    if (!element || element['interactive'] === false) continue;
    const controlType = element['controlType'];
    if (typeof controlType !== 'string' || !INTERACTIVE_CONTROL_TYPES.has(controlType.toLowerCase())) continue;
    const rect = rectOf(element);
    if (!rect) continue;
    const area = rect.w * rect.h;
    // Large accessibility containers are poor click targets and usually
    // overlap many smaller controls. Keep the target-sized rectangles only.
    if (area / displayArea > 0.35) continue;
    candidates.push({ element, index, rect, area });
  }

  // Consider the most precise bounds first so a broad parent cannot hide its
  // smaller, actionable descendants. Stable ties retain UIA enumeration order.
  candidates.sort((a, b) => a.area - b.area || a.index - b.index);
  const kept: Candidate[] = [];
  for (const candidate of candidates) {
    if (kept.some((entry) => isDuplicateOrContained(candidate, entry))) continue;
    kept.push(candidate);
    if (kept.length >= OVERLAY_VISIBLE_ELEMENT_LIMIT) break;
  }

  return kept
    .sort((a, b) => a.index - b.index)
    .map(({ element, index }) => ({ ...element, overlayIndex: index + 1 }));
}
