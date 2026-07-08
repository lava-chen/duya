import { describe, it, expect } from 'vitest';
import { zoomToFit, viewportAwarePack } from '../viewport';
import type { CanvasElement } from '../../../../types/conductor';

function makeElement(id: string, x: number, y: number, w: number, h: number, priority: 'high' | 'mid' | 'low' = 'mid'): CanvasElement {
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
    metadata: { label: '', tags: [], createdBy: 'user' as const, priority },
  };
}

describe('zoomToFit', () => {
  it('returns zoom=1 for empty elements', () => {
    const result = zoomToFit([], { viewport: { width: 40, height: 30 }, minZoom: 0.3, maxZoom: 1.5, padding: 1, respectMinSize: false });
    expect(result.zoom).toBe(1);
  });

  it('fits single element at zoom=1 when viewport is larger', () => {
    const els = [makeElement('a', 0, 0, 10, 5)];
    const result = zoomToFit(els, { viewport: { width: 40, height: 30 }, minZoom: 0.3, maxZoom: 1.5, padding: 1, respectMinSize: false });
    expect(result.zoom).toBeGreaterThan(0.99);
  });

  it('shrinks zoom when elements exceed viewport', () => {
    const els = [makeElement('a', 0, 0, 80, 60)];
    const result = zoomToFit(els, { viewport: { width: 40, height: 30 }, minZoom: 0.3, maxZoom: 1.5, padding: 1, respectMinSize: false });
    expect(result.zoom).toBeLessThan(1);
  });

  it('clamps to minZoom', () => {
    const els = [makeElement('a', 0, 0, 1000, 1000)];
    const result = zoomToFit(els, { viewport: { width: 40, height: 30 }, minZoom: 0.3, maxZoom: 1.5, padding: 1, respectMinSize: false });
    expect(result.zoom).toBeGreaterThanOrEqual(0.3);
  });

  it('clamps to maxZoom', () => {
    const els = [makeElement('a', 0, 0, 1, 1)];
    const result = zoomToFit(els, { viewport: { width: 40, height: 30 }, minZoom: 0.3, maxZoom: 1.5, padding: 1, respectMinSize: false });
    expect(result.zoom).toBeLessThanOrEqual(1.5);
  });
});

describe('viewportAwarePack', () => {
  it('places incoming element in viewport', () => {
    const existing = [makeElement('a', 0, 0, 5, 3)];
    const incoming = [makeElement('b', 0, 0, 3, 2)];
    const result = viewportAwarePack(existing, incoming, {
      viewport: { width: 40, height: 30 },
      gap: 0.25,
      preserveLocked: true,
      maxFreeRects: 32,
      priorityWeight: { high: 0, mid: 1, low: 2 },
    });
    expect(result.length).toBe(1);
    expect(result[0].id).toBe('b');
    // b should not overlap a.
    const b = result[0].position;
    expect(b.x).toBeGreaterThanOrEqual(5);
  });

  it('places high-priority elements first', () => {
    const high = makeElement('high', 0, 0, 5, 3, 'high');
    const low = makeElement('low', 0, 0, 5, 3, 'low');
    const result = viewportAwarePack([], [low, high], {
      viewport: { width: 40, height: 30 },
      gap: 0.25,
      preserveLocked: true,
      maxFreeRects: 32,
      priorityWeight: { high: 0, mid: 1, low: 2 },
    });
    // High should be at origin (placed first).
    const highResult = result.find(r => r.id === 'high')!;
    expect(highResult.position.x).toBe(0);
    expect(highResult.position.y).toBe(0);
  });
});
