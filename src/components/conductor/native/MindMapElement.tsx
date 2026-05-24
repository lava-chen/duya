"use client";

import React, { useCallback, useMemo, useState, useRef, useEffect } from "react";
import type { CanvasElement } from "@/types/conductor";
import type { MindMapTreeNode } from "@/types/canvas-node";
import { useConductorStore } from "@/stores/conductor-store";
import {
  layoutMindMap,
  computeBezierBranchPath,
  type LayoutNode,
} from "@/conductor/canvas/mindmap-layout";

function generateNodeId(): string {
  return `mm-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

const NODE_PADDING_X = 12;
const NODE_PADDING_Y = 6;
const COLLAPSE_BUTTON_SIZE = 14;
const FONT_SIZE = 13;

function estimateTextWidth(text: string): number {
  return text.length * 7.5 + NODE_PADDING_X * 2;
}

interface MindMapElementProps {
  element: CanvasElement;
}

export const MindMapElement: React.FC<MindMapElementProps> = ({ element }) => {
  const { updateElement, selectedElementId } = useConductorStore();
  const [editingNodeId, setEditingNodeId] = useState<string | null>(null);
  const [editText, setEditText] = useState("");
  const editInputRef = useRef<HTMLInputElement>(null);

  const rootNode = (element.config.rootNode as MindMapTreeNode) || {
    id: "root",
    text: "Mind Map",
    children: [],
  };

  const layoutDirection = (element.config.layoutDirection as string) || "right";
  const branchColors = (element.config.branchColors as string[]) || undefined;

  const layout = useMemo(() => {
    return layoutMindMap(rootNode as MindMapTreeNode, {
      direction: layoutDirection as "right" | "left" | "both" | "tree",
      branchColors,
    });
  }, [rootNode, layoutDirection, branchColors]);

  const { nodes, edges, totalWidth, totalHeight } = layout;

  const padding = 40;
  const svgWidth = totalWidth + padding * 2;
  const svgHeight = totalHeight + padding * 2;

  const updateRootNode = useCallback(
    (newRoot: MindMapTreeNode) => {
      updateElement(element.id, {
        config: { ...element.config, rootNode: newRoot },
      });
    },
    [element.id, element.config, updateElement]
  );

  const updateNodeText = useCallback(
    (nodeId: string, text: string) => {
      function updateTextInTree(node: MindMapTreeNode): MindMapTreeNode {
        if (node.id === nodeId) {
          return { ...node, text };
        }
        return {
          ...node,
          children: node.children.map(updateTextInTree),
        };
      }
      updateRootNode(updateTextInTree(rootNode as MindMapTreeNode));
    },
    [rootNode, updateRootNode]
  );

  const addChildNode = useCallback(
    (parentId: string) => {
      const newNode: MindMapTreeNode = {
        id: generateNodeId(),
        text: "New node",
        children: [],
      };
      function addChildInTree(node: MindMapTreeNode): MindMapTreeNode {
        if (node.id === parentId) {
          return {
            ...node,
            collapsed: false,
            children: [...node.children, newNode],
          };
        }
        return {
          ...node,
          children: node.children.map(addChildInTree),
        };
      }
      updateRootNode(addChildInTree(rootNode as MindMapTreeNode));
    },
    [rootNode, updateRootNode]
  );

  const removeNode = useCallback(
    (nodeId: string) => {
      if (nodeId === "root") return;
      function removeFromTree(node: MindMapTreeNode): MindMapTreeNode {
        return {
          ...node,
          children: node.children
            .filter((child) => child.id !== nodeId)
            .map(removeFromTree),
        };
      }
      updateRootNode(removeFromTree(rootNode as MindMapTreeNode));
    },
    [rootNode, updateRootNode]
  );

  const toggleCollapse = useCallback(
    (nodeId: string) => {
      function toggleInTree(node: MindMapTreeNode): MindMapTreeNode {
        if (node.id === nodeId) {
          return { ...node, collapsed: !node.collapsed };
        }
        return {
          ...node,
          children: node.children.map(toggleInTree),
        };
      }
      updateRootNode(toggleInTree(rootNode as MindMapTreeNode));
    },
    [rootNode, updateRootNode]
  );

  const handleDoubleClick = useCallback(
    (nodeId: string, currentText: string) => {
      setEditingNodeId(nodeId);
      setEditText(currentText);
    },
    []
  );

  const handleEditBlur = useCallback(() => {
    if (editingNodeId && editText.trim()) {
      updateNodeText(editingNodeId, editText.trim());
    }
    setEditingNodeId(null);
  }, [editingNodeId, editText, updateNodeText]);

  const handleEditKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "Enter") {
        handleEditBlur();
      }
      if (e.key === "Escape") {
        setEditingNodeId(null);
      }
    },
    [handleEditBlur]
  );

  const handleContextMenu = useCallback(
    (e: React.MouseEvent, nodeId: string) => {
      e.preventDefault();
      e.stopPropagation();
      addChildNode(nodeId);
    },
    [addChildNode]
  );

  useEffect(() => {
    if (editingNodeId && editInputRef.current) {
      editInputRef.current.focus();
      editInputRef.current.select();
    }
  }, [editingNodeId]);

  const isSelected = selectedElementId === element.id;

  function getNodeDirection(
    node: LayoutNode,
    rootLayoutNode: LayoutNode | undefined
  ): "right" | "left" {
    if (!rootLayoutNode) return "right";
    if (layoutDirection === "left") return "left";
    if (layoutDirection === "right") return "right";
    if (node.x >= rootLayoutNode.x) return "right";
    return "left";
  }

  const rootLayoutNode = nodes.find((n) => n.id === "root" && n.depth === 0);

  return (
    <svg
      width={svgWidth}
      height={svgHeight}
      viewBox={`0 0 ${svgWidth} ${svgHeight}`}
      style={{ display: "block", overflow: "visible" }}
    >
      <g transform={`translate(${padding}, ${padding})`}>
        {edges.map((edge, idx) => {
          const dir = getNodeDirection(edge.to, rootLayoutNode);
          const fromX = edge.from.x + edge.from.width;
          const fromY = edge.from.y + edge.from.height / 2;
          const toX = edge.to.x;
          const toY = edge.to.y + edge.to.height / 2;
          const pathD =
            dir === "right"
              ? computeBezierBranchPath(fromX, fromY, toX, toY, "right")
              : computeBezierBranchPath(
                  edge.from.x,
                  fromY,
                  toX + edge.to.width,
                  toY,
                  "left"
                );
          return (
            <path
              key={`edge-${idx}`}
              d={pathD}
              fill="none"
              stroke={edge.color}
              strokeWidth={2}
              strokeLinecap="round"
              style={{ pointerEvents: "none" }}
            />
          );
        })}

        {nodes.map((node) => {
          const nodeW = estimateTextWidth(node.text);
          const nodeH = 28;
          const isEditing = editingNodeId === node.id;
          const hasChildren = rootNode &&
            (function hasKids(n: MindMapTreeNode, targetId: string): boolean {
              if (n.id === targetId) return n.children.length > 0;
              return n.children.some((c) => hasKids(c, targetId));
            })(rootNode as MindMapTreeNode, node.id);
          const isCollapsed = node.collapsed;

          const dir = getNodeDirection(node, rootLayoutNode);

          return (
            <g
              key={node.id}
              transform={`translate(${node.x}, ${node.y})`}
              onDoubleClick={() => handleDoubleClick(node.id, node.text)}
              onContextMenu={(e) => handleContextMenu(e, node.id)}
              style={{ cursor: isSelected ? "pointer" : "default" }}
            >
              {hasChildren && (
                <g
                  onClick={(e) => {
                    e.stopPropagation();
                    toggleCollapse(node.id);
                  }}
                  style={{ cursor: "pointer" }}
                  transform={`translate(${dir === "right" ? node.width - COLLAPSE_BUTTON_SIZE - 2 : -COLLAPSE_BUTTON_SIZE - 2}, ${nodeH / 2 - COLLAPSE_BUTTON_SIZE / 2})`}
                >
                  <circle
                    cx={COLLAPSE_BUTTON_SIZE / 2}
                    cy={COLLAPSE_BUTTON_SIZE / 2}
                    r={COLLAPSE_BUTTON_SIZE / 2}
                    fill="var(--main-bg)"
                    stroke="var(--border)"
                    strokeWidth={1}
                  />
                  <text
                    x={COLLAPSE_BUTTON_SIZE / 2}
                    y={COLLAPSE_BUTTON_SIZE / 2 + 1}
                    textAnchor="middle"
                    dominantBaseline="central"
                    fontSize={10}
                    fill="var(--muted)"
                    style={{ pointerEvents: "none" }}
                  >
                    {isCollapsed ? "+" : "−"}
                  </text>
                </g>
              )}

              {isEditing ? (
                <foreignObject
                  x={0}
                  y={0}
                  width={Math.max(nodeW, 60)}
                  height={nodeH}
                >
                  <input
                    ref={editInputRef}
                    value={editText}
                    onChange={(e) => setEditText(e.target.value)}
                    onBlur={handleEditBlur}
                    onKeyDown={handleEditKeyDown}
                    style={{
                      width: "100%",
                      height: "100%",
                      border: `2px solid var(--accent)`,
                      borderRadius: "6px",
                      padding: "2px 8px",
                      fontSize: `${FONT_SIZE}px`,
                      fontFamily: "inherit",
                      outline: "none",
                      background: "var(--main-bg)",
                      color: "var(--text)",
                      boxSizing: "border-box",
                    }}
                  />
                </foreignObject>
              ) : (
                <>
                  <rect
                    x={0}
                    y={0}
                    width={nodeW}
                    height={nodeH}
                    rx={6}
                    ry={6}
                    fill={
                      node.depth === 0
                        ? node.branchColor
                        : "var(--main-bg)"
                    }
                    stroke={node.depth === 0 ? "transparent" : node.branchColor}
                    strokeWidth={node.depth === 0 ? 0 : 1.5}
                  />
                  <text
                    x={nodeW / 2}
                    y={nodeH / 2 + 1}
                    textAnchor="middle"
                    dominantBaseline="central"
                    fontSize={FONT_SIZE}
                    fontFamily="inherit"
                    fill={
                      node.depth === 0
                        ? "#fff"
                        : "var(--text)"
                    }
                    fontWeight={node.depth === 0 ? 600 : 400}
                    style={{ pointerEvents: "none" }}
                  >
                    {node.text}
                  </text>
                </>
              )}
            </g>
          );
        })}
      </g>
    </svg>
  );
};