import { describe, it, expect } from 'vitest';
import { pushAside } from '../collision';
import { CanvasSpatialIndex } from '../spatialIndex';
import type { CanvasElement } from '../../../types/conductor';

function makeElement(id: string, x: number, y: number, w: number, h: number, locked = false): CanvasElement {
  return {
    id,
    canvasId: 'canvas-1',
    elementKind: 'native/sticky',
    position: { x, y, w, h, zIndex: 0, rotation: 0 },
    config: {},
    state: 'idle',
    dataVersion: 0,
    createdAt: 0,
    updatedAt: 0,
    vizSpec: null,
    sourceCode: null,
    permissions: { agentCanRead: true, agentCanWrite: true, agentCanDelete: true },
    metadata: { label: '', tags: [], createdBy: 'user' as const, locked },
  };
}

describe('pushAside', () => {
  it('returns empty moved list when no overlap', () => {
    const dragged = makeElement('a', 0, 0, 2, 2);
    const others = [makeElement('b', 10, 10, 2, 2)];
    const idx = new CanvasSpatialIndex();
    idx.rebuild([dragged, ...others]);
    const result = pushAside(dragged, { dx: 1, dy: 0 }, idx, { gap: 0.25, cascade: false, maxDepth: 3 });
    expect(result.moved).toEqual([]);
  });

  it('pushes one element right when dragged moves right into it', () => {
    // Dragged at (0,0) moving right (dx=1). Other at (1,0) overlapping.
    const dragged = makeElement('a', 0, 0, 2, 2);
    const other = makeElement('b', 1, 0, 2, 2);
    const idx = new CanvasSpatialIndex();
    idx.rebuild([dragged, other]);
    const result = pushAside(dragged, { dx: 1, dy: 0 }, idx, { gap: 0.25, cascade: false, maxDepth: 3 });
    expect(result.moved.length).toBe(1);
    expect(result.moved[0].id).toBe('b');
    expect(result.moved[0].toX).toBeGreaterThan(other.position.x);
  });

  it('does not push locked elements', () => {
    const dragged = makeElement('a', 0, 0, 2, 2);
    const locked = makeElement('b', 1, 0, 2, 2, true);
    const idx = new CanvasSpatialIndex();
    idx.rebuild([dragged, locked]);
    const result = pushAside(dragged, { dx: 1, dy: 0 }, idx, { gap: 0.25, cascade: false, maxDepth: 3 });
    expect(result.moved).toEqual([]);
  });

  it('pushes down when dragged moves down', () => {
    const dragged = makeElement('a', 0, 0, 2, 2);
    const other = makeElement('b', 0, 1, 2, 2);
    const idx = new CanvasSpatialIndex();
    idx.rebuild([dragged, other]);
    const result = pushAside(dragged, { dx: 0, dy: 1 }, idx, { gap: 0.25, cascade: false, maxDepth: 3 });
    expect(result.moved.length).toBe(1);
    expect(result.moved[0].id).toBe('b');
    expect(result.moved[0].toY).toBeGreaterThan(other.position.y);
  });

  it('cascade pushes secondary elements when cascade=true', () => {
    // a pushes b, b should push c if cascade is enabled.
    const dragged = makeElement('a', 0, 0, 2, 2);
    const middle = makeElement('b', 1, 0, 2, 2);
    const far = makeElement('c', 2, 0, 2, 2);
    const idx = new CanvasSpatialIndex();
    idx.rebuild([dragged, middle, far]);
    const result = pushAside(dragged, { dx: 1, dy: 0 }, idx, { gap: 0, cascade: true, maxDepth: 3 });
    const movedIds = result.moved.map(m => m.id);
    expect(movedIds).toContain('b');
    expect(movedIds).toContain('c');
  });

  it('respects maxDepth cap', () => {
    // Chain of 5 elements; maxDepth=2 should only push 2 levels.
    const els = [
      makeElement('a', 0, 0, 2, 2),
      makeElement('b', 1, 0, 2, 2),
      makeElement('c', 2, 0, 2, 2),
      makeElement('d', 3, 0, 2, 2),
      makeElement('e', 4, 0, 2, 2),
    ];
    const idx = new CanvasSpatialIndex();
    idx.rebuild(els);
    const result = pushAside(els[0], { dx: 1, dy: 0 }, idx, { gap: 0, cascade: true, maxDepth: 2 });
    // a is dragged (not in moved). b and c should be moved; d and e may or may not be.
    const movedIds = result.moved.map(m => m.id);
    expect(movedIds).toContain('b');
    // Depth cap means d and e are NOT pushed (only b and c within depth 2).
    expect(movedIds).not.toContain('d');
    expect(movedIds).not.toContain('e');
  });
});
