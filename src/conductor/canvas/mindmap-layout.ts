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

export type LayoutDirection = "right" | "left" | "both" | "tree";

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

  function buildHalfTree(
    node: MindMapTreeNode,
    dir: "right" | "left",
    colorBias: number
  ): LayoutNode {
    const nodes: LayoutNode[] = [];
    const myOptions: Required<MindMapLayoutOptions> = {
      ...fullOptions,
      direction: dir,
    };

    const localPrecomputed = new Map<string, Precomputed>();
    computeSubtreeHeight(node, localPrecomputed, siblingGap, nodeHeight);

    const root = buildLayoutNodes(
      node,
      0,
      0,
      0,
      localPrecomputed,
      myOptions,
      nodes,
      [],
      colorBias
    );

    for (const n of nodes) {
      result.push(n);
    }

    return root;
  }

  if (direction === "both") {
    const rootChecked = rootNode.children && rootNode.children.length >= 2;

    if (rootChecked) {
      const mid = Math.ceil(rootNode.children.length / 2);
      const leftChildren = rootNode.children.slice(0, mid);
      const rightChildren = rootNode.children.slice(mid);

      const leftSubtree: MindMapTreeNode = {
        ...rootNode,
        children: leftChildren,
        text: "",
      };
      const rightSubtree: MindMapTreeNode = {
        ...rootNode,
        children: rightChildren,
        text: "",
      };

      buildHalfTree(leftSubtree, "left", 0);
      buildHalfTree(rightSubtree, "right", leftChildren.length);
    } else {
      buildHalfTree(rootNode, "right", 0);
    }
  } else if (direction === "tree") {
    buildHalfTree(rootNode, "right", 0);
    buildHalfTree(rootNode, "left", 0);
  } else {
    buildHalfTree(rootNode, direction, 0);
  }

  const justRoot: LayoutNode = {
    id: rootNode.id,
    text: rootNode.text,
    x: 0,
    y: Math.max(0, (totalH - nodeHeight) / 2),
    width: nodeWidth,
    height: nodeHeight,
    depth: 0,
    collapsed: !!rootNode.collapsed,
    children: [],
    parentX: 0,
    parentY: nodeHeight / 2,
    branchColor: branchColors[0],
  };

  const existingRoot = result.find((n) => n.id === rootNode.id);
  if (!existingRoot) {
    result.unshift(justRoot);
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

  const root = result.find((n) => n.id === rootNode.id && n.depth === 0);
  if (root) {
    collectEdges(root);
  }

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
  direction: "right" | "left"
): string {
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
  direction: "right" | "left"
): string {
  const offset = Math.min(34, Math.abs(toX - fromX) * 0.42);
  const midX = direction === "right" ? fromX + offset : fromX - offset;
  return `M ${fromX} ${fromY} L ${midX} ${fromY} L ${midX} ${toY} L ${toX} ${toY}`;
}
