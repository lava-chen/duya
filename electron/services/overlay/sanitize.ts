/**
 * sanitize.ts — main-side structural validation for the
 * `overlay:show-elements` IPC payload (plan 562 Phase 3).
 *
 * Deliberately pure (no electron import) so the handler gate is unit
 * testable. This is a SHAPE check only — the semantic filter
 * (interactive whitelist + usable rect) is re-asserted inside the
 * overlay page itself, because the overlay channel may be fed from
 * anywhere and the page must never draw non-interactive elements
 * (plan 562 §5 缺口2 defense line).
 */

/** Hard cap — mirrors the probe's maxNodes default (plan 562 Phase 1). */
export const OVERLAY_MAX_ELEMENTS = 500;

/**
 * Validate an `overlay:show-elements` payload.
 *
 * Returns the element array (same references) when the payload is an
 * array of objects within the cap, or null for anything that is not —
 * a malformed payload is rejected, never partially drawn.
 */
export function sanitizeOverlayElements(payload: unknown): Record<string, unknown>[] | null {
  if (!Array.isArray(payload)) {
    return null;
  }
  if (payload.length > OVERLAY_MAX_ELEMENTS) {
    return null;
  }
  const out: Record<string, unknown>[] = [];
  for (const item of payload) {
    if (typeof item !== 'object' || item === null || Array.isArray(item)) {
      return null;
    }
    out.push(item as Record<string, unknown>);
  }
  return out;
}
