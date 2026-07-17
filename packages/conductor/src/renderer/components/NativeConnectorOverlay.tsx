"use client";

import React, { useCallback, useEffect, useMemo, useState } from "react";
import { ArrowElbowDownRight, BezierCurve } from "@phosphor-icons/react";
import type { CanvasElement } from "..//types/conductor";
import type {
  ConnectorEndpoint,
  ConnectorMarker,
  ConnectorRoutingMode,
  CurveControlOffsets,
  Point,
} from "..//types/canvas-node";
import { useConductorStore, getAbsolutePosition } from "..//stores/conductor-store";
import { executeAction } from "..//ipc/conductor-ipc";
import {
  autoSelectAttachment,
  GRID_PX,
  snapElbowSegmentCoordinate,
  simplifyOrthogonalPoints,
} from "..//domain/canvas/connector-renderer";
import {
  ConnectorPath,
  getComputedConnectorData,
  resolveConnectorMarkers,
  resolveConnectorRoutingMode,
} from "./native/ConnectorElement";
import { canvasTransformState } from "./CanvasArea";

interface NativeConnectorOverlayProps {
  elements: CanvasElement[];
}

type DragState =
  | { kind: "endpoint"; connectorId: string; endpoint: "source" | "target" }
  | { kind: "curve-control"; connectorId: string; control: "source" | "target" }
  | { kind: "elbow-segment"; connectorId: string; segmentIndex: number };

const MARKER_OPTIONS: { value: ConnectorMarker; label: string }[] = [
  { value: "none", label: "None" },
  { value: "arrow", label: "Arrow" },
  { value: "open-arrow", label: "Open" },
  { value: "circle", label: "Circle" },
  { value: "diamond", label: "Diamond" },
  { value: "bar", label: "Bar" },
];

const TOOLBAR_BUTTON: React.CSSProperties = {
  height: 30,
  width: 30,
  display: "inline-grid",
  placeItems: "center",
  border: 0,
  borderRadius: 7,
  padding: 0,
  color: "var(--text-primary)",
  background: "transparent",
  cursor: "pointer",
};

const TOOLBAR_SELECT: React.CSSProperties = {
  height: 30,
  border: "1px solid rgba(255,255,255,0.12)",
  borderRadius: 7,
  padding: "0 7px",
  color: "var(--text-primary)",
  background: "var(--command-menu-bg)",
  borderColor: "var(--command-menu-border)",
  fontSize: 12,
  outline: "none",
};

function ConnectorToolbar({
  connector,
  labelDraft,
  onLabelDraftChange,
  onPatch,
}: {
  connector: CanvasElement;
  labelDraft: string;
  onLabelDraftChange: (value: string) => void;
  onPatch: (patch: Record<string, unknown>) => void;
}) {
  const routingMode = resolveConnectorRoutingMode(connector.config);
  const strokeStyle = (connector.config.strokeStyle as "solid" | "dashed" | "dotted" | undefined) ?? "solid";
  const legacyStyle = connector.config.style as Record<string, unknown> | undefined;
  const color = (connector.config.color as string | undefined) ?? (legacyStyle?.stroke as string | undefined) ?? "#8793A3";
  const { startMarker, endMarker } = resolveConnectorMarkers(connector.config);

  const routeButton = (mode: ConnectorRoutingMode): React.CSSProperties => ({
    ...TOOLBAR_BUTTON,
    background: routingMode === mode ? "var(--canvas-tool-accent)" : "transparent",
    color: routingMode === mode ? "#fff" : "var(--text-primary)",
  });

  return (
    <div
      style={{
        pointerEvents: "auto",
        minHeight: 40,
        borderRadius: 11,
        display: "flex",
        alignItems: "center",
        gap: 4,
        padding: "4px 6px",
        background: "var(--command-menu-bg)",
        border: "1px solid var(--command-menu-border)",
        boxShadow: "none",
        color: "var(--text-primary)",
        fontSize: 12,
        whiteSpace: "nowrap",
      }}
      onPointerDown={(event) => event.stopPropagation()}
    >
      <button type="button" aria-label="Elbow connector" title="Elbow connector" style={routeButton("elbow")} onClick={() => onPatch({ routingMode: "elbow" })}><ArrowElbowDownRight size={17} weight="bold" /></button>
      <button type="button" aria-label="Curved connector" title="Curved connector" style={routeButton("curve")} onClick={() => onPatch({ routingMode: "curve" })}><BezierCurve size={17} weight="bold" /></button>
      <span style={{ width: 1, height: 22, background: "var(--command-menu-border)", margin: "0 2px" }} />
      <select aria-label="Line style" title="Line style" value={strokeStyle} style={TOOLBAR_SELECT} onChange={(event) => onPatch({ strokeStyle: event.target.value })}>
        <option value="solid">Solid</option>
        <option value="dashed">Dashed</option>
        <option value="dotted">Dotted</option>
      </select>
      <label title="Line color" style={{ width: 26, height: 26, borderRadius: 7, background: color, border: "1px solid var(--command-menu-border)", overflow: "hidden", cursor: "pointer", flexShrink: 0 }}>
        <input type="color" value={/^#[0-9a-fA-F]{6}$/.test(color) ? color : "#8793A3"} onChange={(event) => onPatch({ color: event.target.value })} style={{ width: 36, height: 36, opacity: 0, cursor: "pointer" }} />
      </label>
      <select aria-label="Start marker" title="Start marker" value={startMarker} style={{ ...TOOLBAR_SELECT, width: 90 }} onChange={(event) => onPatch({ startMarker: event.target.value })}>
        {MARKER_OPTIONS.map((option) => <option key={option.value} value={option.value}>S · {option.label}</option>)}
      </select>
      <select aria-label="End marker" title="End marker" value={endMarker} style={{ ...TOOLBAR_SELECT, width: 90 }} onChange={(event) => onPatch({ endMarker: event.target.value })}>
        {MARKER_OPTIONS.map((option) => <option key={option.value} value={option.value}>E · {option.label}</option>)}
      </select>
      <input
        type="text"
        aria-label="Connector label"
        value={labelDraft}
        placeholder="Add text"
        onChange={(event) => onLabelDraftChange(event.target.value)}
        onBlur={(event) => onPatch({ label: event.target.value })}
        onKeyDown={(event) => {
          if (event.key === "Enter") event.currentTarget.blur();
        }}
        style={{ width: 108, height: 30, border: "1px solid var(--command-menu-border)", borderRadius: 7, padding: "0 9px", color: "var(--text-primary)", background: "var(--command-menu-bg)", fontSize: 12, outline: "none" }}
      />
    </div>
  );
}

export const NativeConnectorOverlay: React.FC<NativeConnectorOverlayProps> = ({ elements }) => {
  const selectedElementId = useConductorStore((state) => state.selectedElementId);
  const setSelectedElementId = useConductorStore((state) => state.setSelectedElementId);
  const updateElement = useConductorStore((state) => state.updateElement);
  const activeCanvasId = useConductorStore((state) => state.activeCanvasId);
  const canvasZoom = useConductorStore((state) => state.canvasZoom);
  const [hoveredConnectorId, setHoveredConnectorId] = useState<string | null>(null);
  const [dragState, setDragState] = useState<DragState | null>(null);
  const [dragPoint, setDragPoint] = useState<Point | null>(null);
  const [labelDraft, setLabelDraft] = useState("");

  const connectors = useMemo(
    () => elements.filter((element) => element.elementKind === "native/connector"),
    [elements]
  );
  const selectedConnector = useMemo(
    () => connectors.find((connector) => connector.id === selectedElementId) ?? null,
    [connectors, selectedElementId]
  );
  useEffect(() => {
    setLabelDraft(typeof selectedConnector?.config.label === "string" ? selectedConnector.config.label : "");
  }, [selectedConnector?.id, selectedConnector?.config.label]);

  const selectedData = useMemo(() => {
    if (!selectedConnector) return null;
    const source = selectedConnector.config.source as ConnectorEndpoint | undefined;
    const target = selectedConnector.config.target as ConnectorEndpoint | undefined;
    const sourceNode = source ? elements.find((element) => element.id === source.nodeId) : null;
    const targetNode = target ? elements.find((element) => element.id === target.nodeId) : null;
    if (!sourceNode || !targetNode) return null;
    return getComputedConnectorData(selectedConnector, elements, sourceNode.position, targetNode.position);
  }, [selectedConnector, elements]);

  const toolbarAnchor = useMemo(() => {
    if (!selectedData) return null;
    // Whimsical-style connector controls follow the upper visible endpoint.
    // This keeps the toolbar attached to the selected line even for very long
    // connectors instead of drifting to the canvas or route bounding box.
    return selectedData.srcPoint.y <= selectedData.tgtPoint.y
      ? selectedData.srcPoint
      : selectedData.tgtPoint;
  }, [selectedData]);

  const handleConnectorClick = useCallback((connectorId: string) => {
    setSelectedElementId(selectedElementId === connectorId ? null : connectorId);
  }, [selectedElementId, setSelectedElementId]);

  const persistConfig = useCallback(async (element: CanvasElement, nextConfig: Record<string, unknown>) => {
    if (!activeCanvasId) return;
    updateElement(element.id, { config: nextConfig, updatedAt: Date.now() });
    try {
      await executeAction({
        action: "element.update",
        elementId: element.id,
        canvasId: activeCanvasId,
        config: nextConfig,
      });
    } catch {
      // The bridge patch will reconcile state if persistence fails transiently.
    }
  }, [activeCanvasId, updateElement]);

  const patchSelectedConnector = useCallback((patch: Record<string, unknown>) => {
    if (!selectedConnector) return;
    void persistConfig(selectedConnector, { ...selectedConnector.config, ...patch });
  }, [selectedConnector, persistConfig]);

  const toCanvasPoint = useCallback((event: PointerEvent | React.PointerEvent): Point => {
    const host = document.querySelector(".canvas-area") as HTMLElement | null;
    if (!host) return { x: 0, y: 0 };
    const rect = host.getBoundingClientRect();
    const zoom = Number.isFinite(canvasTransformState.zoom) && canvasTransformState.zoom > 0
      ? canvasTransformState.zoom
      : 1;
    return {
      x: (event.clientX - rect.left - canvasTransformState.panX) / zoom,
      y: (event.clientY - rect.top - canvasTransformState.panY) / zoom,
    };
  }, []);

  const hitTestNode = useCallback((point: Point, skipNodeId: string): CanvasElement | null => {
    const nodes = elements.filter((element) => element.elementKind.startsWith("native/") && element.elementKind !== "native/connector");
    for (const node of nodes) {
      if (node.id === skipNodeId) continue;
      const gridAbs = getAbsolutePosition(node, elements);
      const x = gridAbs.x * GRID_PX;
      const y = gridAbs.y * GRID_PX;
      const width = node.position.w * GRID_PX;
      const height = node.position.h * GRID_PX;
      if (point.x >= x && point.x <= x + width && point.y >= y && point.y <= y + height) return node;
    }
    return null;
  }, [elements]);

  const handleEndpointPointerDown = useCallback((connectorId: string, endpoint: "source" | "target", _point: Point, event: React.PointerEvent<SVGCircleElement>) => {
    event.stopPropagation();
    event.preventDefault();
    const connector = connectors.find((candidate) => candidate.id === connectorId);
    if (!connector) return;
    setDragState({ kind: "endpoint", connectorId, endpoint });
    setDragPoint(toCanvasPoint(event));

    const cleanup = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      setDragState(null);
      setDragPoint(null);
    };
    const onMove = (moveEvent: PointerEvent) => setDragPoint(toCanvasPoint(moveEvent));
    const onUp = (upEvent: PointerEvent) => {
      const state = useConductorStore.getState();
      const current = state.elements.find((element) => element.id === connectorId);
      if (!current) return cleanup();
      const source = current.config.source as ConnectorEndpoint;
      const target = current.config.target as ConnectorEndpoint;
      const fixedEndpoint = endpoint === "source" ? target : source;
      const dropPoint = toCanvasPoint(upEvent);
      const candidate = hitTestNode(dropPoint, fixedEndpoint.nodeId);
      if (candidate) {
        const attachment = autoSelectAttachment(dropPoint, candidate, state.elements);
        const nextEndpoint: ConnectorEndpoint = { nodeId: candidate.id, ...attachment };
        void persistConfig(current, { ...current.config, [endpoint]: nextEndpoint });
      }
      cleanup();
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  }, [connectors, hitTestNode, persistConfig, toCanvasPoint]);

  const handleCurveControlPointerDown = useCallback((connectorId: string, control: "source" | "target", _point: Point, event: React.PointerEvent<SVGCircleElement>) => {
    event.stopPropagation();
    event.preventDefault();
    setDragState({ kind: "curve-control", connectorId, control });

    const cleanup = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      setDragState(null);
    };
    const onMove = (moveEvent: PointerEvent) => {
      const state = useConductorStore.getState();
      const current = state.elements.find((element) => element.id === connectorId);
      if (!current) return;
      const source = current.config.source as ConnectorEndpoint | undefined;
      const target = current.config.target as ConnectorEndpoint | undefined;
      const sourceNode = source ? state.elements.find((element) => element.id === source.nodeId) : null;
      const targetNode = target ? state.elements.find((element) => element.id === target.nodeId) : null;
      if (!sourceNode || !targetNode) return;
      const data = getComputedConnectorData(current, state.elements, sourceNode.position, targetNode.position);
      if (!data) return;
      const cursor = toCanvasPoint(moveEvent);
      const endpointPoint = control === "source" ? data.srcPoint : data.tgtPoint;
      const endpointCenter = control === "source" ? data.sourceCenter : data.targetCenter;
      const outwardX = endpointPoint.x - endpointCenter.x;
      const outwardY = endpointPoint.y - endpointCenter.y;
      const outwardLength = Math.hypot(outwardX, outwardY) || 1;
      const outward = { x: outwardX / outwardLength, y: outwardY / outwardLength };
      const cursorOffset = { x: cursor.x - endpointPoint.x, y: cursor.y - endpointPoint.y };
      const tension = Math.max(24, cursorOffset.x * outward.x + cursorOffset.y * outward.y);
      const constrainedOffset = { x: outward.x * tension, y: outward.y * tension };
      const existing = current.config.curveControlOffsets as CurveControlOffsets | undefined;
      const fallback: CurveControlOffsets = {
        source: data.sourceControl
          ? { x: data.sourceControl.x - data.srcPoint.x, y: data.sourceControl.y - data.srcPoint.y }
          : { x: 40, y: 0 },
        target: data.targetControl
          ? { x: data.targetControl.x - data.tgtPoint.x, y: data.targetControl.y - data.tgtPoint.y }
          : { x: -40, y: 0 },
      };
      const nextOffsets: CurveControlOffsets = {
        source: existing?.source ?? fallback.source,
        target: existing?.target ?? fallback.target,
        [control]: constrainedOffset,
      };
      updateElement(connectorId, { config: { ...current.config, routingMode: "curve", curveControlOffsets: nextOffsets } });
    };
    const onUp = () => {
      const current = useConductorStore.getState().elements.find((element) => element.id === connectorId);
      if (current) void persistConfig(current, current.config);
      cleanup();
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  }, [persistConfig, toCanvasPoint, updateElement]);

  const handleElbowSegmentPointerDown = useCallback((connectorId: string, segmentIndex: number, orientation: "horizontal" | "vertical", event: React.PointerEvent<SVGRectElement>) => {
    event.stopPropagation();
    event.preventDefault();
    const current = useConductorStore.getState().elements.find((element) => element.id === connectorId);
    if (!current) return;
    const source = current.config.source as ConnectorEndpoint | undefined;
    const target = current.config.target as ConnectorEndpoint | undefined;
    const sourceNode = source ? elements.find((element) => element.id === source.nodeId) : null;
    const targetNode = target ? elements.find((element) => element.id === target.nodeId) : null;
    if (!sourceNode || !targetNode) return;
    const data = getComputedConnectorData(current, elements, sourceNode.position, targetNode.position);
    const basePoints = data?.elbowPoints?.map((point) => ({ ...point }));
    if (!basePoints || !basePoints[segmentIndex + 1]) return;
    setDragState({ kind: "elbow-segment", connectorId, segmentIndex });

    const cleanup = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      setDragState(null);
    };
    const onMove = (moveEvent: PointerEvent) => {
      const cursor = toCanvasPoint(moveEvent);
      const state = useConductorStore.getState();
      const stateCurrent = state.elements.find((element) => element.id === connectorId);
      if (!stateCurrent) return;
      const points = basePoints.map((point) => ({ ...point }));
      const candidateRoutes: Point[][] = [];
      for (const candidate of state.elements) {
        if (candidate.id === connectorId || candidate.elementKind !== "native/connector") continue;
        const candidateSource = candidate.config.source as ConnectorEndpoint | undefined;
        const candidateTarget = candidate.config.target as ConnectorEndpoint | undefined;
        const candidateSourceNode = candidateSource
          ? state.elements.find((element) => element.id === candidateSource.nodeId)
          : null;
        const candidateTargetNode = candidateTarget
          ? state.elements.find((element) => element.id === candidateTarget.nodeId)
          : null;
        if (!candidateSourceNode || !candidateTargetNode) continue;
        const candidateData = getComputedConnectorData(
          candidate,
          state.elements,
          candidateSourceNode.position,
          candidateTargetNode.position,
        );
        if (candidateData?.routingMode === "elbow" && candidateData.elbowPoints) {
          candidateRoutes.push(candidateData.elbowPoints);
        }
      }
      const zoom = Number.isFinite(canvasTransformState.zoom) && canvasTransformState.zoom > 0
        ? canvasTransformState.zoom
        : 1;
      const proposedCoordinate = orientation === "horizontal" ? cursor.y : cursor.x;
      const snap = snapElbowSegmentCoordinate(
        proposedCoordinate,
        orientation,
        points[segmentIndex],
        points[segmentIndex + 1],
        candidateRoutes,
        12 / zoom,
      );
      if (orientation === "horizontal") {
        points[segmentIndex].y = snap.coordinate;
        points[segmentIndex + 1].y = snap.coordinate;
      } else {
        points[segmentIndex].x = snap.coordinate;
        points[segmentIndex + 1].x = snap.coordinate;
      }
      const waypoints = simplifyOrthogonalPoints(points).slice(1, -1);
      updateElement(connectorId, { config: { ...stateCurrent.config, routingMode: "elbow", waypoints } });
    };
    const onUp = () => {
      const stateCurrent = useConductorStore.getState().elements.find((element) => element.id === connectorId);
      if (stateCurrent) void persistConfig(stateCurrent, stateCurrent.config);
      cleanup();
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  }, [elements, persistConfig, toCanvasPoint, updateElement]);

  const dragPreview = useMemo(() => {
    if (dragState?.kind !== "endpoint" || !dragPoint) return null;
    const connector = connectors.find((candidate) => candidate.id === dragState.connectorId);
    if (!connector) return null;
    const source = connector.config.source as ConnectorEndpoint | undefined;
    const target = connector.config.target as ConnectorEndpoint | undefined;
    const sourceNode = source ? elements.find((element) => element.id === source.nodeId) : null;
    const targetNode = target ? elements.find((element) => element.id === target.nodeId) : null;
    if (!sourceNode || !targetNode) return null;
    const computed = getComputedConnectorData(connector, elements, sourceNode.position, targetNode.position);
    if (!computed) return null;
    return dragState.endpoint === "source"
      ? { from: dragPoint, to: computed.tgtPoint }
      : { from: computed.srcPoint, to: dragPoint };
  }, [dragState, dragPoint, connectors, elements]);

  if (connectors.length === 0) return null;
  const safeZoom = Number.isFinite(canvasZoom) && canvasZoom > 0 ? canvasZoom : 1;
  const inverseZoom = 1 / safeZoom;

  return (
    <>
      <svg className="native-connector-overlay" style={{ position: "absolute", inset: 0, width: "100%", height: "100%", pointerEvents: "none", zIndex: 0, overflow: "visible" }}>
        {connectors.map((connector) => (
          <ConnectorPath
            key={connector.id}
            connector={connector}
            elements={elements}
            isSelected={selectedElementId === connector.id}
            isHovered={hoveredConnectorId === connector.id}
            layer="visual"
            onHover={setHoveredConnectorId}
            onClick={handleConnectorClick}
          />
        ))}
      </svg>

      <svg className="native-connector-controls" style={{ position: "absolute", inset: 0, width: "100%", height: "100%", pointerEvents: "none", zIndex: 6, overflow: "visible" }}>
        {selectedConnector && (
          <ConnectorPath
            connector={selectedConnector}
            elements={elements}
            isSelected
            layer="controls"
            onEndpointPointerDown={handleEndpointPointerDown}
            onCurveControlPointerDown={handleCurveControlPointerDown}
            onElbowSegmentPointerDown={handleElbowSegmentPointerDown}
          />
        )}

        {dragPreview && (
          <g style={{ pointerEvents: "none" }}>
            <path d={`M ${dragPreview.from.x} ${dragPreview.from.y} L ${dragPreview.to.x} ${dragPreview.to.y}`} fill="none" stroke="var(--conductor-accent)" strokeWidth={2} strokeDasharray="6 4" strokeLinecap="round" opacity={0.85} />
            <circle cx={dragPreview.from.x} cy={dragPreview.from.y} r={6} fill="var(--canvas-bg)" stroke="var(--conductor-accent)" strokeWidth={2} />
          </g>
        )}

      </svg>

      {selectedConnector && toolbarAnchor && !dragState && (
        <div
          style={{
            position: "absolute",
            left: toolbarAnchor.x,
            top: toolbarAnchor.y - 12 * inverseZoom,
            zIndex: 7,
            pointerEvents: "none",
            transform: `scale(${inverseZoom}) translate(-50%, -100%)`,
            transformOrigin: "top left",
          }}
        >
          <ConnectorToolbar connector={selectedConnector} labelDraft={labelDraft} onLabelDraftChange={setLabelDraft} onPatch={patchSelectedConnector} />
        </div>
      )}
    </>
  );
};
