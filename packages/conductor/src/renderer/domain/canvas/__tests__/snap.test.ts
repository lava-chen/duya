import { describe, it, expect } from 'vitest';
import { computeSnap } from '../snap';
import {
  getConnectorArrowGeometry,
  orthogonalizeElbowPoints,
  snapConnectorEdgePosition,
  snapElbowSegmentCoordinate,
} from '../connector-renderer';
import { getCanvasToolDragPayload } from '../toolbar-drag';
import { textContentSizeToGrid } from '../text-size';
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

describe('toolbar element creation', () => {
  it('creates a usable drag payload for every direct-create toolbar tool', () => {
    expect(getCanvasToolDragPayload('text')).toEqual({ type: 'text', extra: {} });
    expect(getCanvasToolDragPayload('table')).toEqual({ type: 'table', extra: {} });
    expect(getCanvasToolDragPayload('shape')).toMatchObject({
      type: 'shape',
      extra: { presentation: 'shape', shape: 'rect' },
    });
    expect(getCanvasToolDragPayload('link')).toEqual({
      type: 'link',
      extra: { linkType: 'url', title: 'Link', url: '' },
    });
  });

  it('keeps target- and file-dependent tools click-only', () => {
    expect(getCanvasToolDragPayload('connector')).toBeNull();
    expect(getCanvasToolDragPayload('media')).toBeNull();
  });
});

describe('text content sizing', () => {
  it('starts compact and grows with content within readable bounds', () => {
    expect(textContentSizeToGrid(1, 1)).toEqual({ w: 1.5, h: 0.4 });
    expect(textContentSizeToGrid(316.2, 74.2)).toEqual({ w: 317 / 80, h: 75 / 80 });
    expect(textContentSizeToGrid(2000, 2000)).toEqual({ w: 8, h: 15 });
  });
});

describe('connector direct-manipulation geometry', () => {
  it('clusters nearby ports onto one shared connector trunk', () => {
    const peers = [0.48, 0.52];

    expect(snapConnectorEdgePosition(0.48, peers, 320)).toBe(0.5);
    expect(snapConnectorEdgePosition(0.52, peers, 320)).toBe(0.5);
    expect(snapConnectorEdgePosition(0.72, peers, 320)).toBe(0.72);
  });

  it('repairs a diagonal persisted route into axis-aligned elbow segments', () => {
    const points = orthogonalizeElbowPoints([
      { x: 352, y: 566 },
      { x: 489, y: 949 },
    ]);

    expect(points).toEqual([
      { x: 352, y: 566 },
      { x: 489, y: 566 },
      { x: 489, y: 949 },
    ]);
  });

  it('snaps a dragged elbow segment exactly onto a nearby parallel route', () => {
    const result = snapElbowSegmentCoordinate(
      103,
      'horizontal',
      { x: 40, y: 103 },
      { x: 260, y: 103 },
      [[{ x: 0, y: 100 }, { x: 320, y: 100 }]],
      12,
    );

    expect(result).toEqual({ coordinate: 100, snapped: true });
  });

  it('does not snap parallel segments that are visually unrelated', () => {
    const result = snapElbowSegmentCoordinate(
      103,
      'horizontal',
      { x: 40, y: 103 },
      { x: 260, y: 103 },
      [[{ x: 500, y: 100 }, { x: 680, y: 100 }]],
      12,
    );

    expect(result).toEqual({ coordinate: 103, snapped: false });
  });

  it('builds a compact symmetric convex arrow base', () => {
    const geometry = getConnectorArrowGeometry(
      { x: 100, y: 50 },
      { x: 120, y: 50 },
    );

    expect(geometry.left.x).toBe(89.5);
    expect(geometry.right.x).toBe(89.5);
    expect([geometry.left.y, geometry.right.y].sort((a, b) => a - b)).toEqual([44.5, 55.5]);
  });

  it('keeps the arrow base perpendicular to the final connector segment', () => {
    const geometry = getConnectorArrowGeometry(
      { x: 100, y: 100 },
      { x: 100, y: 120 },
    );

    expect(geometry.left.y).toBe(89.5);
    expect(geometry.right.y).toBe(89.5);
    expect([geometry.left.x, geometry.right.x].sort((a, b) => a - b)).toEqual([94.5, 105.5]);
  });
});
