import { describe, it, expect } from 'vitest';
import { flowLayout } from '../flowLayout';
import type { CanvasElement } from '../../../../types/conductor';

function makeElement(id: string, w: number, h: number): CanvasElement {
  return {
    id,
    canvasId: 'canvas-1',
    elementKind: 'native/sticky',
    position: { x: 0, y: 0, w, h, zIndex: 0, rotation: 0 },
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

describe('flowLayout', () => {
  it('returns empty for no elements', () => {
    const result = flowLayout([], { viewport: { width: 40 }, gap: 0.25, rowAlign: 'start', preserveLocked: true });
    expect(result).toEqual([]);
  });

  it('places single element at origin', () => {
    const result = flowLayout([makeElement('a', 3, 2)], { viewport: { width: 40 }, gap: 0.25, rowAlign: 'start', preserveLocked: true });
    expect(result[0]).toMatchObject({ id: 'a', position: { x: 0, y: 0 } });
  });

  it('places elements left to right with gap', () => {
    const els = [makeElement('a', 3, 2), makeElement('b', 3, 2)];
    const result = flowLayout(els, { viewport: { width: 40 }, gap: 0.25, rowAlign: 'start', preserveLocked: true });
    const a = result.find(r => r.id === 'a')!;
    const b = result.find(r => r.id === 'b')!;
    expect(b.position.x).toBe(a.position.x + a.position.w + 0.25);
    expect(b.position.y).toBe(a.position.y);
  });

  it('wraps to next row when viewport width exceeded', () => {
    const els = [makeElement('a', 20, 2), makeElement('b', 20, 2), makeElement('c', 20, 2)];
    const result = flowLayout(els, { viewport: { width: 40 }, gap: 0.25, rowAlign: 'start', preserveLocked: true });
    const c = result.find(r => r.id === 'c')!;
    // c should be on the next row.
    expect(c.position.y).toBeGreaterThan(0);
    expect(c.position.x).toBe(0);
  });

  it('rowAlign=center centers elements within the row', () => {
    const els = [makeElement('a', 3, 2)];
    const result = flowLayout(els, { viewport: { width: 40 }, gap: 0.25, rowAlign: 'center', preserveLocked: true });
    // Single element centered: x = (40 - 3) / 2 = 18.5
    expect(result[0].position.x).toBeCloseTo(18.5, 1);
  });

  it('skips locked elements when preserveLocked=true', () => {
    const locked = makeElement('locked', 3, 2);
    (locked.metadata as { locked?: boolean }).locked = true;
    locked.position = { x: 10, y: 10, w: 3, h: 2, zIndex: 0, rotation: 0 };
    const result = flowLayout([locked, makeElement('free', 3, 2)], { viewport: { width: 40 }, gap: 0.25, rowAlign: 'start', preserveLocked: true });
    const lockedResult = result.find(r => r.id === 'locked')!;
    expect(lockedResult.position.x).toBe(10);
    expect(lockedResult.position.y).toBe(10);
  });
});
