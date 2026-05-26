import type { MindMapTreeNode } from "@/types/canvas-node";

const DEFAULT_LEVEL_GAP = 140;
const DEFAULT_SIBLING_GAP = 12;
const DEFAULT_NODE_WIDTH = 120;
const DEFAULT_NODE_HEIGHT = 36;

const DEFAULT_BRANCH_COLORS = [
  "#4F46E5",
  "#0891B2",
  "#059669",
  "#D97706",
  "#DC2626",
  "#7C3AED",
];

export type LayoutDirection = "right" | "left" | "both" | "tree" | "vertical";

export interface MindMapLayoutOptions {
  levelGap?: number;
  siblingGap?: number;
  nodeWidth?: number;
  nodeHeight?: number;
  direction?: LayoutDirection;
  branchColors?: string[];
  branchStrokeWidth?: number;
  branchStyle?: "curve" | "elbow";
}

export interface LayoutNode {
  id: string;
  text: string;
  x: number;
  y: number;
  width: number;
  height: number;
  depth: number;
  collapsed: boolean;
  children: LayoutNode[];
  parentX: number;
  parentY: number;
  branchColor: string;
}

export interface MindMapLayoutResult {
  nodes: LayoutNode[];
  edges: Array<{ from: LayoutNode; to: LayoutNode; color: string; strokeWidth: number }>;
  totalWidth: number;
  totalHeight: number;
}

export function countMindMapDescendants(node: MindMapTreeNode): number {
  return node.children.reduce((sum, child) => sum + 1 + countMindMapDescendants(child), 0);
}

interface Precomputed {
  subtreeHeight: number;
}

function computeSubtreeHeight(
  node: MindMapTreeNode,
  precomputed: Map<string, Precomputed>,
  siblingGap: number,
  nodeHeight: number
): number {
  if (node.children.length === 0 || node.collapsed) {
    const h = nodeHeight + siblingGap;
    precomputed.set(node.id, { subtreeHeight: h });
    return h;
  }

  let total = 0;
  for (const child of node.children) {
    total += computeSubtreeHeight(child, precomputed, siblingGap, nodeHeight);
  }
  precomputed.set(node.id, { subtreeHeight: total });
  return total;
}

function computeSubtreeWidth(
  node: MindMapTreeNode,
  precomputed: Map<string, Precomputed>,
  siblingGap: number,
  nodeWidth: number
): number {
  if (node.children.length === 0 || node.collapsed) {
    const w = nodeWidth + siblingGap;
    precomputed.set(node.id, { subtreeHeight: w });
    return w;
  }

  let total = 0;
  for (const child of node.children) {
    total += computeSubtreeWidth(child, precomputed, siblingGap, nodeWidth);
  }
  total = Math.max(total, nodeWidth + siblingGap);
  precomputed.set(node.id, { subtreeHeight: total });
  return total;
}

function buildLayoutNodes(
  node: MindMapTreeNode,
  depth: number,
  xOffset: number,
  yStart: number,
  precomputed: Map<string, Precomputed>,
  options: Required<MindMapLayoutOptions>,
  result: LayoutNode[],
  allNodes: MindMapTreeNode[],
  colorIndex: number
): LayoutNode {
  const { nodeWidth, nodeHeight, siblingGap, levelGap, branchColors, direction } = options;

  const pc = precomputed.get(node.id);
  const subtreeH = pc ? pc.subtreeHeight : nodeHeight + siblingGap;

  const centerY = Math.max(0, yStart + (subtreeH - nodeHeight) / 2);

  const layoutNode: LayoutNode = {
    id: node.id,
    text: node.text,
    x: xOffset,
    y: centerY,
    width: nodeWidth,
    height: nodeHeight,
    depth,
    collapsed: !!node.collapsed,
    children: [],
    parentX: xOffset,
    parentY: centerY + nodeHeight / 2,
    branchColor: branchColors[colorIndex % branchColors.length],
  };

  result.push(layoutNode);

  if (node.collapsed || node.children.length === 0) {
    return layoutNode;
  }

  const childXOffset = direction === "left"
    ? xOffset - nodeWidth - levelGap
    : xOffset + nodeWidth + levelGap;

  let childY = yStart;
  let childIdx = 0;

  for (const child of node.children) {
    const childLayout = buildLayoutNodes(
      child,
      depth + 1,
      childXOffset,
      childY,
      precomputed,
      options,
      result,
      allNodes,
      colorIndex + 1
    );
    layoutNode.children.push(childLayout);

    const childPc = precomputed.get(child.id);
    childY += childPc ? childPc.subtreeHeight : nodeHeight + siblingGap;
    childIdx++;
  }

  return layoutNode;
}

export function layoutMindMap(
  rootNode: MindMapTreeNode,
  options: MindMapLayoutOptions = {}
): MindMapLayoutResult {
  const {
    levelGap = DEFAULT_LEVEL_GAP,
    siblingGap = DEFAULT_SIBLING_GAP,
    nodeWidth = DEFAULT_NODE_WIDTH,
    nodeHeight = DEFAULT_NODE_HEIGHT,
    direction = "right",
    branchColors = DEFAULT_BRANCH_COLORS,
    branchStrokeWidth = 3,
    branchStyle = "curve",
  } = options;
  void branchStyle;

  const fullOptions: Required<MindMapLayoutOptions> = {
    levelGap,
    siblingGap,
    nodeWidth,
    nodeHeight,
    direction,
    branchColors,
    branchStrokeWidth,
    branchStyle,
  };

  const precomputed = new Map<string, Precomputed>();
  computeSubtreeHeight(rootNode, precomputed, siblingGap, nodeHeight);

  const result: LayoutNode[] = [];
  const totalH = precomputed.get(rootNode.id)?.subtreeHeight ?? nodeHeight + siblingGap;
  const rootY = Math.max(0, (totalH - nodeHeight) / 2);
  const rootX = 0;
  const rootCenterY = rootY + nodeHeight / 2;

  const rootLayout: LayoutNode = {
    id: rootNode.id,
    text: rootNode.text,
    x: rootX,
    y: rootY,
    width: nodeWidth,
    height: nodeHeight,
    depth: 0,
    collapsed: !!rootNode.collapsed,
    children: [],
    parentX: rootX,
    parentY: rootCenterY,
    branchColor: branchColors[0],
  };
  result.push(rootLayout);

  function buildChildrenOnSide(
    children: MindMapTreeNode[],
    dir: "right" | "left",
    colorBias: number
  ): void {
    if (children.length === 0) {
      return;
    }

    const myOptions: Required<MindMapLayoutOptions> = {
      ...fullOptions,
      direction: dir,
    };

    const sideHeight = children.reduce((sum, child) => {
      return sum + (precomputed.get(child.id)?.subtreeHeight ?? nodeHeight + siblingGap);
    }, 0);
    let childY = rootCenterY - sideHeight / 2;

    const childXOffset = dir === "left"
      ? rootX - nodeWidth - levelGap
      : rootX + nodeWidth + levelGap;

    for (let i = 0; i < children.length; i++) {
      const child = children[i];
      const childLayout = buildLayoutNodes(
        child,
        1,
        childXOffset,
        childY,
        precomputed,
        myOptions,
        result,
        [],
        colorBias + i
      );
      rootLayout.children.push(childLayout);
      childY += precomputed.get(child.id)?.subtreeHeight ?? nodeHeight + siblingGap;
    }
  }

  function buildChildrenVertical(): void {
    if (rootNode.children.length === 0) return;

    const verticalOptions: Required<MindMapLayoutOptions> = {
      ...fullOptions,
      direction: "right" as LayoutDirection,
    };

    const precomputedW = new Map<string, Precomputed>();
    computeSubtreeWidth(rootNode, precomputedW, siblingGap, nodeWidth);

    const totalW = precomputedW.get(rootNode.id)?.subtreeHeight ?? nodeWidth + siblingGap;
    let childX = rootX + nodeWidth / 2 - totalW / 2;

    const childY = rootY + nodeHeight + levelGap;

    for (let i = 0; i < rootNode.children.length; i++) {
      const child = rootNode.children[i];
      const childW = precomputedW.get(child.id)?.subtreeHeight ?? nodeWidth + siblingGap;

      const childLayout = buildLayoutNodesVertical(
        child,
        1,
        childX + childW / 2 - nodeWidth / 2,
        childY,
        precomputedW,
        verticalOptions,
        result,
        i
      );
      rootLayout.children.push(childLayout);
      childX += childW;
    }
  }

  function buildLayoutNodesVertical(
    node: MindMapTreeNode,
    depth: number,
    xStart: number,
    yStart: number,
    widthPrecomputed: Map<string, Precomputed>,
    options: Required<MindMapLayoutOptions>,
    resultNodes: LayoutNode[],
    colorIndex: number
  ): LayoutNode {
    const vertLayoutNode: LayoutNode = {
      id: node.id,
      text: node.text,
      x: xStart,
      y: yStart,
      width: nodeWidth,
      height: nodeHeight,
      depth,
      collapsed: !!node.collapsed,
      children: [],
      parentX: xStart,
      parentY: yStart,
      branchColor: branchColors[colorIndex % branchColors.length],
    };
    resultNodes.push(vertLayoutNode);

    if (node.collapsed || node.children.length === 0) return vertLayoutNode;

    const subtreeW = widthPrecomputed.get(node.id)?.subtreeHeight ?? nodeWidth + siblingGap;
    let childX = xStart + nodeWidth / 2 - subtreeW / 2;
    const childY = yStart + nodeHeight + levelGap;

    for (let i = 0; i < node.children.length; i++) {
      const child = node.children[i];
      const childW = widthPrecomputed.get(child.id)?.subtreeHeight ?? nodeWidth + siblingGap;
      const childLayout = buildLayoutNodesVertical(
        child,
        depth + 1,
        childX + childW / 2 - nodeWidth / 2,
        childY,
        widthPrecomputed,
        options,
        resultNodes,
        colorIndex + 1 + i
      );
      vertLayoutNode.children.push(childLayout);
      childX += childW;
    }

    return vertLayoutNode;
  }

  if (!rootNode.collapsed && rootNode.children.length > 0) {
    if (direction === "vertical") {
      buildChildrenVertical();
    } else if (direction === "both") {
      const mid = Math.ceil(rootNode.children.length / 2);
      const leftChildren = rootNode.children.slice(0, mid);
      const rightChildren = rootNode.children.slice(mid);
      buildChildrenOnSide(leftChildren, "left", 0);
      buildChildrenOnSide(rightChildren, "right", leftChildren.length);
    } else if (direction === "tree") {
      const mid = Math.ceil(rootNode.children.length / 2);
      const leftChildren = rootNode.children.slice(0, mid);
      const rightChildren = rootNode.children.slice(mid);
      buildChildrenOnSide(leftChildren, "left", 0);
      buildChildrenOnSide(rightChildren, "right", leftChildren.length);
    } else {
      buildChildrenOnSide(rootNode.children, direction, 0);
    }
  }

  const allX = result.map((n) => n.x);
  const allY = result.map((n) => n.y);
  const minX = Math.min(...allX);
  const maxX = Math.max(...allX);
  const minY = Math.min(...allY);
  const maxY = Math.max(...allY);

  const edges: Array<{ from: LayoutNode; to: LayoutNode; color: string; strokeWidth: number }> = [];

  function collectEdges(node: LayoutNode) {
    for (const child of node.children) {
      if (child.text || child.children.length > 0) {
        edges.push({
          from: node,
          to: child,
          color: child.branchColor,
          strokeWidth: Math.max(2, branchStrokeWidth - Math.min(1.2, child.depth * 0.35)),
        });
      }
      collectEdges(child);
    }
  }

  collectEdges(rootLayout);

  return {
    nodes: result,
    edges,
    totalWidth: maxX - minX + nodeWidth,
    totalHeight: maxY - minY + nodeHeight,
  };
}

export function computeBezierBranchPath(
  fromX: number,
  fromY: number,
  toX: number,
  toY: number,
  direction: "right" | "left" | "vertical"
): string {
  if (direction === "vertical") {
    const cp1y = fromY + Math.abs(toY - fromY) * 0.4;
    const cp2y = toY - Math.abs(toY - fromY) * 0.4;
    return `M ${fromX} ${fromY} C ${fromX} ${cp1y}, ${toX} ${cp2y}, ${toX} ${toY}`;
  }
  const sign = direction === "right" ? 1 : -1;
  const cp1x = fromX + Math.abs(toX - fromX) * 0.4 * sign;
  const cp1y = fromY;
  const cp2x = toX - Math.abs(toX - fromX) * 0.4 * sign;
  const cp2y = toY;
  return `M ${fromX} ${fromY} C ${cp1x} ${cp1y}, ${cp2x} ${cp2y}, ${toX} ${toY}`;
}

export function computeElbowBranchPath(
  fromX: number,
  fromY: number,
  toX: number,
  toY: number,
  direction: "right" | "left" | "vertical"
): string {
  if (direction === "vertical") {
    const offset = Math.min(34, Math.abs(toY - fromY) * 0.42);
    const midY = fromY + offset;
    return `M ${fromX} ${fromY} L ${fromX} ${midY} L ${toX} ${midY} L ${toX} ${toY}`;
  }
  const offset = Math.min(34, Math.abs(toX - fromX) * 0.42);
  const midX = direction === "right" ? fromX + offset : fromX - offset;
  return `M ${fromX} ${fromY} L ${midX} ${fromY} L ${midX} ${toY} L ${toX} ${toY}`;
}
