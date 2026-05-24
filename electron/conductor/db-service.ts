/**
 * db-service.ts - Conductor Executor Database Service
 *
 * Wraps queries/conductors.ts for executor-specific operations.
 * All functions return { result, diff } for state:patch broadcasting.
 */

import { randomUUID } from 'crypto';
import {
  getCanvasSnapshot,
  insertElement,
  updateElementPosition,
  updateElementConfig,
  updateElementVizSpec,
  deleteElement,
  writeActionLog,
  getElement,
  findElementsByType,
  findAttachedConnectors,
} from '../db/queries/conductors';
import type {
  ExecutorRpcResponse,
  ElementActionResult,
  CanvasSnapshotResult,
} from './executor-types';

const ACTOR = 'agent';
const CANVAS_WIDTH = 1200;
const CANVAS_HEIGHT = 800;

export class ConductorDbService {
  getCanvasSnapshot(canvasId: string): ExecutorRpcResponse {
    const snapshot = getCanvasSnapshot(canvasId);
    if (!snapshot) {
      return {
        success: false,
        error: { code: 'NOT_FOUND', message: `Canvas ${canvasId} not found` },
      };
    }

    const result: CanvasSnapshotResult = {
      canvas: {
        id: snapshot.canvas.id,
        name: snapshot.canvas.name,
        width: CANVAS_WIDTH,
        height: CANVAS_HEIGHT,
        description: snapshot.canvas.description,
      },
      elements: snapshot.elements.map((el) => ({
        id: el.id,
        canvasId: el.canvasId,
        elementKind: el.elementKind,
        position: el.position,
        config: el.config,
        vizSpec: el.vizSpec,
        state: el.state,
        dataVersion: el.dataVersion,
        createdAt: el.createdAt,
        updatedAt: el.updatedAt,
      })),
      actionCursor: snapshot.actionCursor,
    };

    return { success: true, result };
  }

  createElement(payload: Record<string, unknown>): ExecutorRpcResponse {
    const canvasId = payload.canvasId as string;
    const elementKind = payload.kind as string;
    const position = payload.position as Record<string, unknown>;
    const vizSpec = (payload.vizSpec as Record<string, unknown>) || null;
    const config = (payload.config as Record<string, unknown>) || {};

    const elementId = randomUUID();
    const now = Date.now();
    const permissions = { agentCanRead: true, agentCanWrite: true, agentCanDelete: true };
    const metadata = { label: elementKind, tags: [] as string[], createdBy: ACTOR };

    insertElement(elementId, canvasId, elementKind, position, config, vizSpec, permissions, metadata, now);

    writeActionLog({
      canvasId,
      widgetId: null,
      actor: ACTOR,
      actionType: 'element.create',
      payload: { elementKind, position, config, vizSpec },
      resultPatch: { elementId },
    });

    const element = {
      id: elementId,
      canvasId,
      elementKind,
      position,
      config,
      vizSpec,
      state: 'idle',
      dataVersion: 1,
      permissions,
      metadata,
      createdAt: now,
      updatedAt: now,
    };

    const result: ElementActionResult = {
      diff: {
        type: 'element.create',
        targetId: elementId,
        canvasId,
        element,
        actionId: 0,
        timestamp: now,
      },
    };

    return { success: true, result };
  }

  updateElement(payload: Record<string, unknown>): ExecutorRpcResponse {
    const canvasId = payload.canvasId as string;
    const elementId = payload.elementId as string;
    const vizSpec = payload.vizSpec !== undefined ? (payload.vizSpec as Record<string, unknown> | null) : undefined;
    const position = payload.position as Record<string, unknown> | undefined;
    const config = payload.config as Record<string, unknown> | undefined;

    const prev = getElement(elementId, canvasId);
    if (!prev) {
      return {
        success: false,
        error: { code: 'NOT_FOUND', message: `Element ${elementId} not found` },
      };
    }

    const now = Date.now();
    const changes: Record<string, unknown> = {};

    if (config !== undefined) {
      updateElementConfig(elementId, config, now);
      changes.config = config;
      changes.prevConfig = prev.config;
    }
    if (vizSpec !== undefined) {
      updateElementVizSpec(elementId, vizSpec, now);
      changes.vizSpec = vizSpec;
      changes.prevVizSpec = prev.vizSpec;
    }
    if (position !== undefined) {
      updateElementPosition(elementId, position, now);
      changes.position = position;
      changes.prevPosition = prev.position;
    }

    writeActionLog({
      canvasId,
      widgetId: null,
      actor: ACTOR,
      actionType: 'element.update',
      payload: { elementId, vizSpec, position, config },
      resultPatch: changes,
    });

    const result: ElementActionResult = {
      diff: {
        type: 'element.update',
        targetId: elementId,
        canvasId,
        changes,
        actionId: 0,
        timestamp: now,
      },
    };

    return { success: true, result };
  }

  deleteElement(payload: Record<string, unknown>): ExecutorRpcResponse {
    const canvasId = payload.canvasId as string;
    const elementId = payload.elementId as string;

    const element = getElement(elementId, canvasId);
    if (!element) {
      return {
        success: false,
        error: { code: 'NOT_FOUND', message: `Element ${elementId} not found` },
      };
    }

    deleteElement(elementId);

    writeActionLog({
      canvasId,
      widgetId: null,
      actor: ACTOR,
      actionType: 'element.delete',
      payload: { id: elementId },
      resultPatch: null,
    });

    const now = Date.now();
    const result: ElementActionResult = {
      diff: {
        type: 'element.delete',
        targetId: elementId,
        canvasId,
        actionId: 0,
        timestamp: now,
      },
    };

    return { success: true, result };
  }

  arrangeElements(payload: Record<string, unknown>): ExecutorRpcResponse {
    const canvasId = payload.canvasId as string;
    const layout = payload.layout as Array<{ elementId: string; position: Record<string, unknown> }>;
    const now = Date.now();

    for (const item of layout) {
      updateElementPosition(item.elementId, item.position, now);
    }

    writeActionLog({
      canvasId,
      widgetId: null,
      actor: ACTOR,
      actionType: 'element.arrange',
      payload: { layout },
      resultPatch: { layout },
    });

    const result: ElementActionResult = {
      diff: {
        type: 'element.arrange',
        canvasId,
        layout,
        actionId: 0,
        timestamp: now,
      },
    };

    return { success: true, result };
  }

  alignElement(payload: Record<string, unknown>): ExecutorRpcResponse {
    const canvasId = payload.canvasId as string;
    const elementId = payload.elementId as string;
    const alignment = payload.alignment as string;
    const margin = (payload.margin as number) || 20;

    const element = getElement(elementId, canvasId);
    if (!element) {
      return {
        success: false,
        error: { code: 'NOT_FOUND', message: `Element ${elementId} not found` },
      };
    }

    const elPos = element.position as Record<string, number>;
    const elW = elPos.w || 200;
    const elH = elPos.h || 150;
    const newPos: Record<string, number> = { ...elPos };

    switch (alignment) {
      case 'top-left': newPos.x = margin; newPos.y = margin; break;
      case 'top-right': newPos.x = CANVAS_WIDTH - elW - margin; newPos.y = margin; break;
      case 'bottom-left': newPos.x = margin; newPos.y = CANVAS_HEIGHT - elH - margin; break;
      case 'bottom-right': newPos.x = CANVAS_WIDTH - elW - margin; newPos.y = CANVAS_HEIGHT - elH - margin; break;
      case 'center': newPos.x = (CANVAS_WIDTH - elW) / 2; newPos.y = (CANVAS_HEIGHT - elH) / 2; break;
      default:
        return { success: false, error: { code: 'INVALID_INPUT', message: `Unknown alignment: ${alignment}` } };
    }

    const now = Date.now();
    updateElementPosition(elementId, newPos, now);

    writeActionLog({
      canvasId,
      widgetId: null,
      actor: ACTOR,
      actionType: 'element.move',
      payload: { elementId, alignment, margin },
      resultPatch: { position: newPos, prevPosition: elPos },
    });

    const result: ElementActionResult = {
      diff: {
        type: 'element.move',
        targetId: elementId,
        canvasId,
        changes: { position: newPos, prevPosition: elPos },
        actionId: 0,
        timestamp: now,
      },
    };

    return { success: true, result };
  }

  layoutGridElements(payload: Record<string, unknown>): ExecutorRpcResponse {
    const canvasId = payload.canvasId as string;
    const elementIds = payload.elementIds as string[];
    const columns = (payload.columns as number) || 3;
    const gap = (payload.gap as number) || 20;
    const cellWidth = (payload.cellWidth as number) || 250;
    const cellHeight = (payload.cellHeight as number) || 150;

    if (!elementIds || elementIds.length === 0) {
      return { success: false, error: { code: 'INVALID_INPUT', message: 'elementIds is required' } };
    }

    const layout: Array<{ elementId: string; position: Record<string, number> }> = [];
    const now = Date.now();

    for (let i = 0; i < elementIds.length; i++) {
      const col = i % columns;
      const row = Math.floor(i / columns);
      const x = col * (cellWidth + gap) + gap;
      const y = row * (cellHeight + gap) + gap;
      const elId = elementIds[i];
      const position = { x, y, w: cellWidth, h: cellHeight };
      updateElementPosition(elId, position, now);
      layout.push({ elementId: elId, position });
    }

    writeActionLog({
      canvasId,
      widgetId: null,
      actor: ACTOR,
      actionType: 'element.arrange',
      payload: { elementIds, columns, gap },
      resultPatch: { layout },
    });

    const result: ElementActionResult = {
      diff: {
        type: 'element.arrange',
        canvasId,
        layout,
        actionId: 0,
        timestamp: now,
      },
    };

    return { success: true, result };
  }

  createNativeElement(payload: Record<string, unknown>): ExecutorRpcResponse {
    const canvasId = payload.canvasId as string;
    const nodeType = payload.nodeType as string;
    const position = payload.position as Record<string, unknown>;
    const content = (payload.content as Record<string, unknown>) || {};
    const style = (payload.style as Record<string, unknown>) || {};
    const parentId = payload.parentId as string | null | undefined;

    const elementId = randomUUID();
    const now = Date.now();
    const nativeKind = nodeType;
    const elementKind = `native/${nodeType}`;
    const config = { ...content, style };
    const metadata = {
      label: content.label || nodeType,
      tags: [],
      createdBy: ACTOR,
      parentId: parentId || null,
      childIds: [],
    };
    const permissions = { agentCanRead: true, agentCanWrite: true, agentCanDelete: true };

    insertElement(elementId, canvasId, elementKind, position, config, null, permissions, metadata, now, nativeKind);

    writeActionLog({
      canvasId,
      widgetId: null,
      actor: ACTOR,
      actionType: 'element.create_native',
      payload: { nodeType, position, content, style, parentId },
      resultPatch: { elementId, elementKind, config, metadata },
    });

    return {
      success: true,
      result: {
        diff: {
          type: 'element.create_native',
          targetId: elementId,
          canvasId,
          element: {
            id: elementId,
            canvasId,
            elementKind,
            position,
            config,
            state: 'idle',
            dataVersion: 1,
            permissions,
            metadata,
            createdAt: now,
            updatedAt: now,
          },
          actionId: 0,
          timestamp: now,
        },
      },
    };
  }

  createConnector(payload: Record<string, unknown>): ExecutorRpcResponse {
    const canvasId = payload.canvasId as string;
    const source = payload.source as Record<string, unknown>;
    const target = payload.target as Record<string, unknown>;
    const curvature = (payload.curvature as number) || 0.4;
    const style = (payload.style as Record<string, unknown>) || {};

    const elementId = randomUUID();
    const now = Date.now();
    const nativeKind = 'connector';
    const elementKind = 'native/connector';
    const position = { x: 0, y: 0, w: 0, h: 0, zIndex: 0, rotation: 0 };
    const config = { source, target, curvature, routingMode: 'bezier', style };
    const metadata = {
      label: 'Connector',
      tags: [],
      createdBy: ACTOR,
      parentId: null,
      childIds: [],
    };
    const permissions = { agentCanRead: true, agentCanWrite: true, agentCanDelete: true };

    insertElement(elementId, canvasId, elementKind, position, config, null, permissions, metadata, now, nativeKind);

    writeActionLog({
      canvasId,
      widgetId: null,
      actor: ACTOR,
      actionType: 'connector.create',
      payload: { source, target, curvature, style },
      resultPatch: { elementId, elementKind, config, metadata },
    });

    return {
      success: true,
      result: {
        diff: {
          type: 'connector.create',
          targetId: elementId,
          canvasId,
          element: {
            id: elementId,
            canvasId,
            elementKind,
            position,
            config,
            state: 'idle',
            dataVersion: 1,
            permissions,
            metadata,
            createdAt: now,
            updatedAt: now,
          },
          actionId: 0,
          timestamp: now,
        },
      },
    };
  }

  createMindMap(payload: Record<string, unknown>): ExecutorRpcResponse {
    const canvasId = payload.canvasId as string;
    const position = (payload.position as Record<string, unknown>) || {
      x: 0, y: 0, w: 16, h: 12, zIndex: 0, rotation: 0,
    };
    const rootNode = payload.rootNode || {
      id: 'root',
      text: 'Mind Map',
      children: [],
    };
    const layoutDirection = (payload.layoutDirection as string) || 'right';
    const branchColors = (payload.branchColors as string[]) || undefined;

    const elementId = randomUUID();
    const now = Date.now();
    const nativeKind = 'mindmap';
    const elementKind = 'native/mindmap';
    const config: Record<string, unknown> = {
      kind: 'mindmap',
      rootNode,
      layoutDirection,
    };
    if (branchColors) {
      config.branchColors = branchColors;
    }
    const metadata = {
      label: 'Mind Map',
      tags: [],
      createdBy: ACTOR,
      parentId: null,
      childIds: [],
    };
    const permissions = { agentCanRead: true, agentCanWrite: true, agentCanDelete: true };

    insertElement(elementId, canvasId, elementKind, position, config, null, permissions, metadata, now, nativeKind);

    writeActionLog({
      canvasId,
      widgetId: null,
      actor: ACTOR,
      actionType: 'element.create_native',
      payload: { nodeType: 'mindmap', position, content: config },
      resultPatch: { elementId, elementKind, config, metadata },
    });

    return {
      success: true,
      result: {
        diff: {
          type: 'element.create_native',
          targetId: elementId,
          canvasId,
          element: {
            id: elementId,
            canvasId,
            elementKind,
            position,
            config,
            state: 'idle',
            dataVersion: 1,
            permissions,
            metadata,
            createdAt: now,
            updatedAt: now,
          },
          actionId: 0,
          timestamp: now,
        },
      },
    };
  }

  mindmapAddNode(mindmapId: string, parentId: string, newNode: Record<string, unknown>): ExecutorRpcResponse {
    const element = getElement(mindmapId, '');
    if (!element) {
      return {
        success: false,
        error: { code: 'NOT_FOUND', message: `MindMap ${mindmapId} not found` },
      };
    }

    const config = element.config as Record<string, unknown>;
    const rootNode = config.rootNode as Record<string, unknown>;

    const updatedRoot = addMindMapNode(rootNode, parentId, {
      id: newNode.id as string || randomUUID(),
      text: newNode.text as string || 'New node',
      children: (newNode.children as Array<Record<string, unknown>>) || [],
      collapsed: newNode.collapsed as boolean || false,
    });

    const newConfig = { ...config, rootNode: updatedRoot };
    const now = Date.now();

    updateElementConfig(mindmapId, newConfig, now);

    const canvasId = element.canvasId as string;
    writeActionLog({
      canvasId,
      widgetId: null,
      actor: ACTOR,
      actionType: 'mindmap.add_node',
      payload: { mindmapId, parentId, newNode },
      resultPatch: { config: newConfig },
    });

    return {
      success: true,
      result: {
        diff: {
          type: 'element.update',
          targetId: mindmapId,
          canvasId,
          changes: { config: newConfig, prevConfig: config },
          actionId: 0,
          timestamp: now,
        },
      },
    };
  }

  mindmapRemoveNode(mindmapId: string, nodeId: string): ExecutorRpcResponse {
    const element = getElement(mindmapId, '');
    if (!element) {
      return {
        success: false,
        error: { code: 'NOT_FOUND', message: `MindMap ${mindmapId} not found` },
      };
    }

    const config = element.config as Record<string, unknown>;
    const rootNode = config.rootNode as Record<string, unknown>;

    const updatedRoot = removeMindMapNode(rootNode, nodeId);
    if (!updatedRoot) {
      return {
        success: false,
        error: { code: 'INVALID_INPUT', message: 'Cannot remove root node' },
      };
    }

    const newConfig = { ...config, rootNode: updatedRoot };
    const now = Date.now();

    updateElementConfig(mindmapId, newConfig, now);

    const canvasId = element.canvasId as string;
    writeActionLog({
      canvasId,
      widgetId: null,
      actor: ACTOR,
      actionType: 'mindmap.remove_node',
      payload: { mindmapId, nodeId },
      resultPatch: { config: newConfig },
    });

    return {
      success: true,
      result: {
        diff: {
          type: 'element.update',
          targetId: mindmapId,
          canvasId,
          changes: { config: newConfig, prevConfig: config },
          actionId: 0,
          timestamp: now,
        },
      },
    };
  }

  mindmapToggleCollapse(mindmapId: string, nodeId: string): ExecutorRpcResponse {
    const element = getElement(mindmapId, '');
    if (!element) {
      return {
        success: false,
        error: { code: 'NOT_FOUND', message: `MindMap ${mindmapId} not found` },
      };
    }

    const config = element.config as Record<string, unknown>;
    const rootNode = config.rootNode as Record<string, unknown>;

    function toggleInTree(node: Record<string, unknown>): Record<string, unknown> {
      if (node.id === nodeId) {
        return { ...node, collapsed: !node.collapsed };
      }
      const children = (node.children as Array<Record<string, unknown>>) || [];
      return {
        ...node,
        children: children.map(toggleInTree),
      };
    }

    const updatedRoot = toggleInTree(rootNode);
    const newConfig = { ...config, rootNode: updatedRoot };
    const now = Date.now();

    updateElementConfig(mindmapId, newConfig, now);

    const canvasId = element.canvasId as string;
    writeActionLog({
      canvasId,
      widgetId: null,
      actor: ACTOR,
      actionType: 'mindmap.toggle_collapse',
      payload: { mindmapId, nodeId },
      resultPatch: { config: newConfig },
    });

    return {
      success: true,
      result: {
        diff: {
          type: 'element.update',
          targetId: mindmapId,
          canvasId,
          changes: { config: newConfig, prevConfig: config },
          actionId: 0,
          timestamp: now,
        },
      },
    };
  }
}

function addMindMapNode(
  root: Record<string, unknown>,
  parentId: string,
  newNode: Record<string, unknown>
): Record<string, unknown> {
  if (root.id === parentId) {
    const children = (root.children as Array<Record<string, unknown>>) || [];
    return { ...root, collapsed: false, children: [...children, newNode] };
  }
  const children = (root.children as Array<Record<string, unknown>>) || [];
  return {
    ...root,
    children: children.map((child) => addMindMapNode(child, parentId, newNode)),
  };
}

function removeMindMapNode(
  root: Record<string, unknown>,
  nodeId: string
): Record<string, unknown> | null {
  if (root.id === nodeId) return null;
  const children = (root.children as Array<Record<string, unknown>>) || [];
  return {
    ...root,
    children: children
      .map((child) => removeMindMapNode(child, nodeId))
      .filter((child): child is Record<string, unknown> => child !== null),
  };
}