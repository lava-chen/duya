import { describe, it, expect } from 'vitest';
import { CanvasSpatialIndex } from '../spatialIndex';
import type { CanvasElement } from '../../../types/conductor';

function makeElement(id: string, x: number, y: number, w: number, h: number): CanvasElement {
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
    metadata: { label: '', tags: [], createdBy: 'user' as const },
  };
}

describe('CanvasSpatialIndex', () => {
  it('returns null for an empty index', () => {
    const idx = new CanvasSpatialIndex();
    expect(idx.search({ minX: 0, minY: 0, maxX: 10, maxY: 10 })).toEqual([]);
    expect(idx.hitTest({ x: 5, y: 5 }, 0)).toBeNull();
  });

  it('rebuild inserts all elements', () => {
    const idx = new CanvasSpatialIndex();
    idx.rebuild([makeElement('a', 0, 0, 2, 2), makeElement('b', 5, 5, 2, 2)]);
    expect(idx.search({ minX: 0, minY: 0, maxX: 1, maxY: 1 }).map(e => e.id)).toEqual(['a']);
    expect(idx.search({ minX: 5, minY: 5, maxX: 6, maxY: 6 }).map(e => e.id)).toEqual(['b']);
  });

  it('upsert updates an existing element without duplicating', () => {
    const idx = new CanvasSpatialIndex();
    idx.rebuild([makeElement('a', 0, 0, 2, 2)]);
    idx.upsert(makeElement('a', 10, 10, 2, 2));
    expect(idx.search({ minX: 0, minY: 0, maxX: 1, maxY: 1 })).toEqual([]);
    expect(idx.search({ minX: 10, minY: 10, maxX: 11, maxY: 11 }).map(e => e.id)).toEqual(['a']);
  });

  it('remove deletes an element', () => {
    const idx = new CanvasSpatialIndex();
    idx.rebuild([makeElement('a', 0, 0, 2, 2)]);
    idx.remove('a');
    expect(idx.search({ minX: 0, minY: 0, maxX: 1, maxY: 1 })).toEqual([]);
  });

  it('hitTest returns topmost by zIndex when fuzzy padding overlaps multiple', () => {
    const idx = new CanvasSpatialIndex();
    const lowZ = makeElement('low', 0, 0, 2, 2);
    lowZ.position.zIndex = 1;
    const highZ = makeElement('high', 0, 0, 2, 2);
    highZ.position.zIndex = 5;
    idx.rebuild([lowZ, highZ]);
    expect(idx.hitTest({ x: 1, y: 1 }, 0)?.id).toBe('high');
  });

  it('hitTest with fuzzyPadding hits elements near the point', () => {
    const idx = new CanvasSpatialIndex();
    idx.rebuild([makeElement('a', 5, 5, 2, 2)]);
    expect(idx.hitTest({ x: 3, y: 6 }, 2)?.id).toBe('a');
    expect(idx.hitTest({ x: 3, y: 6 }, 1)).toBeNull();
  });
});
