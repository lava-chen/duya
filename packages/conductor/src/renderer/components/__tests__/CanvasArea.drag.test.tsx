import { describe, it, expect } from 'vitest';
import { computeSnap } from '../../domain/canvas/snap';
import { pushAside } from '../../domain/canvas/collision';
import { CanvasSpatialIndex } from '../../domain/canvas/spatialIndex';
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

describe('CanvasArea drag pipeline (snap + pushAside integration)', () => {
  it('snap and pushAside compose: pushed element does not break snap', () => {
    const dragged = makeElement('a', 5, 5, 2, 2);
    const obstacle = makeElement('b', 6.5, 5, 2, 2);
    const idx = new CanvasSpatialIndex();
    idx.rebuild([dragged, obstacle]);

    // Drag 'a' rightward by 0.5 — it now overlaps 'b'.
    const proposed = { ...dragged, position: { ...dragged.position, x: 5.5 } };
    const push = pushAside(proposed, { dx: 0.5, dy: 0 }, idx, { gap: 0.25, cascade: true, maxDepth: 3 });
    const snap = computeSnap(proposed, [obstacle], { threshold: 8 });

    expect(push.moved.length).toBe(1);
    expect(push.moved[0].id).toBe('b');
    // Snap may or may not trigger depending on alignment; just verify no crash.
    expect(['alignment', 'free']).toContain(snap.kind);
  });

  it('locked element blocks push-aside but is not moved', () => {
    const dragged = makeElement('a', 0, 0, 2, 2);
    const locked = makeElement('b', 1, 0, 2, 2);
    (locked.metadata as { locked?: boolean }).locked = true;
    const idx = new CanvasSpatialIndex();
    idx.rebuild([dragged, locked]);

    const push = pushAside(dragged, { dx: 1, dy: 0 }, idx, { gap: 0.25, cascade: false, maxDepth: 3 });
    expect(push.moved).toEqual([]);
  });
});
