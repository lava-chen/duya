import { describe, it, expect } from 'vitest';
import { computeSnap } from '../../domain/canvas/snap';
import type { CanvasElement } from '../../types/conductor';

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

describe('CanvasArea drag pipeline (snap-only movement)', () => {
  it('allows overlap without mutating the obstacle', () => {
    const dragged = makeElement('a', 5, 5, 2, 2);
    const obstacle = makeElement('b', 6.5, 5, 2, 2);
    const obstacleBefore = { ...obstacle.position };

    // Drag 'a' rightward by 0.5. Overlap is allowed and only the selected
    // element participates in alignment snapping.
    const proposed = { ...dragged, position: { ...dragged.position, x: 5.5 } };
    const snap = computeSnap(proposed, [obstacle], { threshold: 8 });

    expect(['alignment', 'free']).toContain(snap.kind);
    expect(obstacle.position).toEqual(obstacleBefore);
  });

  it('still exposes alignment guides while overlap remains permitted', () => {
    const dragged = makeElement('a', 0, 0, 2, 2);
    const peer = makeElement('b', 1, 0, 2, 2);
    const snap = computeSnap(dragged, [peer], { threshold: 8 });
    expect(snap.kind).toBe('alignment');
  });
});
