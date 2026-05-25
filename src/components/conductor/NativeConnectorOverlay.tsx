"use client";

import React, { useCallback, useMemo, useState } from "react";
import type { CanvasElement } from "@/types/conductor";
import type { AnchorId, ConnectorEndpoint, Point } from "@/types/canvas-node";
import { useConductorStore, getAbsolutePosition } from "@/stores/conductor-store";
import { executeAction } from "@/lib/conductor-ipc";
import { autoSelectAnchor, GRID_PX } from "@/conductor/canvas/connector-renderer";
import { ConnectorPath, getComputedConnectorData } from "./native/ConnectorElement";
import { canvasTransformState } from "./CanvasArea";

interface NativeConnectorOverlayProps {
  elements: CanvasElement[];
}

type DragState = {
  connectorId: string;
  endpoint: "source" | "target";
};

const PRESET_COLORS = ["#7C5CFF", "#00A3FF", "#13B981", "#F59E0B", "#EF4444", "#1F2937"];
const PRESET_WIDTHS = [2, 3, 4];

export const NativeConnectorOverlay: React.FC<NativeConnectorOverlayProps> = ({
  elements,
}) => {
  const selectedElementId = useConductorStore((state) => state.selectedElementId);
  const setSelectedElementId = useConductorStore((state) => state.setSelectedElementId);
  const updateElement = useConductorStore((state) => state.updateElement);
  const activeCanvasId = useConductorStore((state) => state.activeCanvasId);

  const [hoveredConnectorId, setHoveredConnectorId] = useState<string | null>(null);
  const [dragState, setDragState] = useState<DragState | null>(null);
  const [dragPoint, setDragPoint] = useState<Point | null>(null);

  const connectors = useMemo(
    () => elements.filter((el) => el.elementKind === "native/connector"),
    [elements]
  );

  const selectedConnector = useMemo(
    () => connectors.find((c) => c.id === selectedElementId) ?? null,
    [connectors, selectedElementId]
  );

  const selectedData = useMemo(() => {
    if (!selectedConnector) return null;
    const source = selectedConnector.config.source as ConnectorEndpoint | undefined;
    const target = selectedConnector.config.target as ConnectorEndpoint | undefined;
    const sourceNode = source ? elements.find((e) => e.id === source.nodeId) : null;
    const targetNode = target ? elements.find((e) => e.id === target.nodeId) : null;
    if (!sourceNode || !targetNode) return null;
    return getComputedConnectorData(selectedConnector, elements, sourceNode.position, targetNode.position);
  }, [selectedConnector, elements]);

  const handleConnectorClick = useCallback(
    (connectorId: string) => {
      setSelectedElementId(selectedElementId === connectorId ? null : connectorId);
    },
    [selectedElementId, setSelectedElementId]
  );

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
      // no-op: bridge patch will eventually reconcile state
    }
  }, [activeCanvasId, updateElement]);

  const patchSelectedConnector = useCallback(
    (patch: {
      routingMode?: "bezier" | "straight";
      curvature?: number;
      style?: { stroke?: string; strokeWidth?: number; endMarker?: "arrow" | "none" };
    }) => {
      if (!selectedConnector) return;
      const style = (selectedConnector.config.style as Record<string, unknown> | undefined) ?? {};
      const nextConfig: Record<string, unknown> = {
        ...selectedConnector.config,
        ...patch,
        style: {
          ...style,
          ...(patch.style ?? {}),
        },
      };
      void persistConfig(selectedConnector, nextConfig);
    },
    [selectedConnector, persistConfig]
  );

  const toCanvasPoint = useCallback((event: PointerEvent | React.PointerEvent): Point => {
    const host = document.querySelector(".canvas-area") as HTMLElement | null;
    if (!host) return { x: 0, y: 0 };
    const rect = host.getBoundingClientRect();
    const { panX, panY, zoom } = canvasTransformState;
    return {
      x: (event.clientX - rect.left - panX) / zoom,
      y: (event.clientY - rect.top - panY) / zoom,
    };
  }, []);

  const hitTestNode = useCallback((point: Point, skipNodeId: string): CanvasElement | null => {
    const nodes = elements.filter((el) => el.elementKind.startsWith("native/") && el.elementKind !== "native/connector");
    for (const node of nodes) {
      if (node.id === skipNodeId) continue;
      const abs = getAbsolutePosition(node, elements);
      const w = node.position.w * GRID_PX;
      const h = node.position.h * GRID_PX;
      if (point.x >= abs.x && point.x <= abs.x + w && point.y >= abs.y && point.y <= abs.y + h) {
        return node;
      }
    }
    return null;
  }, [elements]);

  const handleEndpointPointerDown = useCallback((connectorId: string, endpoint: "source" | "target", _point: Point, event: React.PointerEvent<SVGCircleElement>) => {
    event.stopPropagation();
    event.preventDefault();

    const connector = connectors.find((c) => c.id === connectorId);
    if (!connector) return;
    setDragState({ connectorId, endpoint });
    setDragPoint(toCanvasPoint(event));

    const onMove = (e: PointerEvent) => {
      setDragPoint(toCanvasPoint(e));
    };

    const onUp = (e: PointerEvent) => {
      const state = useConductorStore.getState();
      const current = state.elements.find((el) => el.id === connectorId);
      if (!current) {
        cleanup();
        return;
      }

      const source = current.config.source as ConnectorEndpoint;
      const target = current.config.target as ConnectorEndpoint;
      const movingEndpoint = endpoint === "source" ? source : target;
      const fixedEndpoint = endpoint === "source" ? target : source;
      const dropPoint = toCanvasPoint(e);
      const candidate = hitTestNode(dropPoint, fixedEndpoint.nodeId);

      if (candidate) {
        const anchorId = autoSelectAnchor(dropPoint, candidate, state.elements) as AnchorId;
        const nextEndpoint: ConnectorEndpoint = { nodeId: candidate.id, anchorId };
        const nextConfig = {
          ...current.config,
          [endpoint]: nextEndpoint,
        } as Record<string, unknown>;
        void persistConfig(current, nextConfig);
      }

      cleanup();
    };

    const cleanup = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      setDragState(null);
      setDragPoint(null);
    };

    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  }, [connectors, hitTestNode, persistConfig, toCanvasPoint]);

  const dragPreview = useMemo(() => {
    if (!dragState || !dragPoint) return null;
    const connector = connectors.find((c) => c.id === dragState.connectorId);
    if (!connector) return null;

    const source = connector.config.source as ConnectorEndpoint | undefined;
    const target = connector.config.target as ConnectorEndpoint | undefined;
    if (!source || !target) return null;

    const sourceNode = elements.find((e) => e.id === source.nodeId);
    const targetNode = elements.find((e) => e.id === target.nodeId);
    if (!sourceNode || !targetNode) return null;

    const computed = getComputedConnectorData(connector, elements, sourceNode.position, targetNode.position);
    if (!computed) return null;

    return dragState.endpoint === "source"
      ? { from: dragPoint, to: computed.tgtPoint }
      : { from: computed.srcPoint, to: dragPoint };
  }, [dragState, dragPoint, connectors, elements]);

  if (connectors.length === 0) return null;

  const selectedStyle = (selectedConnector?.config.style as Record<string, unknown> | undefined) ?? {};
  const selectedEndMarker = (selectedStyle.endMarker as "arrow" | "none" | undefined) ?? "arrow";
  const toolbarX = selectedData?.midPoint.x ?? 0;
  const toolbarY = selectedData ? selectedData.midPoint.y - 56 : 0;

  return (
    <>
      <svg
        className="native-connector-overlay"
        style={{
          position: "absolute",
          inset: 0,
          width: "100%",
          height: "100%",
          pointerEvents: "none",
          zIndex: 6,
          overflow: "visible",
        }}
      >
        <defs>
          <marker
            id="native-connector-arrowhead"
            markerWidth="12"
            markerHeight="12"
            refX="10"
            refY="6"
            orient="auto-start-reverse"
          >
            <path
              d="M 1 1 Q 6 6 1 11 L 10 6 Z"
              fill="#8C4EFF"
              stroke="#8C4EFF"
              strokeWidth="1"
              strokeLinejoin="round"
            />
          </marker>
        </defs>

        {connectors.map((conn) => (
          <ConnectorPath
            key={conn.id}
            connector={conn}
            elements={elements}
            isSelected={selectedElementId === conn.id}
            isHovered={hoveredConnectorId === conn.id}
            onHover={setHoveredConnectorId}
            onClick={handleConnectorClick}
            onEndpointPointerDown={handleEndpointPointerDown}
          />
        ))}

        {dragPreview && (
          <g style={{ pointerEvents: "none" }}>
            <path
              d={`M ${dragPreview.from.x} ${dragPreview.from.y} L ${dragPreview.to.x} ${dragPreview.to.y}`}
              fill="none"
              stroke="#8C4EFF"
              strokeWidth={2}
              strokeDasharray="6 4"
              strokeLinecap="round"
              opacity={0.85}
            />
            <circle cx={dragPreview.from.x} cy={dragPreview.from.y} r={6} fill="#FFFFFF" stroke="#8C4EFF" strokeWidth={2} />
          </g>
        )}

        {selectedConnector && selectedData && !dragState && (
          <foreignObject x={toolbarX - 170} y={toolbarY} width={340} height={46} style={{ overflow: "visible", pointerEvents: "none" }}>
            <div
              style={{
                pointerEvents: "auto",
                height: 40,
                borderRadius: 12,
                display: "flex",
                alignItems: "center",
                gap: 8,
                padding: "0 10px",
                background: "rgba(20, 28, 45, 0.92)",
                boxShadow: "0 8px 28px rgba(12, 18, 34, 0.28)",
                color: "#E7ECF5",
                fontSize: 12,
              }}
              onPointerDown={(e) => e.stopPropagation()}
            >
              <button onClick={() => patchSelectedConnector({ routingMode: "straight" })} style={{ color: "#E7ECF5" }}>Straight</button>
              <button onClick={() => patchSelectedConnector({ routingMode: "bezier", curvature: 0.4 })} style={{ color: "#E7ECF5" }}>Curve</button>

              {PRESET_WIDTHS.map((w) => (
                <button key={w} onClick={() => patchSelectedConnector({ style: { strokeWidth: w } })} style={{ color: "#E7ECF5" }}>{w}px</button>
              ))}

              {PRESET_COLORS.map((color) => (
                <button
                  key={color}
                  onClick={() => patchSelectedConnector({ style: { stroke: color } })}
                  style={{ width: 16, height: 16, borderRadius: 999, background: color, border: "1px solid rgba(255,255,255,0.35)" }}
                  aria-label={`Set color ${color}`}
                />
              ))}

              <button
                onClick={() => patchSelectedConnector({ style: { endMarker: selectedEndMarker === "arrow" ? "none" : "arrow" } })}
                style={{ color: "#E7ECF5" }}
              >
                {selectedEndMarker === "arrow" ? "Arrow On" : "Arrow Off"}
              </button>
            </div>
          </foreignObject>
        )}
      </svg>
    </>
  );
};
