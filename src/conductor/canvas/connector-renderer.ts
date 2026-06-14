import { getAbsolutePosition } from "@/stores/conductor-store";
import type { AbsolutePositionResolver, AnchorId, CanvasElement, Direction, Point } from "../../../packages/conductor/src/renderer/contracts.js";
import {
  GRID_PX,
  anchorToDirection,
  autoDirection,
  autoSelectAnchor as autoSelectAnchorBase,
  computeBezierPath,
  computeStraightPath,
  evaluateBezierPoint,
  getAnchorPosition as getAnchorPositionBase,
  getConnectorEndpoint as getConnectorEndpointBase,
  directionVector,
} from "../../../packages/conductor/src/renderer/canvas/connector-renderer.js";

const resolveAbsolutePosition: AbsolutePositionResolver = (node, allNodes) => getAbsolutePosition(node, allNodes);

export {
  GRID_PX,
  directionVector,
  anchorToDirection,
  autoDirection,
  computeBezierPath,
  evaluateBezierPoint,
  computeStraightPath,
};

export function getAnchorPosition(
  node: CanvasElement,
  anchorId: AnchorId,
  allNodes: CanvasElement[],
): Point {
  return getAnchorPositionBase(node, anchorId, allNodes, resolveAbsolutePosition);
}

export function getConnectorEndpoint(
  node: CanvasElement,
  anchorId: AnchorId,
  allNodes: CanvasElement[],
  otherPoint: Point,
): Point {
  return getConnectorEndpointBase(node, anchorId, allNodes, otherPoint, resolveAbsolutePosition);
}

export function autoSelectAnchor(
  cursorPos: Point,
  node: CanvasElement,
  allNodes: CanvasElement[],
): AnchorId {
  return autoSelectAnchorBase(cursorPos, node, allNodes, resolveAbsolutePosition);
}
