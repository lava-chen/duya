import { describe, expect, it } from 'vitest';
import {
  autoSelectAttachment,
  computeBezierPath,
  computeClippedConnectorCurve,
  computeConnectorCurveGeometry,
  computeConnectorCurvePath,
  computeElbowRoutePoints,
  computeRoundedElbowPath,
  createBoundConnectorEndpoint,
  evaluateConnectorCurvePoint,
  getBezierControlPoints,
  getAnchorPosition,
  getPolylineMidpoint,
  moveElbowSegment,
  resolveConnectorEndpoint,
  snapElbowSegmentToAdjacentParallel,
} from '../connector-renderer';
import type { CanvasElement } from '../../../types/conductor';

function makeNode(): CanvasElement {
  return {
    id: 'node', canvasId: 'canvas', elementKind: 'native/sticky',
    position: { x: 10, y: 20, w: 8, h: 4, zIndex: 0, rotation: 0 },
    config: {}, state: 'idle', dataVersion: 0, createdAt: 0, updatedAt: 0,
    vizSpec: null, sourceCode: null,
    permissions: { agentCanRead: true, agentCanWrite: true, agentCanDelete: true },
    metadata: { label: '', tags: [], createdBy: 'user' },
  };
}

describe('connector renderer geometry', () => {
  it('places an attachment continuously along the selected edge', () => {
    const node = makeNode();
    expect(getAnchorPosition(node, 'top', [node], 0.25)).toEqual({ x: 960, y: 1600 });
    expect(getAnchorPosition(node, 'right', [node], 0.75)).toEqual({ x: 1440, y: 1840 });
  });

  it('selects the nearest edge and preserves the pointer ratio along it', () => {
    const node = makeNode();
    const attachment = autoSelectAttachment({ x: 805, y: 1766 }, node, [node]);
    expect(attachment.anchorId).toBe('left');
    expect(attachment.edgePosition).toBeCloseTo(166 / 320, 4);
  });

  it('quantizes a bound reference and projects it perpendicularly to the nearest edge', () => {
    const node = makeNode();
    const endpoint = createBoundConnectorEndpoint({ x: 1003, y: 1683 }, node, [node]);
    expect(endpoint).toEqual({
      kind: 'bound',
      nodeId: 'node',
      bindingPoint: { u: 0.3125, v: 0.25 },
    });
    expect(resolveConnectorEndpoint(endpoint, [node])).toEqual({
      referencePoint: { x: 1000, y: 1680 },
      edgePoint: { x: 1000, y: 1600 },
      direction: 'up',
      edge: 'top',
      nodeId: 'node',
    });
  });

  it('keeps bound connector endpoints clear of their element edge', () => {
    const node = makeNode();
    const endpoint = createBoundConnectorEndpoint({ x: 1003, y: 1683 }, node, [node]);

    expect(resolveConnectorEndpoint(endpoint, [node], undefined, 6)?.edgePoint)
      .toEqual({ x: 1000, y: 1594 });
  });

  it('keeps free endpoints detached from canvas elements', () => {
    expect(resolveConnectorEndpoint(
      { kind: 'free', point: { x: 50, y: 70 } },
      [],
      { x: 200, y: 70 },
    )).toEqual({
      referencePoint: { x: 50, y: 70 },
      edgePoint: { x: 50, y: 70 },
      direction: 'right',
      edge: null,
      nodeId: null,
    });
  });

  it('moves terminal elbow segments with doglegs while preserving both endpoints', () => {
    const route = [
      { x: 0, y: 0 },
      { x: 80, y: 0 },
      { x: 80, y: 100 },
      { x: 180, y: 100 },
    ];
    const movedFirst = moveElbowSegment(route, 0, 'horizontal', 30);
    const movedLast = moveElbowSegment(route, 2, 'horizontal', 140);
    expect(movedFirst[0]).toEqual(route[0]);
    expect(movedFirst.at(-1)).toEqual(route.at(-1));
    expect(movedFirst.slice(0, 4)).toEqual([
      { x: 0, y: 0 },
      { x: 32, y: 0 },
      { x: 32, y: 30 },
      { x: 80, y: 30 },
    ]);
    expect(movedLast[0]).toEqual(route[0]);
    expect(movedLast.at(-1)).toEqual(route.at(-1));
    expect(movedLast.slice(-4)).toEqual([
      { x: 80, y: 140 },
      { x: 148, y: 140 },
      { x: 148, y: 100 },
      { x: 180, y: 100 },
    ]);
  });

  it('snaps a segment onto an adjacent parallel segment so simplification merges them', () => {
    const route = [
      { x: 0, y: 0 },
      { x: 80, y: 0 },
      { x: 80, y: 40 },
      { x: 160, y: 40 },
      { x: 160, y: 100 },
      { x: 220, y: 100 },
    ];
    const snap = snapElbowSegmentToAdjacentParallel(7, 'horizontal', route, 2, 12);
    const merged = moveElbowSegment(route, 2, 'horizontal', snap.coordinate);

    expect(snap).toEqual({ coordinate: 0, snapped: true });
    expect(merged).toEqual([
      { x: 0, y: 0 },
      { x: 160, y: 0 },
      { x: 160, y: 100 },
      { x: 220, y: 100 },
    ]);
  });

  it('builds an orthogonal elbow route with rounded corners', () => {
    const points = computeElbowRoutePoints(
      { x: 80, y: 120 },
      'right',
      { x: 420, y: 320 },
      'left',
    );

    expect(points.length).toBeGreaterThanOrEqual(4);
    for (let index = 0; index < points.length - 1; index += 1) {
      const current = points[index];
      const next = points[index + 1];
      expect(current.x === next.x || current.y === next.y).toBe(true);
    }
    const path = computeRoundedElbowPath(points, 14);
    expect(path).toContain('Q');
    expect(path).not.toContain('NaN');
  });

  it('routes mixed directions to the target stub from outside the element', () => {
    const points = computeElbowRoutePoints(
      { x: 100, y: 0 },
      'down',
      { x: 400, y: 300 },
      'right',
      undefined,
      32,
    );

    expect(points).toEqual([
      { x: 100, y: 0 },
      { x: 100, y: 32 },
      { x: 432, y: 32 },
      { x: 432, y: 300 },
      { x: 400, y: 300 },
    ]);
    const targetStub = points.at(-2);
    const approach = points.at(-3);
    expect(targetStub?.x).toBeGreaterThan(400);
    expect(approach?.x).toBe(targetStub?.x);
  });

  it('uses the outermost lane when both endpoints face the same direction', () => {
    const points = computeElbowRoutePoints(
      { x: 100, y: 0 },
      'down',
      { x: 400, y: 300 },
      'down',
      undefined,
      32,
    );

    expect(points).toEqual([
      { x: 100, y: 0 },
      { x: 100, y: 332 },
      { x: 400, y: 332 },
      { x: 400, y: 300 },
    ]);
    expect(points.at(-2)?.y).toBeGreaterThan(300);

    const obstacleLaneInsideTarget = computeElbowRoutePoints(
      { x: 100, y: 0 },
      'down',
      { x: 400, y: 300 },
      'down',
      undefined,
      32,
      280,
    );
    expect(obstacleLaneInsideTarget).toEqual(points);
  });

  it('keeps manual elbow waypoints while aligning the endpoint segments', () => {
    const points = computeElbowRoutePoints(
      { x: 50, y: 50 },
      'right',
      { x: 360, y: 250 },
      'left',
      [{ x: 140, y: 80 }, { x: 220, y: 80 }, { x: 220, y: 250 }],
    );
    expect(points[1].y).toBe(50);
    expect(points[points.length - 2].y).toBe(250);
    expect(getPolylineMidpoint(points)).toEqual(expect.objectContaining({ x: expect.any(Number), y: expect.any(Number) }));
  });

  it('treats one mixed-direction waypoint as a shared exterior lane', () => {
    const points = computeElbowRoutePoints(
      { x: 400, y: 0 },
      'down',
      { x: 200, y: 300 },
      'left',
      [{ x: 400, y: 180 }],
      40,
    );

    expect(points).toEqual([
      { x: 400, y: 0 },
      { x: 400, y: 40 },
      { x: 160, y: 40 },
      { x: 160, y: 300 },
      { x: 200, y: 300 },
    ]);
  });

  it('preserves an intentionally farther shared lane for sibling branches', () => {
    const upper = computeElbowRoutePoints(
      { x: 460, y: 100 },
      'down',
      { x: 220, y: 360 },
      'left',
      [{ x: 100, y: 360 }],
      40,
    );
    const lower = computeElbowRoutePoints(
      { x: 460, y: 100 },
      'down',
      { x: 220, y: 560 },
      'left',
      [{ x: 100, y: 560 }],
      40,
    );

    expect(upper.slice(1, 4)).toEqual([
      { x: 460, y: 140 },
      { x: 100, y: 140 },
      { x: 100, y: 360 },
    ]);
    expect(lower.slice(1, 4)).toEqual([
      { x: 460, y: 140 },
      { x: 100, y: 140 },
      { x: 100, y: 560 },
    ]);
  });

  it('uses endpoint-relative curve controls for editable paths', () => {
    const controls = getBezierControlPoints(
      { x: 20, y: 30 },
      'right',
      { x: 320, y: 190 },
      'left',
      0.4,
      { source: { x: 80, y: 40 }, target: { x: -60, y: -20 } },
    );
    expect(controls.source).toEqual({ x: 100, y: 70 });
    expect(controls.target).toEqual({ x: 260, y: 170 });
    expect(computeBezierPath(
      { x: 20, y: 30 },
      'right',
      { x: 320, y: 190 },
      'left',
      0.4,
      { source: { x: 80, y: 40 }, target: { x: -60, y: -20 } },
    )).toContain('C 100 70 260 170');
  });

  it('keeps the default curve straight between endpoint references and clips only element interiors', () => {
    const geometry = computeConnectorCurveGeometry(
      { x: 50, y: 50 },
      { x: 350, y: 250 },
    );
    const clipped = computeClippedConnectorCurve(
      geometry,
      { x: 0, y: 0, w: 100, h: 100 },
      { x: 300, y: 200, w: 100, h: 100 },
    );

    expect(geometry.activated).toBe(false);
    expect(geometry.midpoint).toEqual({ x: 200, y: 150 });
    expect(clipped.sourcePoint.x).toBeCloseTo(100, 3);
    expect(clipped.sourcePoint.y).toBeCloseTo(83.333, 3);
    expect(clipped.targetPoint.x).toBeCloseTo(300, 3);
    expect(clipped.targetPoint.y).toBeCloseTo(216.667, 3);
    expect(clipped.sourceArrowDirectionPoint).toEqual(geometry.source);
    expect(clipped.targetArrowDirectionPoint).toEqual(geometry.target);
    expect(clipped.path).toContain('C');
  });

  it('expands a moved midpoint into two smooth editable curve controls', () => {
    const geometry = computeConnectorCurveGeometry(
      { x: 0, y: 0 },
      { x: 300, y: 0 },
      { x: 0, y: -120 },
    );
    const path = computeConnectorCurvePath(geometry);

    expect(geometry.activated).toBe(true);
    expect(geometry.midpoint).toEqual({ x: 150, y: -120 });
    expect(evaluateConnectorCurvePoint(geometry, 0.25)).toEqual(geometry.sourceControl);
    expect(evaluateConnectorCurvePoint(geometry, 0.5)).toEqual(geometry.midpoint);
    expect(evaluateConnectorCurvePoint(geometry, 0.75)).toEqual(geometry.targetControl);
    expect(path.match(/C/g)).toHaveLength(4);
  });
});
