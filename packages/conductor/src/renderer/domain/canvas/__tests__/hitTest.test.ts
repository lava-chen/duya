import { describe, it, expect } from 'vitest';
import { hitTest } from '../hitTest';
import { CanvasSpatialIndex } from '../spatialIndex';
import type { CanvasElement } from '../../../types/conductor';

function makeElement(id: string, x: number, y: number, w: number, h: number, zIndex = 0): CanvasElement {
  return {
    id,
    canvasId: 'canvas-1',
    elementKind: 'native/sticky',
    position: { x, y, w, h, zIndex, rotation: 0 },
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

describe('hitTest', () => {
  it('returns null when no elements', () => {
    const idx = new CanvasSpatialIndex();
    expect(hitTest({ x: 5, y: 5 }, idx, { fuzzyPadding: 6 })).toBeNull();
  });

  it('hits an element at the point', () => {
    const idx = new CanvasSpatialIndex();
    idx.rebuild([makeElement('a', 0, 0, 4, 3)]);
    expect(hitTest({ x: 2, y: 1 }, idx, { fuzzyPadding: 6 })).toBe('a');
  });

  it('respects fuzzy padding outside the element rect', () => {
    const idx = new CanvasSpatialIndex();
    idx.rebuild([makeElement('a', 5, 5, 2, 2)]);
    expect(hitTest({ x: 4, y: 6 }, idx, { fuzzyPadding: 1 })).toBe('a');
    expect(hitTest({ x: 4, y: 6 }, idx, { fuzzyPadding: 0 })).toBeNull();
  });

  it('returns topmost by zIndex', () => {
    const idx = new CanvasSpatialIndex();
    idx.rebuild([
      makeElement('low', 0, 0, 4, 3, 1),
      makeElement('high', 0, 0, 4, 3, 5),
    ]);
    expect(hitTest({ x: 2, y: 1 }, idx, { fuzzyPadding: 0 })).toBe('high');
  });

  it('excludes ids in excludeIds', () => {
    const idx = new CanvasSpatialIndex();
    idx.rebuild([makeElement('a', 0, 0, 4, 3)]);
    expect(hitTest({ x: 2, y: 1 }, idx, { fuzzyPadding: 0, excludeIds: new Set(['a']) })).toBeNull();
  });
});
