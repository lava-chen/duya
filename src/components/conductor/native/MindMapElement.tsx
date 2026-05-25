"use client";

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { CanvasElement } from "@/types/conductor";
import type { MindMapTreeNode } from "@/types/canvas-node";
import { updateElementContent } from "@/lib/conductor-ipc";
import { useConductorStore } from "@/stores/conductor-store";
import {
  computeBezierBranchPath,
  computeElbowBranchPath,
  layoutMindMap,
  type LayoutNode,
} from "@/conductor/canvas/mindmap-layout";
import { MindMapToolbar } from "./MindMapToolbar";

function generateNodeId(): string {
  return `mm-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function updateTree(node: MindMapTreeNode, nodeId: string, updater: (node: MindMapTreeNode) => MindMapTreeNode): MindMapTreeNode {
  if (node.id === nodeId) return updater(node);
  return { ...node, children: node.children.map((child) => updateTree(child, nodeId, updater)) };
}

function removeNode(root: MindMapTreeNode, nodeId: string): MindMapTreeNode {
  return { ...root, children: root.children.filter((child) => child.id !== nodeId).map((child) => removeNode(child, nodeId)) };
}

const DEFAULT_BRANCH_COLORS = ["#6D5EF8", "#00A6F4", "#00B894", "#FF9F1A", "#FF4757", "#8C6AE6", "#2C97DE", "#009688"];
const BASE_NODE_HEIGHT = 42;
const ROOT_FONT_SIZE = 28;
const CHILD_FONT_SIZE = 18;
const NODE_PADDING_X = 18;
const COLLAPSE_BUTTON_SIZE = 20;

function estimateTextWidth(text: string, isRoot: boolean): number {
  const fontSize = isRoot ? ROOT_FONT_SIZE : CHILD_FONT_SIZE;
  const wideChars = Array.from(text).reduce((sum, char) => sum + (char.charCodeAt(0) > 255 ? 1.0 : 0.58), 0);
  return Math.max(isRoot ? 120 : 92, wideChars * fontSize + NODE_PADDING_X * 2);
}

function getNodeDirection(node: LayoutNode, rootLayoutNode: LayoutNode | undefined, layoutDirection: "right" | "left" | "both" | "tree"): "right" | "left" {
  if (!rootLayoutNode) return "right";
  if (layoutDirection === "left") return "left";
  if (layoutDirection === "right") return "right";
  return node.x >= rootLayoutNode.x ? "right" : "left";
}

interface MindMapElementProps {
  element: CanvasElement;
}

export const MindMapElement: React.FC<MindMapElementProps> = ({ element }) => {
  const updateElement = useConductorStore((state) => state.updateElement);
  const selectedElementId = useConductorStore((state) => state.selectedElementId);
  const setSelectedElementId = useConductorStore((state) => state.setSelectedElementId);
  const activeCanvasId = useConductorStore((state) => state.activeCanvasId);
  const setUiError = useConductorStore((state) => state.setUiError);

  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [editingNodeId, setEditingNodeId] = useState<string | null>(null);
  const [editText, setEditText] = useState("");
  const composingRef = useRef(false);
  const editInputRef = useRef<HTMLInputElement>(null);

  const rootNode = (element.config.rootNode as MindMapTreeNode) || { id: "root", text: "Mind Map", children: [] };
  const layoutDirection = ((element.config.layoutDirection as string) || "right") as "right" | "left" | "both" | "tree";
  const branchColors = ((element.config.branchColors as string[]) || DEFAULT_BRANCH_COLORS).length > 0
    ? ((element.config.branchColors as string[]) || DEFAULT_BRANCH_COLORS)
    : DEFAULT_BRANCH_COLORS;
  const branchStrokeWidth = Math.min(7, Math.max(2, Number((element.config.branchStrokeWidth as number) ?? 3)));
  const branchStyle = ((element.config.branchStyle as "curve" | "elbow") || "curve");

  const layout = useMemo(() => layoutMindMap(rootNode, {
    direction: layoutDirection,
    branchColors,
    branchStrokeWidth,
    branchStyle,
    levelGap: 108,
    siblingGap: 20,
    nodeHeight: BASE_NODE_HEIGHT,
  }), [rootNode, layoutDirection, branchColors, branchStrokeWidth, branchStyle]);

  const { nodes, edges, totalWidth, totalHeight } = layout;
  const padding = 80;
  const svgWidth = totalWidth + padding * 2;
  const svgHeight = totalHeight + padding * 2;
  const isElementSelected = selectedElementId === element.id;
  const rootLayoutNode = nodes.find((n) => n.id === rootNode.id && n.depth === 0);
  const selectedNode = nodes.find((n) => n.id === selectedNodeId) || null;

  useEffect(() => {
    if (isElementSelected) {
      setSelectedNodeId((current) => current ?? rootNode.id);
    } else {
      setSelectedNodeId(null);
      setEditingNodeId(null);
    }
  }, [isElementSelected, rootNode.id]);

  const persistConfigPatch = useCallback((patch: Record<string, unknown>) => {
    const nextConfig = { ...element.config, ...patch };
    updateElement(element.id, { config: nextConfig });
    if (!activeCanvasId) return;
    updateElementContent(element.id, activeCanvasId, patch)
      .catch((err) => setUiError(`Save mind map failed: ${err instanceof Error ? err.message : err}`));
  }, [activeCanvasId, element.config, element.id, setUiError, updateElement]);

  const persistRootNode = useCallback((newRoot: MindMapTreeNode) => {
    persistConfigPatch({ rootNode: newRoot });
  }, [persistConfigPatch]);

  const addChildNode = useCallback((parentId: string, text = "New node") => {
    const newNode: MindMapTreeNode = { id: generateNodeId(), text, children: [] };
    const newRoot = updateTree(rootNode, parentId, (node) => ({ ...node, collapsed: false, children: [...node.children, newNode] }));
    persistRootNode(newRoot);
    setSelectedNodeId(newNode.id);
    setEditingNodeId(newNode.id);
    setEditText(text);
  }, [persistRootNode, rootNode]);

  const addSiblingNode = useCallback((nodeId: string, text = "New node") => {
    const newNode: MindMapTreeNode = { id: generateNodeId(), text, children: [] };
    const insert = (node: MindMapTreeNode): MindMapTreeNode => {
      const nextChildren: MindMapTreeNode[] = [];
      for (const child of node.children) {
        nextChildren.push(insert(child));
        if (child.id === nodeId) nextChildren.push(newNode);
      }
      return { ...node, children: nextChildren };
    };
    const nextRoot = rootNode.id === nodeId
      ? { ...rootNode, collapsed: false, children: [...rootNode.children, newNode] }
      : insert(rootNode);
    persistRootNode(nextRoot);
    setSelectedNodeId(newNode.id);
    setEditingNodeId(newNode.id);
    setEditText(text);
  }, [persistRootNode, rootNode]);

  const commitNodeText = useCallback((nodeId: string, text: string) => {
    const cleanText = text.trim() || "Untitled";
    persistRootNode(updateTree(rootNode, nodeId, (node) => ({ ...node, text: cleanText })));
  }, [persistRootNode, rootNode]);

  const finishEditing = useCallback(() => {
    if (!editingNodeId || composingRef.current) return;
    commitNodeText(editingNodeId, editText);
    setEditingNodeId(null);
  }, [commitNodeText, editingNodeId, editText]);

  useEffect(() => {
    if (!editingNodeId || !editInputRef.current) return;
    editInputRef.current.focus();
  }, [editingNodeId]);

  return (
    <svg
      width={svgWidth}
      height={svgHeight}
      viewBox={`0 0 ${svgWidth} ${svgHeight}`}
      style={{ display: "block", overflow: "visible" }}
      onMouseDown={() => {
        if (!isElementSelected) setSelectedElementId(element.id);
      }}
    >
      <g transform={`translate(${padding}, ${padding})`}>
        {selectedNode && isElementSelected && !editingNodeId && (
          <MindMapToolbar
            x={selectedNode.x - 12}
            y={selectedNode.y - 56}
            branchColors={branchColors}
            activeColor={selectedNode.branchColor}
            branchStrokeWidth={branchStrokeWidth}
            branchStyle={branchStyle}
            onColorChange={(color) => persistConfigPatch({ branchColors: [color, ...branchColors.filter((c) => c !== color)] })}
            onStrokeWidthChange={(width) => persistConfigPatch({ branchStrokeWidth: width })}
            onBranchStyleChange={(style) => persistConfigPatch({ branchStyle: style })}
          />
        )}

        {edges.map((edge, idx) => {
          const fromIsRoot = edge.from.depth === 0;
          const toIsRoot = edge.to.depth === 0;
          const fromW = estimateTextWidth(edge.from.text, fromIsRoot);
          const toW = estimateTextWidth(edge.to.text, toIsRoot);
          const dir = getNodeDirection(edge.to, rootLayoutNode, layoutDirection);
          const fromX = dir === "right" ? edge.from.x + fromW : edge.from.x;
          const fromY = edge.from.y + BASE_NODE_HEIGHT / 2;
          const toX = dir === "right" ? edge.to.x : edge.to.x + toW;
          const toY = edge.to.y + BASE_NODE_HEIGHT / 2;
          return (
            <path
              key={`edge-${idx}`}
              d={branchStyle === "elbow"
                ? computeElbowBranchPath(fromX, fromY, toX, toY, dir)
                : computeBezierBranchPath(fromX, fromY, toX, toY, dir)}
              fill="none"
              stroke={edge.color}
              strokeWidth={edge.strokeWidth}
              strokeLinecap="round"
              strokeLinejoin="round"
              style={{ pointerEvents: "none", opacity: 0.97 }}
            />
          );
        })}

        {nodes.map((node) => {
          const isRoot = node.depth === 0;
          const nodeW = estimateTextWidth(node.text, isRoot);
          const isEditing = editingNodeId === node.id;
          const isNodeSelected = selectedNodeId === node.id && isElementSelected;
          const dir = getNodeDirection(node, rootLayoutNode, layoutDirection);
          const fontSize = isRoot ? ROOT_FONT_SIZE : CHILD_FONT_SIZE;
          const fill = isRoot ? node.branchColor : "var(--main-bg)";
          const stroke = isRoot ? "transparent" : (isNodeSelected ? node.branchColor : "rgba(108,124,148,0.38)");
          const strokeWidth = isRoot ? 0 : (isNodeSelected ? 2 : 1);

          return (
            <g
              key={node.id}
              transform={`translate(${node.x}, ${node.y})`}
              style={{ cursor: isEditing ? "text" : "default" }}
              onMouseDown={(e) => {
                e.stopPropagation();
                if (!isElementSelected) setSelectedElementId(element.id);
                setSelectedNodeId(node.id);
              }}
              onDoubleClick={(e) => {
                e.stopPropagation();
                setSelectedNodeId(node.id);
                setEditingNodeId(node.id);
                setEditText(node.text);
              }}
            >
              {!isRoot && node.children.length > 0 && (
                <g
                  onMouseDown={(e) => e.stopPropagation()}
                  onClick={(e) => {
                    e.stopPropagation();
                    persistRootNode(updateTree(rootNode, node.id, (current) => ({ ...current, collapsed: !current.collapsed })));
                  }}
                  transform={`translate(${dir === "right" ? nodeW + 8 : -COLLAPSE_BUTTON_SIZE - 8}, ${BASE_NODE_HEIGHT / 2 - COLLAPSE_BUTTON_SIZE / 2})`}
                  style={{ cursor: "pointer" }}
                >
                  <circle cx={COLLAPSE_BUTTON_SIZE / 2} cy={COLLAPSE_BUTTON_SIZE / 2} r={COLLAPSE_BUTTON_SIZE / 2} fill="var(--main-bg)" stroke={node.branchColor} strokeWidth={1.5} />
                  <text x={COLLAPSE_BUTTON_SIZE / 2} y={COLLAPSE_BUTTON_SIZE / 2 + 1} textAnchor="middle" dominantBaseline="central" fontSize={14} fill={node.branchColor} style={{ pointerEvents: "none" }}>
                    {node.collapsed ? "+" : "-"}
                  </text>
                </g>
              )}

              {isNodeSelected && !isEditing && (
                <g
                  onMouseDown={(e) => e.stopPropagation()}
                  onClick={(e) => {
                    e.stopPropagation();
                    addChildNode(node.id);
                  }}
                  transform={`translate(${dir === "right" ? nodeW + 30 : -52}, ${BASE_NODE_HEIGHT / 2 - 11})`}
                  style={{ cursor: "pointer" }}
                >
                  <circle cx={11} cy={11} r={11} fill="var(--main-bg)" stroke={node.branchColor} strokeWidth={1.5} />
                  <path d="M11 6.5v9M6.5 11h9" stroke={node.branchColor} strokeWidth={1.8} strokeLinecap="round" />
                </g>
              )}

              {isEditing ? (
                <foreignObject x={0} y={0} width={Math.max(nodeW, 130)} height={BASE_NODE_HEIGHT}>
                  <input
                    ref={editInputRef}
                    value={editText}
                    onChange={(e) => setEditText(e.target.value)}
                    onBlur={() => {
                      if (composingRef.current) return;
                      finishEditing();
                    }}
                    onCompositionStart={() => { composingRef.current = true; }}
                    onCompositionEnd={() => { composingRef.current = false; }}
                    onKeyDown={(e) => {
                      if (composingRef.current || e.nativeEvent.isComposing) return;
                      if (e.key === "Escape") {
                        e.preventDefault();
                        setEditingNodeId(null);
                        return;
                      }
                      if (e.key === "Tab") {
                        e.preventDefault();
                        if (!editingNodeId) return;
                        commitNodeText(editingNodeId, editText);
                        setEditingNodeId(null);
                        addChildNode(editingNodeId);
                        return;
                      }
                      if (e.key === "Enter") {
                        e.preventDefault();
                        if (!editingNodeId) return;
                        commitNodeText(editingNodeId, editText);
                        setEditingNodeId(null);
                        if (editingNodeId === rootNode.id) addChildNode(editingNodeId);
                        else addSiblingNode(editingNodeId);
                        return;
                      }
                      if ((e.key === "Backspace" || e.key === "Delete") && !editText.trim() && editingNodeId !== rootNode.id) {
                        e.preventDefault();
                        persistRootNode(removeNode(rootNode, editingNodeId));
                        setEditingNodeId(null);
                      }
                    }}
                    style={{
                      width: "100%",
                      height: "100%",
                      border: `2px solid ${node.branchColor}`,
                      borderRadius: isRoot ? "11px" : "8px",
                      padding: "2px 12px",
                      fontSize,
                      fontWeight: isRoot ? 700 : 500,
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
                  <rect x={0} y={0} width={nodeW} height={BASE_NODE_HEIGHT} rx={isRoot ? 11 : 8} fill={fill} stroke={stroke} strokeWidth={strokeWidth} />
                  <text
                    x={nodeW / 2}
                    y={BASE_NODE_HEIGHT / 2 + 1}
                    textAnchor="middle"
                    dominantBaseline="central"
                    fontSize={fontSize}
                    fontFamily="inherit"
                    fontWeight={isRoot ? 700 : 500}
                    fill={isRoot ? "#F7F9FF" : "var(--text)"}
                    style={{ pointerEvents: "none", userSelect: "none" }}
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
