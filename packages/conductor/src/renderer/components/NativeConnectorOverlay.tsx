"use client";

import React, { useCallback, useEffect, useMemo, useState } from "react";
import { ArrowElbowDownRight, BezierCurve, TextT } from "@phosphor-icons/react";
import { TrashIcon } from "@/components/icons";
import type { CanvasElement } from "..//types/conductor";
import type {
  ConnectorEndpoint,
  ConnectorMarker,
  CurveControlOffsets,
  Point,
} from "..//types/canvas-node";
import { useConductorStore, getAbsolutePosition } from "..//stores/conductor-store";
import { executeAction } from "..//ipc/conductor-ipc";
import {
  createConnectorEndpointAtPoint,
  getDefaultCurveControls,
  GRID_PX,
  moveElbowSegment,
  snapElbowSegmentCoordinate,
  snapElbowSegmentToAdjacentParallel,
} from "..//domain/canvas/connector-renderer";
import {
  ConnectorPath,
  getComputedConnectorData,
  resolveConnectorMarkers,
  resolveConnectorRoutingMode,
} from "./native/ConnectorElement";
import { canvasTransformState } from "./CanvasArea";
import {
  CapsuleMoreMenu,
  CapsuleToolbar,
  CAPSULE_BTN_ACTIVE,
  CAPSULE_BTN_BASE,
  CAPSULE_DIVIDER,
} from "./toolbar/CapsuleToolbar";
import { useElementLock } from "./toolbar/useElementLock";

interface NativeConnectorOverlayProps {
  elements: CanvasElement[];
}

type DragState =
  | { kind: "endpoint"; connectorId: string; endpoint: "source" | "target" }
  | { kind: "curve-control"; connectorId: string; control: "midpoint" | "source" | "target" }
  | { kind: "elbow-segment"; connectorId: string; segmentIndex: number };

const MARKER_OPTIONS: { value: ConnectorMarker; label: string }[] = [
  { value: "none", label: "None" },
  { value: "arrow", label: "Arrow" },
  { value: "open-arrow", label: "Open" },
  { value: "circle", label: "Circle" },
  { value: "diamond", label: "Diamond" },
  { value: "bar", label: "Bar" },
];

const CONNECTOR_COLORS = [
  "#FFFFFF", "#D9E1E8", "#8793A3", "#536273",
  "#3289D1", "#635BDF", "#8618D4", "#BD35CA",
  "#12A99B", "#287D71", "#9A8565", "#BE6D6D",
  "#DF455A", "#F28A37", "#F5BF28", "#202B38",
] as const;

type ToolbarPanel = "text" | "color" | "start-marker" | "end-marker" | null;
type ConnectorStrokeStyle = "solid" | "dashed" | "bold";

const POPOVER_STYLE: React.CSSProperties = {
  position: "absolute",
  bottom: 38,
  left: "50%",
  transform: "translateX(-50%)",
  padding: 8,
  background: "var(--command-menu-bg)",
  border: "1px solid var(--command-menu-border)",
  borderRadius: 10,
  boxShadow: "0 12px 28px rgba(0,0,0,0.24)",
  zIndex: 40,
};

function LineStyleIcon({ style }: { style: ConnectorStrokeStyle }) {
  return (
    <svg width="24" height="18" viewBox="0 0 24 18" aria-hidden>
      <path
        d="M 3 15 L 21 3"
        fill="none"
        stroke="currentColor"
        strokeWidth={style === "bold" ? 5 : 2.2}
        strokeDasharray={style === "dashed" ? "4 3" : undefined}
        strokeLinecap="round"
      />
    </svg>
  );
}

function MarkerIcon({ marker, endpoint }: { marker: ConnectorMarker; endpoint: "start" | "end" }) {
  const start = endpoint === "start";
  const tipX = start ? 4 : 24;
  const innerX = start ? 10 : 18;
  const lineStart = start ? 8 : 4;
  const lineEnd = start ? 24 : 20;
  const direction = start ? 1 : -1;
  return (
    <svg width="28" height="18" viewBox="0 0 28 18" aria-hidden>
      <path d={`M ${lineStart} 9 L ${lineEnd} 9`} fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
      {marker === "arrow" && <path d={`M ${tipX} 9 L ${innerX} 4 L ${innerX} 14 Z`} fill="currentColor" />}
      {marker === "open-arrow" && <path d={`M ${innerX} 4 L ${tipX} 9 L ${innerX} 14`} fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />}
      {marker === "circle" && <circle cx={tipX + direction * 2} cy="9" r="4" fill="var(--command-menu-bg)" stroke="currentColor" strokeWidth="2" />}
      {marker === "diamond" && <path d={`M ${tipX} 9 L ${tipX + direction * 5} 4 L ${tipX + direction * 10} 9 L ${tipX + direction * 5} 14 Z`} fill="var(--command-menu-bg)" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" />}
      {marker === "bar" && <path d={`M ${tipX + direction * 2} 3 L ${tipX + direction * 2} 15`} fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" />}
    </svg>
  );
}

function SwapMarkersIcon() {
  return (
    <svg width="20" height="18" viewBox="0 0 20 18" aria-hidden>
      <path d="M 3 6 H 15 M 12 3 L 15 6 L 12 9" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M 17 12 H 5 M 8 9 L 5 12 L 8 15" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function ToolbarPanelHost({ children, panel }: { children: React.ReactNode; panel?: React.ReactNode }) {
  return (
    <div style={{ position: "relative", display: "inline-flex" }}>
      {children}
      {panel}
    </div>
  );
}

export function ConnectorToolbar({
  connector,
  labelDraft,
  onLabelDraftChange,
  onPatch,
  onDelete,
  onDismiss,
}: {
  connector: CanvasElement;
  labelDraft: string;
  onLabelDraftChange: (value: string) => void;
  onPatch: (patch: Record<string, unknown>) => void;
  onDelete: () => void;
  onDismiss: () => void;
}) {
  const { locked, toggleLocked } = useElementLock(connector);
  const [openPanel, setOpenPanel] = useState<ToolbarPanel>(null);
  const routingMode = resolveConnectorRoutingMode(connector.config);
  const rawStrokeStyle = connector.config.strokeStyle;
  const strokeStyle: ConnectorStrokeStyle = rawStrokeStyle === "dashed" || rawStrokeStyle === "bold"
    ? rawStrokeStyle
    : "solid";
  const legacyStyle = connector.config.style as Record<string, unknown> | undefined;
  const color = (connector.config.color as string | undefined) ?? (legacyStyle?.stroke as string | undefined) ?? "#8793A3";
  const { startMarker, endMarker } = resolveConnectorMarkers(connector.config);

  const togglePanel = (panel: Exclude<ToolbarPanel, null>) => {
    setOpenPanel((current) => current === panel ? null : panel);
  };

  const toggleRoutingMode = () => {
    if (routingMode === "elbow") {
      onPatch({ routingMode: "curve", waypoints: undefined });
      return;
    }
    onPatch({
      routingMode: "elbow",
      curveMidpointOffset: undefined,
      curveControlOffsets: undefined,
    });
  };

  return (
    <CapsuleToolbar
      positioned={false}
      zoomAware={false}
      onMouseDown={(event) => event.stopPropagation()}
    >
      <ToolbarPanelHost panel={openPanel === "text" ? (
        <div style={{ ...POPOVER_STYLE, padding: 7 }}>
          <input
            autoFocus
            type="text"
            aria-label="Connector label"
            value={labelDraft}
            placeholder="Add text"
            onChange={(event) => onLabelDraftChange(event.target.value)}
            onBlur={(event) => {
              onPatch({ label: event.target.value });
              setOpenPanel(null);
            }}
            onKeyDown={(event) => {
              if (event.key === "Enter") event.currentTarget.blur();
              if (event.key === "Escape") setOpenPanel(null);
            }}
            style={{ width: 190, height: 30, border: "1px solid var(--command-menu-border)", borderRadius: 7, padding: "0 9px", color: "var(--text-primary)", background: "var(--surface)", outline: "none" }}
          />
        </div>
      ) : undefined}>
        <button type="button" aria-label="Add or edit connector text" title="Add text" style={{ ...CAPSULE_BTN_BASE, ...(openPanel === "text" ? CAPSULE_BTN_ACTIVE : {}) }} onClick={() => togglePanel("text")}><TextT size={20} weight="regular" /></button>
      </ToolbarPanelHost>

      <ToolbarPanelHost panel={openPanel === "color" ? (
        <div role="menu" aria-label="Connector color palette" style={{ ...POPOVER_STYLE, display: "grid", gridTemplateColumns: "repeat(4, 24px)", gap: 7 }}>
          {CONNECTOR_COLORS.map((option) => (
            <button key={option} type="button" role="menuitem" aria-label={`Set connector color ${option}`} title={option} onClick={() => { onPatch({ color: option }); setOpenPanel(null); }} style={{ width: 24, height: 24, padding: 0, borderRadius: "50%", border: color.toLowerCase() === option.toLowerCase() ? "2px solid #fff" : "1px solid rgba(255,255,255,0.16)", outline: color.toLowerCase() === option.toLowerCase() ? "2px solid var(--canvas-tool-accent)" : "none", outlineOffset: 1, background: option, cursor: "pointer" }} />
          ))}
        </div>
      ) : undefined}>
        <button type="button" aria-label="Connector color" title="Color" style={{ ...CAPSULE_BTN_BASE, ...(openPanel === "color" ? CAPSULE_BTN_ACTIVE : {}) }} onClick={() => togglePanel("color")}>
          <span aria-hidden style={{ width: 20, height: 20, borderRadius: "50%", background: color, border: "1px solid rgba(255,255,255,0.28)" }} />
        </button>
      </ToolbarPanelHost>

      <span style={CAPSULE_DIVIDER} />
      <div role="group" aria-label="Connector line style" style={{ display: "inline-flex", gap: 0, padding: 2, borderRadius: 8, background: "rgba(255,255,255,0.04)" }}>
        {(["solid", "dashed", "bold"] as const).map((option) => (
          <button key={option} type="button" aria-label={`${option} connector line`} title={option === "bold" ? "Bold" : option === "dashed" ? "Dashed" : "Default"} style={{ ...CAPSULE_BTN_BASE, width: 38, ...(strokeStyle === option ? CAPSULE_BTN_ACTIVE : {}) }} onClick={() => onPatch({ strokeStyle: option })}>
            <LineStyleIcon style={option} />
          </button>
        ))}
      </div>

      <span style={CAPSULE_DIVIDER} />
      <ToolbarPanelHost panel={openPanel === "start-marker" ? (
        <div role="menu" aria-label="Start marker styles" style={{ ...POPOVER_STYLE, display: "grid", gridTemplateColumns: "repeat(3, 38px)", gap: 4 }}>
          {MARKER_OPTIONS.map((option) => <button key={option.value} type="button" role="menuitem" aria-label={`Start marker ${option.label}`} title={option.label} onClick={() => { onPatch({ startMarker: option.value }); setOpenPanel(null); }} style={{ ...CAPSULE_BTN_BASE, width: 38, ...(startMarker === option.value ? CAPSULE_BTN_ACTIVE : {}) }}><MarkerIcon marker={option.value} endpoint="start" /></button>)}
        </div>
      ) : undefined}>
        <button type="button" aria-label="Start marker" title="Start marker" style={{ ...CAPSULE_BTN_BASE, width: 38, ...(openPanel === "start-marker" ? CAPSULE_BTN_ACTIVE : {}) }} onClick={() => togglePanel("start-marker")}><MarkerIcon marker={startMarker} endpoint="start" /></button>
      </ToolbarPanelHost>

      <button type="button" aria-label="Swap connector markers" title="Swap ends" style={CAPSULE_BTN_BASE} onClick={() => onPatch({ startMarker: endMarker, endMarker: startMarker })}><SwapMarkersIcon /></button>

      <ToolbarPanelHost panel={openPanel === "end-marker" ? (
        <div role="menu" aria-label="End marker styles" style={{ ...POPOVER_STYLE, display: "grid", gridTemplateColumns: "repeat(3, 38px)", gap: 4 }}>
          {MARKER_OPTIONS.map((option) => <button key={option.value} type="button" role="menuitem" aria-label={`End marker ${option.label}`} title={option.label} onClick={() => { onPatch({ endMarker: option.value }); setOpenPanel(null); }} style={{ ...CAPSULE_BTN_BASE, width: 38, ...(endMarker === option.value ? CAPSULE_BTN_ACTIVE : {}) }}><MarkerIcon marker={option.value} endpoint="end" /></button>)}
        </div>
      ) : undefined}>
        <button type="button" aria-label="End marker" title="End marker" style={{ ...CAPSULE_BTN_BASE, width: 38, ...(openPanel === "end-marker" ? CAPSULE_BTN_ACTIVE : {}) }} onClick={() => togglePanel("end-marker")}><MarkerIcon marker={endMarker} endpoint="end" /></button>
      </ToolbarPanelHost>

      <span style={CAPSULE_DIVIDER} />
      <button type="button" aria-label="Toggle connector routing" title={routingMode === "elbow" ? "Switch to curved connector" : "Switch to elbow connector"} style={{ ...CAPSULE_BTN_BASE, ...CAPSULE_BTN_ACTIVE }} onClick={toggleRoutingMode}>
        {routingMode === "elbow" ? <ArrowElbowDownRight size={18} weight="bold" /> : <BezierCurve size={18} weight="bold" />}
      </button>
      <span style={CAPSULE_DIVIDER} />
      <CapsuleMoreMenu
        items={[
          { label: locked ? "Unlock position" : "Lock position", onSelect: toggleLocked },
          {
            label: "Clear label",
            disabled: labelDraft.length === 0,
            onSelect: () => {
              onLabelDraftChange("");
              onPatch({ label: "" });
            },
          },
          { label: "Close toolbar", onSelect: onDismiss },
        ]}
      />
      <button type="button" aria-label="Delete connector" title="Delete connector" style={CAPSULE_BTN_BASE} onClick={onDelete}><TrashIcon size={16} /></button>
    </CapsuleToolbar>
  );
}

export const NativeConnectorOverlay: React.FC<NativeConnectorOverlayProps> = ({ elements }) => {
  const selectedElementId = useConductorStore((state) => state.selectedElementId);
  const setSelectedElementId = useConductorStore((state) => state.setSelectedElementId);
  const updateElement = useConductorStore((state) => state.updateElement);
  const removeElement = useConductorStore((state) => state.removeElement);
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
    return getComputedConnectorData(selectedConnector, elements);
  }, [selectedConnector, elements]);

  const toolbarAnchor = useMemo(() => {
    if (!selectedData) return null;
    const controlPoints = [
      selectedData.sourceReference,
      selectedData.targetReference,
      selectedData.srcPoint,
      selectedData.tgtPoint,
      selectedData.midPoint,
      ...(selectedData.elbowPoints ?? []),
      ...(selectedData.sourceControl ? [selectedData.sourceControl] : []),
      ...(selectedData.targetControl ? [selectedData.targetControl] : []),
    ];
    const minX = Math.min(...controlPoints.map((point) => point.x));
    const maxX = Math.max(...controlPoints.map((point) => point.x));
    const minY = Math.min(...controlPoints.map((point) => point.y));
    return { x: (minX + maxX) / 2, y: minY };
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

  const deleteSelectedConnector = useCallback(() => {
    if (!selectedConnector || !activeCanvasId) return;
    removeElement(selectedConnector.id);
    setSelectedElementId(null);
    void executeAction({
      action: "element.delete",
      elementId: selectedConnector.id,
      canvasId: activeCanvasId,
    });
  }, [activeCanvasId, removeElement, selectedConnector, setSelectedElementId]);

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

  const hitTestNode = useCallback((point: Point): CanvasElement | null => {
    const nodes = elements
      .filter((element) => element.elementKind.startsWith("native/") && element.elementKind !== "native/connector")
      .sort((a, b) => b.position.zIndex - a.position.zIndex);
    for (const node of nodes) {
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
    if (!connector || connector.metadata.locked === true) return;
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
      const dropPoint = toCanvasPoint(upEvent);
      const candidate = hitTestNode(dropPoint);
      const nextEndpoint = createConnectorEndpointAtPoint(dropPoint, candidate, state.elements);
      const nextConfig = { ...current.config, [endpoint]: nextEndpoint };
      delete nextConfig.waypoints;
      if (resolveConnectorRoutingMode(current.config) === "curve") {
        delete nextConfig.curveMidpointOffset;
        delete nextConfig.curveControlOffsets;
      }
      void persistConfig(current, nextConfig);
      cleanup();
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  }, [connectors, hitTestNode, persistConfig, toCanvasPoint]);

  const handleCurveControlPointerDown = useCallback((connectorId: string, control: "midpoint" | "source" | "target", _point: Point, event: React.PointerEvent<SVGCircleElement>) => {
    event.stopPropagation();
    event.preventDefault();
    const connector = connectors.find((candidate) => candidate.id === connectorId);
    if (!connector || connector.metadata.locked === true) return;
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
      const data = getComputedConnectorData(current, state.elements);
      if (!data) return;
      const cursor = toCanvasPoint(moveEvent);
      if (control === "midpoint") {
        const baseMidpoint = {
          x: (data.sourceReference.x + data.targetReference.x) / 2,
          y: (data.sourceReference.y + data.targetReference.y) / 2,
        };
        const controls = getDefaultCurveControls(data.sourceReference, cursor, data.targetReference);
        const nextOffsets: CurveControlOffsets = {
          source: {
            x: controls.source.x - data.sourceReference.x,
            y: controls.source.y - data.sourceReference.y,
          },
          target: {
            x: controls.target.x - data.targetReference.x,
            y: controls.target.y - data.targetReference.y,
          },
        };
        updateElement(connectorId, {
          config: {
            ...current.config,
            routingMode: "curve",
            curveMidpointOffset: {
              x: cursor.x - baseMidpoint.x,
              y: cursor.y - baseMidpoint.y,
            },
            curveControlOffsets: nextOffsets,
          },
        });
        return;
      }

      const existing = current.config.curveControlOffsets as CurveControlOffsets | undefined;
      const fallback: CurveControlOffsets = {
        source: data.sourceControl
          ? { x: data.sourceControl.x - data.sourceReference.x, y: data.sourceControl.y - data.sourceReference.y }
          : { x: 0, y: 0 },
        target: data.targetControl
          ? { x: data.targetControl.x - data.targetReference.x, y: data.targetControl.y - data.targetReference.y }
          : { x: 0, y: 0 },
      };
      const reference = control === "source" ? data.sourceReference : data.targetReference;
      const nextOffsets: CurveControlOffsets = {
        source: existing?.source ?? fallback.source,
        target: existing?.target ?? fallback.target,
        [control]: { x: cursor.x - reference.x, y: cursor.y - reference.y },
      };
      const baseMidpoint = {
        x: (data.sourceReference.x + data.targetReference.x) / 2,
        y: (data.sourceReference.y + data.targetReference.y) / 2,
      };
      updateElement(connectorId, {
        config: {
          ...current.config,
          routingMode: "curve",
          curveMidpointOffset: current.config.curveMidpointOffset ?? {
            x: data.midPoint.x - baseMidpoint.x,
            y: data.midPoint.y - baseMidpoint.y,
          },
          curveControlOffsets: nextOffsets,
        },
      });
    };
    const onUp = () => {
      const current = useConductorStore.getState().elements.find((element) => element.id === connectorId);
      if (current) void persistConfig(current, current.config);
      cleanup();
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  }, [connectors, persistConfig, toCanvasPoint, updateElement]);

  const handleElbowSegmentPointerDown = useCallback((connectorId: string, segmentIndex: number, orientation: "horizontal" | "vertical", event: React.PointerEvent<SVGRectElement>) => {
    event.stopPropagation();
    event.preventDefault();
    const current = useConductorStore.getState().elements.find((element) => element.id === connectorId);
    if (!current || current.metadata.locked === true) return;
    const data = getComputedConnectorData(current, elements);
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
        if (!candidateSource || !candidateTarget) continue;
        const candidateData = getComputedConnectorData(candidate, state.elements);
        if (candidateData?.routingMode === "elbow" && candidateData.elbowPoints) {
          candidateRoutes.push(candidateData.elbowPoints);
        }
      }
      const zoom = Number.isFinite(canvasTransformState.zoom) && canvasTransformState.zoom > 0
        ? canvasTransformState.zoom
        : 1;
      const proposedCoordinate = orientation === "horizontal" ? cursor.y : cursor.x;
      const threshold = 12 / zoom;
      const ownRouteSnap = snapElbowSegmentToAdjacentParallel(
        proposedCoordinate,
        orientation,
        points,
        segmentIndex,
        threshold,
      );
      const snap = ownRouteSnap.snapped
        ? ownRouteSnap
        : snapElbowSegmentCoordinate(
            proposedCoordinate,
            orientation,
            points[segmentIndex],
            points[segmentIndex + 1],
            candidateRoutes,
            threshold,
          );
      const waypoints = moveElbowSegment(
        points,
        segmentIndex,
        orientation,
        snap.coordinate,
      ).slice(1, -1);
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
    const computed = getComputedConnectorData(connector, elements);
    if (!computed) return null;
    const candidate = hitTestNode(dragPoint);
    const previewEndpoint = createConnectorEndpointAtPoint(dragPoint, candidate, elements);
    const previewConnector: CanvasElement = {
      ...connector,
      config: { ...connector.config, [dragState.endpoint]: previewEndpoint, waypoints: undefined },
    };
    return getComputedConnectorData(previewConnector, elements);
  }, [dragState, dragPoint, connectors, elements, hitTestNode]);

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
            <path d={dragPreview.path} fill="none" stroke="var(--conductor-accent)" strokeWidth={2} strokeDasharray="6 4" strokeLinecap="round" opacity={0.85} />
            <circle cx={dragState?.kind === "endpoint" && dragState.endpoint === "source" ? dragPreview.sourceReference.x : dragPreview.targetReference.x} cy={dragState?.kind === "endpoint" && dragState.endpoint === "source" ? dragPreview.sourceReference.y : dragPreview.targetReference.y} r={6} fill="var(--canvas-bg)" stroke="var(--conductor-accent)" strokeWidth={2} />
          </g>
        )}

      </svg>

      {selectedConnector && toolbarAnchor && !dragState && (
        <div
          style={{
            position: "absolute",
            left: toolbarAnchor.x,
            top: toolbarAnchor.y - 18 * inverseZoom,
            zIndex: 7,
            pointerEvents: "none",
            transform: `scale(${inverseZoom}) translate(-50%, -100%)`,
            transformOrigin: "top left",
          }}
        >
          <ConnectorToolbar
            connector={selectedConnector}
            labelDraft={labelDraft}
            onLabelDraftChange={setLabelDraft}
            onPatch={patchSelectedConnector}
            onDelete={deleteSelectedConnector}
            onDismiss={() => setSelectedElementId(null)}
          />
        </div>
      )}
    </>
  );
};
