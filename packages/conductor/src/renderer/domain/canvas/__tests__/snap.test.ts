import { describe, it, expect } from 'vitest';
import { computeSnap } from '../snap';
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

describe('computeSnap', () => {
  it('returns free when no other elements', () => {
    const dragged = makeElement('a', 5, 5, 2, 2);
    const result = computeSnap(dragged, [], { threshold: 8 });
    expect(result.kind).toBe('free');
    expect(result.x).toBe(5);
    expect(result.y).toBe(5);
    expect(result.guides).toEqual([]);
  });

  it('returns free when no alignment within threshold', () => {
    const dragged = makeElement('a', 20, 20, 2, 2);
    const others = [makeElement('b', 0, 0, 2, 2)];
    const result = computeSnap(dragged, others, { threshold: 8 });
    expect(result.kind).toBe('free');
  });

  it('snaps left-edge to other left-edge within threshold', () => {
    const dragged = makeElement('a', 5.1, 20, 2, 2);
    const others = [makeElement('b', 5, 0, 2, 2)];
    const result = computeSnap(dragged, others, { threshold: 8 });
    expect(result.kind).toBe('alignment');
    if (result.kind === 'alignment') {
      expect(result.x).toBe(5);
      expect(result.guides.length).toBeGreaterThan(0);
    }
  });

  it('snaps right-edge to other right-edge', () => {
    const dragged = makeElement('a', 10.1, 20, 2, 2);
    const others = [makeElement('b', 8, 0, 4, 2)];
    const result = computeSnap(dragged, others, { threshold: 8 });
    expect(result.kind).toBe('alignment');
    if (result.kind === 'alignment') {
      expect(result.x).toBe(10);
    }
  });

  it('snaps centerX to other centerX', () => {
    const dragged = makeElement('a', 4.2, 20, 4, 2);
    const others = [makeElement('b', 5, 0, 2, 2)];
    const result = computeSnap(dragged, others, { threshold: 8 });
    expect(result.kind).toBe('alignment');
    if (result.kind === 'alignment') {
      expect(result.x).toBe(4);
    }
  });

  it('snaps Y axis independently from X', () => {
    const dragged = makeElement('a', 30, 5.1, 2, 2);
    const others = [makeElement('b', 0, 5, 2, 2)];
    const result = computeSnap(dragged, others, { threshold: 8 });
    expect(result.kind).toBe('alignment');
    if (result.kind === 'alignment') {
      expect(result.x).toBe(30);
      expect(result.y).toBe(5);
    }
  });

  it('picks the closest alignment when multiple are within threshold', () => {
    const dragged = makeElement('a', 5.1, 20, 2, 2);
    const others = [makeElement('b', 5, 0, 2, 2), makeElement('c', 5.5, 0, 2, 2)];
    const result = computeSnap(dragged, others, { threshold: 8 });
    expect(result.kind).toBe('alignment');
    if (result.kind === 'alignment') {
      expect(result.x).toBe(5);
    }
  });
});
