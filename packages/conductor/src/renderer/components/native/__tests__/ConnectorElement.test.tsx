// @vitest-environment jsdom
/**
 * ConnectorElement.test.tsx — DOM assertions for the Batch 1 connector
 * style extensions (strokeStyle / arrowStart / arrowEnd).
 *
 * The store is mocked to provide the source + target node positions so
 * the connector path can be computed. We assert attributes on the
 * visible <path> element (the second path in the <g>; the first is the
 * transparent hit target).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render } from '@testing-library/react';
import type { CanvasElement } from '../../../types/conductor';
import {
  GRID_PX,
  orthogonalizeElbowPoints,
} from '../../../domain/canvas/connector-renderer';

const mocks = vi.hoisted(() => ({
  storeState: {
    elements: [] as CanvasElement[],
    selectedElementId: null as string | null,
  },
}));

vi.mock('../../../stores/conductor-store', () => ({
  useConductorStore: (selector: (s: typeof mocks.storeState) => unknown) =>
    selector(mocks.storeState),
  // connector-renderer.ts imports getAbsolutePosition to resolve parent
  // offsets. Test elements have no parentId, so return position as-is.
  getAbsolutePosition: (node: { position: { x: number; y: number } }) => ({
    x: node.position.x,
    y: node.position.y,
  }),
}));

import {
  ConnectorElement,
  getComputedConnectorData,
  resolveConnectorRoutingMode,
} from '../ConnectorElement';

function makeNode(id: string, x: number, y: number): CanvasElement {
  return {
    id,
    canvasId: 'canvas-1',
    elementKind: 'native/sticky',
    position: { x, y, w: 3, h: 3, zIndex: 0, rotation: 0 },
    config: { text: id },
    state: 'idle',
    dataVersion: 0,
    createdAt: 0,
    updatedAt: 0,
    vizSpec: null,
    sourceCode: null,
    permissions: { agentCanRead: true, agentCanWrite: true, agentCanDelete: true },
    metadata: { label: '', tags: [], createdBy: 'user' },
  };
}

function makeConnector(
  id: string,
  sourceId: string,
  targetId: string,
  styleConfig: Record<string, unknown> = {},
): CanvasElement {
  return {
    id,
    canvasId: 'canvas-1',
    elementKind: 'native/connector',
    position: { x: 0, y: 0, w: 0, h: 0, zIndex: 0, rotation: 0 },
    config: {
      source: { nodeId: sourceId, anchorId: 'center' },
      target: { nodeId: targetId, anchorId: 'center' },
      routingMode: 'curve',
      curvature: 0.4,
      ...styleConfig,
    },
    state: 'idle',
    dataVersion: 0,
    createdAt: 0,
    updatedAt: 0,
    vizSpec: null,
    sourceCode: null,
    permissions: { agentCanRead: true, agentCanWrite: true, agentCanDelete: true },
    metadata: { label: '', tags: [], createdBy: 'user' },
  };
}

/**
 * Returns the visible <path> inside the rendered connector <g>.
 * The first path in the group is the transparent hit target; the
 * second is the visible stroke. We scope to `g > path` to exclude the
 * marker path inside <defs>.
 */
function getVisiblePath(container: HTMLElement): SVGPathElement {
  const paths = container.querySelectorAll('g > path');
  expect(paths.length).toBeGreaterThanOrEqual(2);
  return paths[1] as SVGPathElement;
}

describe('ConnectorElement — strokeStyle / lineWidth / arrows', () => {
  beforeEach(() => {
    mocks.storeState.selectedElementId = null;
    mocks.storeState.elements = [
      makeNode('src', 100, 100),
      makeNode('tgt', 400, 100),
    ];
  });

  it('dashed strokeStyle uses a spacious rounded rhythm', () => {
    mocks.storeState.elements = [
      makeNode('src', 100, 100),
      makeNode('tgt', 400, 100),
      makeConnector('c1', 'src', 'tgt', { strokeStyle: 'dashed' }),
    ];
    const { container } = render(<ConnectorElement element={mocks.storeState.elements[2]} />);
    const path = getVisiblePath(container);
    expect(path.getAttribute('stroke-dasharray')).toBe('10 7');
  });

  it('dotted strokeStyle uses round-cap dots', () => {
    mocks.storeState.elements = [
      makeNode('src', 100, 100),
      makeNode('tgt', 400, 100),
      makeConnector('c1', 'src', 'tgt', { strokeStyle: 'dotted' }),
    ];
    const { container } = render(<ConnectorElement element={mocks.storeState.elements[2]} />);
    const path = getVisiblePath(container);
    expect(path.getAttribute('stroke-dasharray')).toBe('1 7');
  });

  it('solid strokeStyle (default) has no stroke-dasharray', () => {
    mocks.storeState.elements = [
      makeNode('src', 100, 100),
      makeNode('tgt', 400, 100),
      makeConnector('c1', 'src', 'tgt', { strokeStyle: 'solid' }),
    ];
    const { container } = render(<ConnectorElement element={mocks.storeState.elements[2]} />);
    const path = getVisiblePath(container);
    expect(path.getAttribute('stroke-dasharray')).toBeNull();
  });

  it('undefined strokeStyle defaults to solid (no dasharray)', () => {
    mocks.storeState.elements = [
      makeNode('src', 100, 100),
      makeNode('tgt', 400, 100),
      makeConnector('c1', 'src', 'tgt'),
    ];
    const { container } = render(<ConnectorElement element={mocks.storeState.elements[2]} />);
    const path = getVisiblePath(container);
    expect(path.getAttribute('stroke-dasharray')).toBeNull();
  });

  it('uses one fixed connector width even when legacy data contains lineWidth', () => {
    mocks.storeState.elements = [
      makeNode('src', 100, 100),
      makeNode('tgt', 400, 100),
      makeConnector('c1', 'src', 'tgt', { lineWidth: 4 }),
    ];
    const { container } = render(<ConnectorElement element={mocks.storeState.elements[2]} />);
    const path = getVisiblePath(container);
    // Not selected → stroke-width equals lineWidth exactly.
    expect(path.getAttribute('stroke-width')).toBe('3.5');
  });

  it('renders an integrated source arrow instead of an SVG marker', () => {
    mocks.storeState.elements = [
      makeNode('src', 100, 100),
      makeNode('tgt', 400, 100),
      makeConnector('c1', 'src', 'tgt', { arrowStart: true, arrowEnd: false }),
    ];
    const { container } = render(<ConnectorElement element={mocks.storeState.elements[2]} />);
    const path = getVisiblePath(container);
    expect(path.getAttribute('marker-start')).toBeNull();
    expect(path.getAttribute('marker-end')).toBeNull();
    expect(container.querySelector('[data-testid="connector-start-arrow"]')).toBeTruthy();
    expect(container.querySelector('[data-testid="connector-end-arrow"]')).toBeNull();
  });

  it('renders the default end arrow as integrated geometry with a butt line cap', () => {
    mocks.storeState.elements = [
      makeNode('src', 100, 100),
      makeNode('tgt', 400, 100),
      makeConnector('c1', 'src', 'tgt'),
    ];
    const { container } = render(<ConnectorElement element={mocks.storeState.elements[2]} />);
    const path = getVisiblePath(container);
    // arrowEnd defaults to true when unset.
    expect(path.getAttribute('marker-end')).toBeNull();
    expect(path.getAttribute('marker-start')).toBeNull();
    expect(path.getAttribute('stroke-linecap')).toBe('butt');
    expect(container.querySelector('[data-testid="connector-end-arrow"]')).toBeTruthy();
  });

  it('stops the visible line at the base of its target arrow', () => {
    const source = makeNode('source', 0, 0);
    const target = makeNode('target', 0, 5);
    const connector = makeConnector('connector', source.id, target.id, {
      source: { nodeId: source.id, anchorId: 'bottom' },
      target: { nodeId: target.id, anchorId: 'top' },
    });
    mocks.storeState.elements = [source, target, connector];

    const computed = getComputedConnectorData(connector, [source, target, connector], source.position, target.position);
    const { container } = render(<ConnectorElement element={connector} />);
    const line = getVisiblePath(container);
    const arrow = container.querySelector('[data-testid="connector-end-arrow"]');

    expect(computed?.tgtPoint).toEqual({ x: 120, y: 400 });
    expect(line.getAttribute('d')).toContain('120 389.5');
    expect(arrow?.getAttribute('d')).toContain('M 120 400');
  });

  it('supports distinct start and end marker styles', () => {
    mocks.storeState.elements = [
      makeNode('src', 100, 100),
      makeNode('tgt', 400, 100),
      makeConnector('c1', 'src', 'tgt', { startMarker: 'circle', endMarker: 'diamond' }),
    ];
    const { container } = render(<ConnectorElement element={mocks.storeState.elements[2]} />);
    const path = getVisiblePath(container);
    expect(path.getAttribute('marker-start')).toBe('url(#connector-marker-c1-circle)');
    expect(path.getAttribute('marker-end')).toBe('url(#connector-marker-c1-diamond)');
  });

  it('renders connector label text at the route midpoint', () => {
    mocks.storeState.elements = [
      makeNode('src', 100, 100),
      makeNode('tgt', 400, 100),
      makeConnector('c1', 'src', 'tgt', { label: 'Depends on' }),
    ];
    const { getByText } = render(<ConnectorElement element={mocks.storeState.elements[2]} />);
    expect(getByText('Depends on')).toBeTruthy();
  });

  it('does not move one legacy endpoint because a peer connector exists', () => {
    const sourceA = makeNode('source-a', 100, 80);
    const sourceB = makeNode('source-b', 100, 180);
    const target = makeNode('target', 400, 120);
    const connectorA = makeConnector('connector-a', sourceA.id, target.id, {
      target: { nodeId: target.id, anchorId: 'left' },
    });
    const connectorB = makeConnector('connector-b', sourceB.id, target.id, {
      target: { nodeId: target.id, anchorId: 'left' },
    });
    const elements = [sourceA, sourceB, target, connectorA, connectorB];
    const first = getComputedConnectorData(connectorA, elements, sourceA.position, target.position);
    const second = getComputedConnectorData(connectorB, elements, sourceB.position, target.position);

    expect(first?.tgtPoint.x).toBe(second?.tgtPoint.x);
    expect(first?.tgtPoint.y).toBe(second?.tgtPoint.y);
  });

  it('defaults legacy connectors to orthogonal elbow routing', () => {
    expect(resolveConnectorRoutingMode({})).toBe('elbow');
    expect(resolveConnectorRoutingMode({ routingMode: 'curve' })).toBe('curve');
  });

  it('shows only the midpoint curve control until the midpoint is moved', () => {
    const source = makeNode('source', 0, 0);
    const target = makeNode('target', 8, 4);
    const connector = makeConnector('connector', source.id, target.id, {
      source: { kind: 'bound', nodeId: source.id, bindingPoint: { u: 0.5, v: 0.5 } },
      target: { kind: 'bound', nodeId: target.id, bindingPoint: { u: 0.5, v: 0.5 } },
    });
    mocks.storeState.selectedElementId = connector.id;
    mocks.storeState.elements = [source, target, connector];

    const { getByTestId, queryByTestId } = render(<ConnectorElement element={connector} />);

    expect(getByTestId('connector-curve-midpoint-control')).toBeTruthy();
    expect(queryByTestId('connector-curve-source-control')).toBeNull();
    expect(queryByTestId('connector-curve-target-control')).toBeNull();
  });

  it('shows two additional curve controls after the midpoint is moved', () => {
    const source = makeNode('source', 0, 0);
    const target = makeNode('target', 8, 4);
    const connector = makeConnector('connector', source.id, target.id, {
      source: { kind: 'bound', nodeId: source.id, bindingPoint: { u: 0.5, v: 0.5 } },
      target: { kind: 'bound', nodeId: target.id, bindingPoint: { u: 0.5, v: 0.5 } },
      curveMidpointOffset: { x: 0, y: -90 },
    });
    mocks.storeState.selectedElementId = connector.id;
    mocks.storeState.elements = [source, target, connector];

    const { getByTestId } = render(<ConnectorElement element={connector} />);

    expect(getByTestId('connector-curve-midpoint-control')).toBeTruthy();
    expect(getByTestId('connector-curve-source-control')).toBeTruthy();
    expect(getByTestId('connector-curve-target-control')).toBeTruthy();
  });

  it('repairs diagonal persisted points at the elbow render boundary', () => {
    const points = orthogonalizeElbowPoints([
      { x: 352, y: 566 },
      { x: 489, y: 949 },
    ]);

    expect(points).toEqual([
      { x: 352, y: 566 },
      { x: 489, y: 566 },
      { x: 489, y: 949 },
    ]);
    expect(points.every((point, index) => (
      index === 0 || point.x === points[index - 1].x || point.y === points[index - 1].y
    ))).toBe(true);
  });

  it('renders bound reference handles inside nodes and exposes terminal segment handles', () => {
    const source = makeNode('source', 0, 0);
    const target = makeNode('target', 5, 5);
    const connector = makeConnector('connector', source.id, target.id, {
      source: { kind: 'bound', nodeId: source.id, bindingPoint: { u: 0.25, v: 0.25 } },
      target: { kind: 'bound', nodeId: target.id, bindingPoint: { u: 0.75, v: 0.75 } },
      routingMode: 'elbow',
    });
    mocks.storeState.selectedElementId = connector.id;
    mocks.storeState.elements = [source, target, connector];

    const computed = getComputedConnectorData(connector, mocks.storeState.elements);
    const { container, getByTestId, getAllByTestId } = render(<ConnectorElement element={connector} />);
    const sourceHandle = getByTestId('connector-source-reference-handle');
    const handles = getAllByTestId('connector-elbow-handle');

    expect(sourceHandle.getAttribute('cx')).toBe('60');
    expect(sourceHandle.getAttribute('cy')).toBe('60');
    expect(computed?.srcPoint).toEqual({ x: 60, y: 0 });
    expect(handles[0].getAttribute('data-segment-index')).toBe('0');
    expect(handles.at(-1)?.getAttribute('data-segment-index')).toBe(String((computed?.elbowPoints?.length ?? 1) - 2));
    expect(container.textContent).not.toContain('NaN');
  });

  it('approaches a rebound right-edge endpoint from outside the target element', () => {
    const source = makeNode('source', 0, 0);
    const target = makeNode('target', 5, 5);
    const connector = makeConnector('connector', source.id, target.id, {
      source: { kind: 'bound', nodeId: source.id, bindingPoint: { u: 0.5, v: 0.9 } },
      target: { kind: 'bound', nodeId: target.id, bindingPoint: { u: 0.9, v: 0.5 } },
      routingMode: 'elbow',
    });
    const data = getComputedConnectorData(connector, [source, target, connector]);
    const points = data?.elbowPoints ?? [];
    const targetRight = (target.position.x + target.position.w) * GRID_PX;

    expect(data?.tgtPoint.x).toBe(targetRight);
    expect(points.at(-2)?.x).toBeGreaterThan(targetRight);
    expect(points.at(-3)?.x).toBe(points.at(-2)?.x);
  });

  it('approaches a rebound bottom-edge endpoint from below the target element', () => {
    const source = makeNode('source', 0, 0);
    const target = makeNode('target', 5, 5);
    const connector = makeConnector('connector', source.id, target.id, {
      source: { kind: 'bound', nodeId: source.id, bindingPoint: { u: 0.5, v: 0.9 } },
      target: { kind: 'bound', nodeId: target.id, bindingPoint: { u: 0.5, v: 0.9 } },
      routingMode: 'elbow',
    });
    const data = getComputedConnectorData(connector, [source, target, connector]);
    const points = data?.elbowPoints ?? [];
    const targetBottom = (target.position.y + target.position.h) * GRID_PX;

    expect(data?.tgtPoint.y).toBe(targetBottom);
    expect(points.at(-2)?.y).toBeGreaterThan(targetBottom);
    expect(points.at(-3)?.y).toBe(points.at(-2)?.y);
  });

  it('uses bottom-to-top attachment for vertically separated diagram layers', () => {
    const source = makeNode('source', 0, 0);
    const target = makeNode('target', 10, 5);
    const connector = makeConnector('connector', source.id, target.id, {
      source: { nodeId: source.id, anchorId: 'center' },
      target: { nodeId: target.id, anchorId: 'center' },
      routingMode: 'elbow',
    });
    const data = getComputedConnectorData(
      connector,
      [source, target, connector],
      source.position,
      target.position,
    );

    expect(data?.srcPoint.y).toBe((source.position.y + source.position.h) * GRID_PX);
    expect(data?.tgtPoint.y).toBe(target.position.y * GRID_PX);
    expect(data?.elbowPoints?.every((point, index, points) => (
      index === 0 || point.x === points[index - 1].x || point.y === points[index - 1].y
    ))).toBe(true);
  });

  it('uses one stable source port so related outgoing elbows share a trunk', () => {
    const source = makeNode('source', 100, 100);
    const targetA = makeNode('target-a', 80, 300);
    const targetB = makeNode('target-b', 180, 300);
    const connectorA = makeConnector('connector-a', source.id, targetA.id, {
      source: { nodeId: source.id, anchorId: 'bottom' },
      target: { nodeId: targetA.id, anchorId: 'top' },
      routingMode: 'elbow',
    });
    const connectorB = makeConnector('connector-b', source.id, targetB.id, {
      source: { nodeId: source.id, anchorId: 'bottom' },
      target: { nodeId: targetB.id, anchorId: 'top' },
      routingMode: 'elbow',
    });
    const elements = [source, targetA, targetB, connectorA, connectorB];
    const first = getComputedConnectorData(connectorA, elements, source.position, targetA.position);
    const second = getComputedConnectorData(connectorB, elements, source.position, targetB.position);

    expect(first?.srcPoint).toEqual(second?.srcPoint);
    expect(first?.elbowPoints?.[1]).toEqual(second?.elbowPoints?.[1]);
  });

  it('keeps nearby explicit source ports independent', () => {
    const source = makeNode('source', 100, 100);
    const targetA = makeNode('target-a', 80, 300);
    const targetB = makeNode('target-b', 180, 300);
    const connectorA = makeConnector('connector-a', source.id, targetA.id, {
      source: { nodeId: source.id, anchorId: 'bottom', edgePosition: 0.48 },
      target: { nodeId: targetA.id, anchorId: 'top' },
      routingMode: 'elbow',
    });
    const connectorB = makeConnector('connector-b', source.id, targetB.id, {
      source: { nodeId: source.id, anchorId: 'bottom', edgePosition: 0.52 },
      target: { nodeId: targetB.id, anchorId: 'top' },
      routingMode: 'elbow',
    });
    const elements = [source, targetA, targetB, connectorA, connectorB];
    const first = getComputedConnectorData(connectorA, elements, source.position, targetA.position);
    const second = getComputedConnectorData(connectorB, elements, source.position, targetB.position);

    expect(first?.srcPoint).not.toEqual(second?.srcPoint);
    expect(first?.elbowPoints?.[1]).not.toEqual(second?.elbowPoints?.[1]);
  });

  it('detours an elbow around an unrelated element with clearance', () => {
    const source = makeNode('source', 0, 0);
    const target = makeNode('target', 12, 0);
    const blocker = makeNode('blocker', 6, 0);
    const connector = makeConnector('connector', source.id, target.id, {
      source: { nodeId: source.id, anchorId: 'right' },
      target: { nodeId: target.id, anchorId: 'left' },
      routingMode: 'elbow',
    });
    const data = getComputedConnectorData(
      connector,
      [source, target, blocker, connector],
      source.position,
      target.position,
    );

    expect(data?.elbowPoints?.some((point) => point.y < 0 || point.y > 150)).toBe(true);
  });
});
