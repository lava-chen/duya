/**
 * sanitize.test.ts — overlay:show-elements payload gate (plan 562 Phase 3).
 *
 * The IPC handler rejects anything that is not a bounded array of
 * objects; the semantic interactive filter lives in the overlay page
 * (renderer-side defense) and is intentionally NOT duplicated here —
 * this test pins the structural contract only.
 */

import { describe, it, expect } from 'vitest';

import { sanitizeOverlayElements, OVERLAY_MAX_ELEMENTS } from '../sanitize.js';

function element(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    name: 'Sign In',
    controlType: 'Button',
    rect: { x: 10, y: 20, w: 80, h: 32 },
    interactive: true,
    ...overrides,
  };
}

describe('sanitizeOverlayElements', () => {
  it('accepts an array of objects unchanged', () => {
    const payload = [element(), element({ controlType: 'Edit' })];
    const result = sanitizeOverlayElements(payload);
    expect(result).toHaveLength(2);
    expect(result?.[0]).toBe(payload[0]);
  });

  it('accepts an empty array (clearing via an empty draw is valid)', () => {
    expect(sanitizeOverlayElements([])).toEqual([]);
  });

  it('rejects a non-array payload', () => {
    expect(sanitizeOverlayElements(null)).toBeNull();
    expect(sanitizeOverlayElements(undefined)).toBeNull();
    expect(sanitizeOverlayElements({ elements: [] })).toBeNull();
    expect(sanitizeOverlayElements('[]')).toBeNull();
  });

  it('rejects an array containing a non-object entry', () => {
    expect(sanitizeOverlayElements([element(), null])).toBeNull();
    expect(sanitizeOverlayElements([element(), 'Button'])).toBeNull();
    expect(sanitizeOverlayElements([element(), 42])).toBeNull();
    // Arrays are objects but not valid element entries.
    expect(sanitizeOverlayElements([[element()]])).toBeNull();
  });

  it('rejects payloads above the element cap', () => {
    const many = Array.from({ length: OVERLAY_MAX_ELEMENTS + 1 }, () => element());
    expect(sanitizeOverlayElements(many)).toBeNull();
    expect(sanitizeOverlayElements(many.slice(0, OVERLAY_MAX_ELEMENTS))).toHaveLength(OVERLAY_MAX_ELEMENTS);
  });
});
