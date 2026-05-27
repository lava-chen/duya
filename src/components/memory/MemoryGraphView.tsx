"use client";

import { useRef, useEffect, useState, useCallback } from "react";
import type { WikiIndexEntry } from "@/types/memory";

interface MemoryGraphViewProps {
  nodes: WikiIndexEntry[];
  onSelectNode: (nodePath: string) => void;
}

interface NodePosition {
  x: number;
  y: number;
  vx: number;
  vy: number;
}

export function MemoryGraphView({ nodes, onSelectNode }: MemoryGraphViewProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [hoveredId, setHoveredId] = useState<string | null>(null);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [zoom, setZoom] = useState(1);
  const isPanning = useRef(false);
  const panStart = useRef({ x: 0, y: 0 });
  const positionsRef = useRef<Map<string, NodePosition>>(new Map());
  const animFrameRef = useRef<number>(0);

  const NODE_RADIUS = 28;
  const TYPE_COLORS: Record<string, string> = {
    concept: "#8b5cf6",
    module: "#3b82f6",
    class: "#06b6d4",
    function: "#10b981",
    workflow: "#f59e0b",
    devops: "#ef4444",
    inbox: "#6b7280",
  };

  useEffect(() => {
    if (nodes.length === 0) return;
    const posMap = positionsRef.current;
    const width = containerRef.current?.clientWidth ?? 800;
    const height = containerRef.current?.clientHeight ?? 600;

    for (const node of nodes) {
      if (!posMap.has(node.id)) {
        posMap.set(node.id, {
          x: width / 2 + (Math.random() - 0.5) * 200,
          y: height / 2 + (Math.random() - 0.5) * 200,
          vx: 0,
          vy: 0,
        });
      }
    }

    for (const [id] of posMap) {
      if (!nodes.find((n) => n.id === id)) {
        posMap.delete(id);
      }
    }
  }, [nodes]);

  const simulate = useCallback(() => {
    const posMap = positionsRef.current;
    const nodeEntries = nodes.filter((n) => posMap.has(n.id));
    const width = containerRef.current?.clientWidth ?? 800;
    const height = containerRef.current?.clientHeight ?? 600;

    for (const node of nodeEntries) {
      const pos = posMap.get(node.id)!;
      pos.x += pos.vx;
      pos.y += pos.vy;
      pos.vx *= 0.9;
      pos.vy *= 0.9;

      const cx = width / 2;
      const cy = height / 2;
      const fx = (cx - pos.x) * 0.001;
      const fy = (cy - pos.y) * 0.001;
      pos.vx += fx;
      pos.vy += fy;
    }

    for (let i = 0; i < nodeEntries.length; i++) {
      for (let j = i + 1; j < nodeEntries.length; j++) {
        const a = posMap.get(nodeEntries[i].id)!;
        const b = posMap.get(nodeEntries[j].id)!;
        const dx = b.x - a.x;
        const dy = b.y - a.y;
        const dist = Math.sqrt(dx * dx + dy * dy);
        const minDist = NODE_RADIUS * 3;
        if (dist < minDist && dist > 0) {
          const force = (minDist - dist) / dist * 0.1;
          a.vx -= dx * force;
          a.vy -= dy * force;
          b.vx += dx * force;
          b.vy += dy * force;
        }
      }
    }
  }, [nodes]);

  const draw = useCallback(() => {
    const canvas = canvasRef.current;
    const container = containerRef.current;
    if (!canvas || !container) return;

    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    canvas.width = container.clientWidth * window.devicePixelRatio;
    canvas.height = container.clientHeight * window.devicePixelRatio;
    canvas.style.width = `${container.clientWidth}px`;
    canvas.style.height = `${container.clientHeight}px`;
    ctx.scale(window.devicePixelRatio, window.devicePixelRatio);

    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.save();
    ctx.translate(pan.x, pan.y);
    ctx.scale(zoom, zoom);

    const posMap = positionsRef.current;

    for (const node of nodes) {
      const pos = posMap.get(node.id);
      if (!pos) continue;

      const x = pos.x;
      const y = pos.y;
      const isSelected = selectedId === node.id;
      const isHovered = hoveredId === node.id;
      const color = TYPE_COLORS[node.type] || TYPE_COLORS.inbox;

      ctx.beginPath();
      ctx.arc(x, y, NODE_RADIUS + (isSelected || isHovered ? 3 : 0), 0, Math.PI * 2);
      ctx.fillStyle = isSelected ? color : `${color}33`;
      ctx.strokeStyle = color;
      ctx.lineWidth = isSelected ? 2.5 : isHovered ? 2 : 1.5;
      ctx.fill();
      ctx.stroke();

      ctx.fillStyle = "var(--text, #e4e4e7)";
      ctx.font = `${isSelected ? 11 : 10}px system-ui`;
      ctx.textAlign = "center";

      const label = node.title.length > 14 ? node.title.slice(0, 13) + "..." : node.title;
      ctx.fillText(label, x, y + NODE_RADIUS + 14);

      if (isSelected || isHovered) {
        ctx.font = "9px system-ui";
        ctx.fillStyle = "var(--text-tertiary, #71717a)";
        ctx.fillText(node.type, x, y + NODE_RADIUS + 26);
      }
    }

    ctx.restore();
  }, [nodes, selectedId, hoveredId, pan, zoom]);

  useEffect(() => {
    let running = true;
    const loop = () => {
      if (!running) return;
      simulate();
      draw();
      animFrameRef.current = requestAnimationFrame(loop);
    };
    loop();
    return () => {
      running = false;
      cancelAnimationFrame(animFrameRef.current);
    };
  }, [simulate, draw]);

  const getNodeAt = (mx: number, my: number): WikiIndexEntry | null => {
    const ctx = canvasRef.current?.getContext("2d");
    if (!ctx) return null;

    const wx = (mx - pan.x) / zoom;
    const wy = (my - pan.y) / zoom;
    const posMap = positionsRef.current;

    for (const node of nodes) {
      const pos = posMap.get(node.id);
      if (!pos) continue;
      const dx = wx - pos.x;
      const dy = wy - pos.y;
      if (Math.sqrt(dx * dx + dy * dy) <= NODE_RADIUS + 4) {
        return node;
      }
    }
    return null;
  };

  const handleMouseDown = (e: React.MouseEvent) => {
    isPanning.current = true;
    panStart.current = { x: e.clientX - pan.x, y: e.clientY - pan.y };
  };

  const handleMouseMove = (e: React.MouseEvent) => {
    if (isPanning.current) {
      setPan({ x: e.clientX - panStart.current.x, y: e.clientY - panStart.current.y });
    } else {
      const node = getNodeAt(e.nativeEvent.offsetX, e.nativeEvent.offsetY);
      setHoveredId(node?.id ?? null);
    }
  };

  const handleMouseUp = (e: React.MouseEvent) => {
    if (isPanning.current) {
      const dx = Math.abs(e.clientX - panStart.current.x - pan.x);
      const dy = Math.abs(e.clientY - panStart.current.y - pan.y);
      if (dx < 3 && dy < 3) {
        const node = getNodeAt(e.nativeEvent.offsetX, e.nativeEvent.offsetY);
        if (node) {
          setSelectedId(node.id);
          onSelectNode(node.path);
        } else {
          setSelectedId(null);
        }
      }
    }
    isPanning.current = false;
  };

  const handleWheel = (e: React.WheelEvent) => {
    e.preventDefault();
    const delta = e.deltaY > 0 ? 0.9 : 1.1;
    setZoom((z) => Math.min(3, Math.max(0.3, z * delta)));
  };

  return (
    <div
      ref={containerRef}
      className="memory-graph-container"
      onMouseDown={handleMouseDown}
      onMouseMove={handleMouseMove}
      onMouseUp={handleMouseUp}
      onWheel={handleWheel}
    >
      <canvas ref={canvasRef} className="memory-graph-canvas" />
      {nodes.length === 0 && (
        <div className="memory-graph-empty">No nodes yet. Start a conversation and the Wiki Agent will capture memories.</div>
      )}
      <style>{`
        .memory-graph-container {
          width: 100%;
          height: 100%;
          position: relative;
          overflow: hidden;
          cursor: grab;
        }
        .memory-graph-container:active {
          cursor: grabbing;
        }
        .memory-graph-canvas {
          display: block;
        }
        .memory-graph-empty {
          position: absolute;
          top: 50%;
          left: 50%;
          transform: translate(-50%, -50%);
          color: var(--text-tertiary);
          font-size: 14px;
          text-align: center;
          max-width: 300px;
        }
      `}</style>
    </div>
  );
}