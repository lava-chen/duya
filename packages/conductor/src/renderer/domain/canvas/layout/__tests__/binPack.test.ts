import { describe, it, expect } from 'vitest';
import { binPack } from '../binPack';
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

describe('binPack', () => {
  it('returns empty layout for no elements', () => {
    const result = binPack([], { viewport: { width: 40, height: 30 }, gap: 0.25, preserveLocked: true, maxFreeRects: 32 });
    expect(result).toEqual([]);
  });

  it('places single element at origin', () => {
    const els = [makeElement('a', 3, 2)];
    const result = binPack(els, { viewport: { width: 40, height: 30 }, gap: 0.25, preserveLocked: true, maxFreeRects: 32 });
    expect(result.length).toBe(1);
    expect(result[0]).toMatchObject({ id: 'a', position: { x: 0, y: 0, w: 3, h: 2 } });
  });

  it('places two elements side by side', () => {
    const els = [makeElement('a', 3, 2), makeElement('b', 3, 2)];
    const result = binPack(els, { viewport: { width: 40, height: 30 }, gap: 0.25, preserveLocked: true, maxFreeRects: 32 });
    expect(result.length).toBe(2);
    const a = result.find(r => r.id === 'a')!;
    const b = result.find(r => r.id === 'b')!;
    // b should be to the right of a (x > a.x + a.w)
    expect(b.position.x).toBeGreaterThanOrEqual(a.position.x + a.position.w);
  });

  it('wraps to next row when viewport width is exceeded', () => {
    const els = [makeElement('a', 20, 2), makeElement('b', 20, 2), makeElement('c', 20, 2)];
    const result = binPack(els, { viewport: { width: 40, height: 30 }, gap: 0.25, preserveLocked: true, maxFreeRects: 32 });
    const a = result.find(r => r.id === 'a')!;
    const b = result.find(r => r.id === 'b')!;
    const c = result.find(r => r.id === 'c')!;
    // a and b on row 0; c on row 1.
    expect(c.position.y).toBeGreaterThan(a.position.y);
  });

  it('skips locked elements when preserveLocked=true', () => {
    const locked = makeElement('locked', 3, 2);
    (locked.metadata as { locked?: boolean }).locked = true;
    locked.position = { x: 0, y: 0, w: 3, h: 2, zIndex: 0, rotation: 0 };
    const free = makeElement('free', 3, 2);
    const result = binPack([locked, free], { viewport: { width: 40, height: 30 }, gap: 0.25, preserveLocked: true, maxFreeRects: 32 });
    // Locked element keeps its original position.
    const lockedResult = result.find(r => r.id === 'locked')!;
    expect(lockedResult.position.x).toBe(0);
    expect(lockedResult.position.y).toBe(0);
    // Free element is placed elsewhere.
    const freeResult = result.find(r => r.id === 'free')!;
    expect(freeResult.position.x).toBeGreaterThanOrEqual(3);
  });

  it('preserves element w/h in the result', () => {
    const els = [makeElement('a', 5, 3)];
    const result = binPack(els, { viewport: { width: 40, height: 30 }, gap: 0.25, preserveLocked: true, maxFreeRects: 32 });
    expect(result[0].position.w).toBe(5);
    expect(result[0].position.h).toBe(3);
  });
});
