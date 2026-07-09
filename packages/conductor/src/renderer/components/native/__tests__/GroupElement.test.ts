/**
 * GroupElement.test.ts — pure-function tests for computeGroupBbox.
 *
 * computeGroupBbox is exported from GroupElement.tsx and computes the
 * pixel-space bounding box of a group from its member elements. The
 * heavy module dependencies (CanvasArea, conductor-store, conductor-ipc)
 * are mocked so the test loads only the pure function without pulling
 * in the full renderer component tree.
 *
 * Coordinate model: element.position.x/y/w/h are ALL grid units
 * (1 unit = GRID_PX = 80px), as enforced by domain/canvas/units.ts and
 * FreeformLayer. computeGroupBbox converts them to pixel coordinates and
 * adds FRAME_PADDING_PX (12) on every side.
 */
import { describe, it, expect, vi } from 'vitest';
import type { CanvasElement } from '../../../types/conductor';

// Mock the heavy dependencies so importing GroupElement.tsx does not
// pull in the full component tree. Paths are relative to this test file.
vi.mock('../../../stores/conductor-store', () => ({
  useConductorStore: vi.fn(),
}));

vi.mock('../../../ipc/conductor-ipc', () => ({
  executeAction: vi.fn(),
}));

vi.mock('../../CanvasArea', () => ({
  canvasTransformState: { panX: 0, panY: 0, zoom: 1 },
}));

import { computeGroupBbox } from '../GroupElement';

function makeElement(id: string, x: number, y: number, w: number, h: number): CanvasElement {
  return {
    id,
    canvasId: 'canvas-1',
    elementKind: 'native/sticky',
    position: { x, y, w, h, zIndex: 0, rotation: 0 },
    config: { text: id },
    state: 'idle',
    dataVersion: 0,
    createdAt: 0,
    updatedAt: 0,
    vizSpec: null,
    sourceCode: null,
    permissions: { agentCanRead: true, agentCanWrite: true, agentCanDelete: true },
    metadata: { label: '', tags: [], createdBy: 'user' },
  };
}

describe('computeGroupBbox — pure bounding box calculation', () => {
  it('returns null for an empty memberIds array', () => {
    expect(computeGroupBbox([], [])).toBeNull();
  });

  it('returns null when memberIds reference no existing elements', () => {
    const elements = [makeElement('a', 0, 0, 2, 2)];
    expect(computeGroupBbox(['missing'], elements)).toBeNull();
  });

  it('returns the member rect (plus padding) for a single member', () => {
    // position (1,1) grid → left=80, top=80; w=2,h=2 grid → 160x160px.
    // right=240, bottom=240. Padding=12 on each side.
    const elements = [makeElement('a', 1, 1, 2, 2)];
    const bbox = computeGroupBbox(['a'], elements);
    expect(bbox).toEqual({ x: 68, y: 68, w: 184, h: 184 });
  });

  it('computes the union of two members with padding', () => {
    // A: pos (1,1) grid → left=80, top=80, right=240, bottom=240
    // B: pos (4,4) grid → left=320, top=320, right=480, bottom=480
    // union: minX=80, minY=80, maxX=480, maxY=480
    // bbox: x=68, y=68, w=424, h=424
    const elements = [
      makeElement('a', 1, 1, 2, 2),
      makeElement('b', 4, 4, 2, 2),
    ];
    const bbox = computeGroupBbox(['a', 'b'], elements);
    expect(bbox).toEqual({ x: 68, y: 68, w: 424, h: 424 });
  });

  it('handles negative coordinates correctly', () => {
    // A: pos (-1,-1) grid → left=-80, top=-80, right=0, bottom=0 (w=1 → 80px)
    // B: pos (1,1) grid → left=80, top=80, right=160, bottom=160
    // union: minX=-80, minY=-80, maxX=160, maxY=160
    // bbox: x=-92, y=-92, w=264, h=264
    const elements = [
      makeElement('a', -1, -1, 1, 1),
      makeElement('b', 1, 1, 1, 1),
    ];
    const bbox = computeGroupBbox(['a', 'b'], elements);
    expect(bbox).toEqual({ x: -92, y: -92, w: 264, h: 264 });
  });

  it('ignores memberIds that do not resolve to elements', () => {
    // Only 'a' resolves; 'ghost' is silently skipped.
    // a: pos (2,2) grid → left=160, top=160, right=240, bottom=240
    // bbox: x=148, y=148, w=104, h=104
    const elements = [makeElement('a', 2, 2, 1, 1)];
    const bbox = computeGroupBbox(['a', 'ghost'], elements);
    expect(bbox).toEqual({ x: 148, y: 148, w: 104, h: 104 });
  });

  it('order of memberIds does not affect the bbox', () => {
    const elements = [
      makeElement('a', 0, 0, 1, 1),
      makeElement('b', 500, 500, 1, 1),
    ];
    const bbox1 = computeGroupBbox(['a', 'b'], elements);
    const bbox2 = computeGroupBbox(['b', 'a'], elements);
    expect(bbox1).toEqual(bbox2);
  });
});
