"use client";

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { CanvasElement } from "../..//types/conductor";
import type { MindMapTreeNode } from "../..//types/canvas-node";
import { updateElementContent } from "../..//ipc/conductor-ipc";
import { useConductorStore } from "../..//stores/conductor-store";
import {
  computeBezierBranchPath,
  computeElbowBranchPath,
  layoutMindMap,
  type LayoutNode,
  type LayoutDirection,
} from "../..//domain/canvas/mindmap-layout";
import { MindMapToolbar } from "./MindMapToolbar";
import { canvasTransformState } from "../CanvasArea";

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

function countDescendants(node: MindMapTreeNode): number {
  return node.children.reduce((sum, child) => sum + 1 + countDescendants(child), 0);
}

function findTreeNode(node: MindMapTreeNode, nodeId: string): MindMapTreeNode | null {
  if (node.id === nodeId) return node;
  for (const child of node.children) {
    const found = findTreeNode(child, nodeId);
    if (found) return found;
  }
  return null;
}

function findChildIndex(tree: MindMapTreeNode, childId: string): number {
  return tree.children.findIndex((c) => c.id === childId);
}

function reorderChildren(root: MindMapTreeNode, parentId: string, fromIndex: number, toIndex: number): MindMapTreeNode {
  return updateTree(root, parentId, (node) => {
    const children = [...node.children];
    if (fromIndex < 0 || fromIndex >= children.length || toIndex < 0 || toIndex >= children.length) return node;
    const [moved] = children.splice(fromIndex, 1);
    children.splice(toIndex, 0, moved);
    return { ...node, children };
  });
}

function moveToOtherSide(root: MindMapTreeNode, parentId: string, childId: string): MindMapTreeNode {
  const parent = findTreeNode(root, parentId);
  if (!parent) return root;
  const index = findChildIndex(parent, childId);
  if (index < 0) return root;
  const mid = Math.ceil(parent.children.length / 2);
  if (index < mid) {
    return reorderChildren(root, parentId, index, Math.min(mid, parent.children.length - 1));
  } else {
    return reorderChildren(root, parentId, index, Math.max(0, mid - 1));
  }
}

const DEFAULT_BRANCH_COLORS = ["#007AFF", "#FF9500", "#34C759", "#AF52DE", "#FF3B30", "#5856D6", "#5AC8FA", "#FF2D55"];
const BASE_NODE_HEIGHT = 42;
const ROOT_FONT_SIZE = 28;
const CHILD_FONT_SIZE = 18;
const NODE_PADDING_X = 18;
const COLLAPSE_BUTTON_SIZE = 20;
const REORDER_THRESHOLD_PX = 8;
const REORDER_SIDE_THRESHOLD_PX = 30;

function estimateTextWidth(text: string, isRoot: boolean): number {
  const fontSize = isRoot ? ROOT_FONT_SIZE : CHILD_FONT_SIZE;
  const wideChars = Array.from(text).reduce((sum, char) => sum + (char.charCodeAt(0) > 255 ? 1.0 : 0.58), 0);
  return Math.max(isRoot ? 120 : 92, wideChars * fontSize + NODE_PADDING_X * 2);
}

function getNodeDirection(node: LayoutNode, rootLayoutNode: LayoutNode | undefined, layoutDirection: LayoutDirection): "right" | "left" | "vertical" {
  if (layoutDirection === "vertical") return "vertical";
  if (!rootLayoutNode) return "right";
  if (layoutDirection === "left") return "left";
  if (layoutDirection === "right") return "right";
  return node.x >= rootLayoutNode.x ? "right" : "left";
}

interface DraftNode {
  id: string;
  text: string;
  parentId: string;
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
  const [draftNode, setDraftNode] = useState<DraftNode | null>(null);
  const composingRef = useRef(false);
  const editInputRef = useRef<HTMLInputElement>(null);
  const rootNodeRef = useRef<MindMapTreeNode | null>(null);

  const reorderDragRef = useRef<{
    nodeId: string;
    parentId: string;
    startClientY: number;
    startClientX: number;
    originIndex: number;
    lastIndex: number;
    moved: boolean;
  } | null>(null);

  const rootNode = (element.config.rootNode as MindMapTreeNode) || { id: "root", text: "Mind Map", children: [] };
  const layoutDirection = ((element.config.layoutDirection as string) || "right") as LayoutDirection;
  const branchColors = ((element.config.branchColors as string[]) || DEFAULT_BRANCH_COLORS).length > 0
    ? ((element.config.branchColors as string[]) || DEFAULT_BRANCH_COLORS)
    : DEFAULT_BRANCH_COLORS;
  const branchStrokeWidth = Math.min(7, Math.max(2, Number((element.config.branchStrokeWidth as number) ?? 3)));
  const branchStyle = ((element.config.branchStyle as "curve" | "elbow") || "curve");

  const workingRootNode = useMemo(() => {
    if (!draftNode) return rootNode;
    if (draftNode.parentId === rootNode.id) {
      return { ...rootNode, collapsed: false, children: [...rootNode.children, { id: draftNode.id, text: draftNode.text, children: [] }] };
    }
    return updateTree(rootNode, draftNode.parentId, (node) => ({
      ...node,
      collapsed: false,
      children: [...node.children, { id: draftNode.id, text: draftNode.text, children: [] }],
    }));
  }, [rootNode, draftNode]);

  const layout = useMemo(() => layoutMindMap(workingRootNode, {
    direction: layoutDirection,
    branchColors,
    branchStrokeWidth,
    branchStyle,
    levelGap: 108,
    siblingGap: 20,
    nodeHeight: BASE_NODE_HEIGHT,
  }), [workingRootNode, layoutDirection, branchColors, branchStrokeWidth, branchStyle]);

  const { nodes, edges, totalWidth, totalHeight } = layout;
  const padding = 80;
  const svgWidth = totalWidth + padding * 2;
  const svgHeight = totalHeight + padding * 2;
  const isElementSelected = selectedElementId === element.id;
  const rootLayoutNode = nodes.find((n) => n.id === rootNode.id && n.depth === 0);
  const selectedNode = nodes.find((n) => n.id === selectedNodeId) || null;
  const selectedTreeNode = selectedNodeId ? findTreeNode(rootNode, selectedNodeId) : null;
  rootNodeRef.current = rootNode;

  useEffect(() => {
    if (isElementSelected) {
      setSelectedNodeId((current) => current ?? rootNode.id);
    } else {
      setSelectedNodeId(null);
      setEditingNodeId(null);
      setDraftNode(null);
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

  const createDraftChild = useCallback((parentId: string) => {
    const newId = generateNodeId();
    setDraftNode({ id: newId, text: "", parentId });
    setSelectedNodeId(newId);
    setEditingNodeId(newId);
    setEditText("");
  }, []);

  const createDraftSibling = useCallback((nodeId: string) => {
    const treeNode = findTreeNode(rootNode, nodeId);
    if (!treeNode || nodeId === rootNode.id) {
      createDraftChild(findParentId(rootNode, nodeId) || rootNode.id);
      return;
    }
    const parentId = findParentId(rootNode, nodeId);
    if (!parentId) return;
    const newId = generateNodeId();
    setDraftNode({ id: newId, text: "", parentId });
    setSelectedNodeId(newId);
    setEditingNodeId(newId);
    setEditText("");
  }, [createDraftChild, rootNode]);

  function findParentId(tree: MindMapTreeNode, childId: string): string | null {
    for (const child of tree.children) {
      if (child.id === childId) return tree.id;
      const found = findParentId(child, childId);
      if (found) return found;
    }
    return null;
  }

  const commitDraftNode = useCallback((text: string) => {
    if (!draftNode) return;
    const cleanText = text.trim();
    if (!cleanText) {
      setDraftNode(null);
      setEditingNodeId(null);
      setSelectedNodeId(rootNode.id);
      return;
    }
    const newNode: MindMapTreeNode = { id: draftNode.id, text: cleanText, children: [] };
    const newRoot = draftNode.parentId === rootNode.id
      ? { ...rootNode, collapsed: false, children: [...rootNode.children, newNode] }
      : updateTree(rootNode, draftNode.parentId, (node) => ({
          ...node,
          collapsed: false,
          children: [...node.children, newNode],
        }));
    persistRootNode(newRoot);
    setDraftNode(null);
    setEditingNodeId(null);
  }, [draftNode, persistRootNode, rootNode]);

  const commitNodeText = useCallback((nodeId: string, text: string) => {
    if (draftNode && draftNode.id === nodeId) {
      commitDraftNode(text);
      return;
    }
    const cleanText = text.trim() || "Untitled";
    persistRootNode(updateTree(rootNode, nodeId, (node) => ({ ...node, text: cleanText })));
  }, [commitDraftNode, draftNode, persistRootNode, rootNode]);

  const cancelDraftNode = useCallback(() => {
    if (!draftNode) return;
    setDraftNode(null);
    setEditingNodeId(null);
    setSelectedNodeId(rootNode.id);
  }, [draftNode, rootNode.id]);

  const deleteNode = useCallback((nodeId: string) => {
    if (draftNode && draftNode.id === nodeId) {
      cancelDraftNode();
      return;
    }
    if (nodeId === rootNode.id) return;
    persistRootNode(removeNode(rootNode, nodeId));
    setSelectedNodeId(rootNode.id);
    setEditingNodeId(null);
  }, [cancelDraftNode, draftNode, persistRootNode, rootNode]);

  const toggleCollapse = useCallback((nodeId: string) => {
    const treeNode = findTreeNode(rootNode, nodeId);
    if (!treeNode || treeNode.children.length === 0) return;
    persistRootNode(updateTree(rootNode, nodeId, (current) => ({ ...current, collapsed: !current.collapsed })));
  }, [persistRootNode, rootNode]);

  const finishEditing = useCallback(() => {
    if (!editingNodeId || composingRef.current) return;
    commitNodeText(editingNodeId, editText);
    setEditingNodeId(null);
  }, [commitNodeText, editingNodeId, editText]);

  const beginReorder = useCallback((nodeId: string, parentId: string, originIndex: number, clientX: number, clientY: number) => {
    reorderDragRef.current = {
      nodeId,
      parentId,
      startClientY: clientY,
      startClientX: clientX,
      originIndex,
      lastIndex: originIndex,
      moved: false,
    };
  }, []);

  useEffect(() => {
    if (!editingNodeId || !editInputRef.current) return;
    editInputRef.current.focus();
  }, [editingNodeId]);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (!isElementSelected) return;
      if (e.key === "Escape") {
        if (editingNodeId) {
          if (draftNode) {
            cancelDraftNode();
          } else {
            setEditingNodeId(null);
          }
          return;
        }
        setSelectedNodeId(null);
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [isElementSelected, editingNodeId, draftNode, cancelDraftNode]);

  useEffect(() => {
    const handleReorderMove = (e: MouseEvent) => {
      const drag = reorderDragRef.current;
      if (!drag) return;

      const zoom = canvasTransformState.zoom || 1;
      const dy = (e.clientY - drag.startClientY) / zoom;
      const dx = (e.clientX - drag.startClientX) / zoom;

      if (!drag.moved && Math.abs(dy) < REORDER_THRESHOLD_PX) return;
      drag.moved = true;

      const parent = findTreeNode(rootNodeRef.current || rootNode, drag.parentId);
      if (!parent) return;
      const childCount = parent.children.length;
      const childHeight = BASE_NODE_HEIGHT + 20;

      const offsetIndex = Math.round(dy / childHeight);
      const targetIndex = Math.max(0, Math.min(childCount - 1, drag.originIndex + offsetIndex));

      if (targetIndex !== drag.lastIndex) {
        drag.lastIndex = targetIndex;

        if (layoutDirection === "both") {
          const absDx = Math.abs(dx);
          if (absDx > REORDER_SIDE_THRESHOLD_PX) {
            const newRoot = moveToOtherSide(rootNodeRef.current || rootNode, drag.parentId, drag.nodeId);
            rootNodeRef.current = newRoot;
            persistRootNode(newRoot);
            reorderDragRef.current = null;
            return;
          }
        }

        if (targetIndex !== drag.originIndex) {
          const newRoot = reorderChildren(rootNodeRef.current || rootNode, drag.parentId, drag.originIndex, targetIndex);
          rootNodeRef.current = newRoot;
          updateElement(element.id, { config: { ...element.config, rootNode: newRoot } });
        } else {
          rootNodeRef.current = rootNode;
          updateElement(element.id, { config: { ...element.config, rootNode } });
        }
      }
    };

    const handleReorderEnd = () => {
      const drag = reorderDragRef.current;
      if (!drag) return;
      if (drag.moved) {
        const finalRoot = rootNodeRef.current || rootNode;
        persistRootNode(finalRoot);
      }
      reorderDragRef.current = null;
    };

    window.addEventListener("mousemove", handleReorderMove);
    window.addEventListener("mouseup", handleReorderEnd);
    return () => {
      window.removeEventListener("mousemove", handleReorderMove);
      window.removeEventListener("mouseup", handleReorderEnd);
    };
  }, [element.config, element.id, layoutDirection, persistRootNode, rootNode, updateElement]);

  const handleNodeMouseDown = useCallback((nodeId: string, depth: number, e: React.MouseEvent) => {
    e.stopPropagation();
    e.preventDefault();

    if (!isElementSelected) {
      setSelectedElementId(element.id);
      return;
    }

    setSelectedNodeId(nodeId);

    if (depth === 1) {
      const parentId = findParentId(rootNode, nodeId);
      if (parentId) {
        const originIndex = findChildIndex(rootNode, nodeId);
        if (originIndex >= 0) {
          beginReorder(nodeId, parentId, originIndex, e.clientX, e.clientY);
        }
      }
    }
  }, [isElementSelected, setSelectedElementId, element.id, rootNode, beginReorder]);

  const isNodeDraft = (nodeId: string) => draftNode?.id === nodeId;

  return (
    <svg
      width={svgWidth}
      height={svgHeight}
      viewBox={`0 0 ${svgWidth} ${svgHeight}`}
      style={{ display: "block", overflow: "visible", pointerEvents: "none" }}
    >
      <g transform={`translate(${padding}, ${padding})`}>
        {edges.map((edge, idx) => {
          const fromIsRoot = edge.from.depth === 0;
          const toIsRoot = edge.to.depth === 0;
          const fromW = estimateTextWidth(edge.from.text, fromIsRoot);
          const toW = estimateTextWidth(edge.to.text, toIsRoot);
          const dir = getNodeDirection(edge.to, rootLayoutNode, layoutDirection);

          let fromX: number;
          let fromY: number;
          let toX: number;
          let toY: number;

          if (layoutDirection === "vertical") {
            fromX = edge.from.x + fromW / 2;
            fromY = edge.from.y + BASE_NODE_HEIGHT;
            toX = edge.to.x + toW / 2;
            toY = edge.to.y;
          } else {
            fromX = dir === "right" ? edge.from.x + fromW : edge.from.x;
            fromY = edge.from.y + BASE_NODE_HEIGHT / 2;
            toX = dir === "right" ? edge.to.x : edge.to.x + toW;
            toY = edge.to.y + BASE_NODE_HEIGHT / 2;
          }

          const pathDir = layoutDirection === "vertical" ? "vertical" : dir;

          return (
            <path
              key={`edge-${idx}`}
              d={branchStyle === "elbow"
                ? computeElbowBranchPath(fromX, fromY, toX, toY, pathDir)
                : computeBezierBranchPath(fromX, fromY, toX, toY, pathDir)}
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

          const nodeIsDraft = isNodeDraft(node.id);

          return (
            <g
              key={node.id}
              transform={`translate(${node.x}, ${node.y})`}
              style={{ cursor: isEditing ? "text" : isRoot ? "move" : node.depth === 1 && !nodeIsDraft ? "grab" : "pointer", pointerEvents: "auto" }}
              onMouseDown={(e) => {
                if (isRoot) {
                  return;
                }
                handleNodeMouseDown(node.id, node.depth, e);
              }}
              onDoubleClick={(e) => {
                if (isRoot) return;
                e.stopPropagation();
                setSelectedNodeId(node.id);
                setEditingNodeId(node.id);
                setEditText(node.text);
              }}
            >
              {!isRoot && !nodeIsDraft && node.children.length > 0 && (
                <g
                  onMouseDown={(e) => {
                    e.stopPropagation();
                    e.preventDefault();
                  }}
                  onClick={(e) => {
                    e.stopPropagation();
                    toggleCollapse(node.id);
                  }}
                  transform={`translate(${dir === "right" || dir === "vertical" ? nodeW + 8 : -COLLAPSE_BUTTON_SIZE - 8}, ${BASE_NODE_HEIGHT / 2 - COLLAPSE_BUTTON_SIZE / 2})`}
                  style={{ cursor: "pointer" }}
                >
                  <circle cx={COLLAPSE_BUTTON_SIZE / 2} cy={COLLAPSE_BUTTON_SIZE / 2} r={COLLAPSE_BUTTON_SIZE / 2} fill="var(--main-bg)" stroke={node.branchColor} strokeWidth={1.5} />
                  <text x={COLLAPSE_BUTTON_SIZE / 2} y={COLLAPSE_BUTTON_SIZE / 2 + 1} textAnchor="middle" dominantBaseline="central" fontSize={14} fill={node.branchColor} style={{ pointerEvents: "none" }}>
                    {node.collapsed ? "+" : "-"}
                  </text>
                </g>
              )}

              {isNodeSelected && !isEditing && !nodeIsDraft && (
                <g
                  onMouseDown={(e) => {
                    e.stopPropagation();
                    e.preventDefault();
                  }}
                  onClick={(e) => {
                    e.stopPropagation();
                    createDraftChild(node.id);
                  }}
                  transform={`translate(${dir === "right" || dir === "vertical" ? nodeW + 30 : -52}, ${BASE_NODE_HEIGHT / 2 - 11})`}
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
                        if (draftNode) {
                          cancelDraftNode();
                        } else {
                          setEditingNodeId(null);
                        }
                        return;
                      }
                      if (e.key === "Tab") {
                        e.preventDefault();
                        if (!editingNodeId) return;
                        commitNodeText(editingNodeId, editText);
                        setEditingNodeId(null);
                        if (editText.trim() && nodeIsDraft) return;
                        createDraftChild(editingNodeId);
                        return;
                      }
                      if (e.key === "Enter") {
                        e.preventDefault();
                        if (!editingNodeId) return;
                        commitNodeText(editingNodeId, editText);
                        setEditingNodeId(null);
                        if (nodeIsDraft && !editText.trim()) return;
                        if (editingNodeId === rootNode.id) createDraftChild(editingNodeId);
                        else createDraftSibling(editingNodeId);
                        return;
                      }
                      if ((e.key === "Backspace" || e.key === "Delete") && !editText.trim() && editingNodeId !== rootNode.id) {
                        e.preventDefault();
                        if (draftNode) {
                          cancelDraftNode();
                        } else {
                          persistRootNode(removeNode(rootNode, editingNodeId));
                          setEditingNodeId(null);
                        }
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
        {selectedNode && isElementSelected && !editingNodeId && !isNodeDraft(selectedNode.id) && (
          <g
            style={{ pointerEvents: "auto" }}
            onMouseDown={(e) => {
              e.stopPropagation();
              e.preventDefault();
            }}
            onClick={(e) => {
              e.stopPropagation();
            }}
          >
            <MindMapToolbar
              x={selectedNode.x - 12}
              y={selectedNode.y - 56}
              branchColors={branchColors}
              activeColor={selectedNode.branchColor}
              branchStrokeWidth={branchStrokeWidth}
              branchStyle={branchStyle}
              layoutDirection={layoutDirection}
              canDelete={selectedNode.id !== rootNode.id}
              canCollapse={Boolean(selectedTreeNode && selectedTreeNode.children.length > 0)}
              collapsed={Boolean(selectedTreeNode?.collapsed)}
              hiddenDescendantCount={selectedTreeNode?.collapsed ? countDescendants(selectedTreeNode) : 0}
              onColorChange={(color) => persistConfigPatch({ branchColors: [color, ...branchColors.filter((c) => c !== color)] })}
              onStrokeWidthChange={(width) => persistConfigPatch({ branchStrokeWidth: width })}
              onBranchStyleChange={(style) => persistConfigPatch({ branchStyle: style })}
              onLayoutDirectionChange={(dir) => persistConfigPatch({ layoutDirection: dir })}
              onAddChild={() => createDraftChild(selectedNode.id)}
              onAddSibling={() => createDraftSibling(selectedNode.id)}
              onToggleCollapse={() => toggleCollapse(selectedNode.id)}
              onDelete={() => deleteNode(selectedNode.id)}
            />
          </g>
        )}
      </g>
    </svg>
  );
};