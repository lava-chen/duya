/**
 * db-service.ts - Conductor Executor Database Service
 *
 * Wraps queries/conductors.ts for executor-specific operations.
 * All functions return { result, diff } for state:patch broadcasting.
 *
 * After each mutation, `broadcastPatch` is invoked to push the diff
 * to the renderer via the `conductor` MessagePort channel. This keeps
 * the canvas live-updating when the agent creates/moves/deletes
 * elements (without it, the renderer only sees agent edits on the
 * next full snapshot reload).
 */

import { randomUUID } from 'crypto';
import {
  getCanvasSnapshot,
  insertElement,
  updateElementPosition,
  updateElementConfig,
  updateElementVizSpec,
  updateElementSourceCode,
  deleteElement,
  writeActionLog,
  getElement,
  elementExists,
  findElementsByType,
  findAttachedConnectors,
} from '../db/queries/conductors';
import type { ConductorElement } from '../db/queries/conductors';
import { getDatabase } from '../db/connection';
import {
  clampPositionToCanvas,
  formatValidationErrors,
  validateElementInput,
  validateConnectorShape,
} from '../../packages/agent/src/tool/CanvasConductor/validate.js';
import type {
  ExecutorRpcResponse,
  ElementActionResult,
  CanvasSnapshotResult,
} from './executor-types';
import { binPack } from './layout/binPack';
import { flowLayout } from './layout/flowLayout';
import { viewportAwarePack } from './layout/viewport';
import type { LayoutElement, LayoutResult } from './layout/types';
import { prepareCanvasDocument, syncCanvasDocument } from './document-service';

const ACTOR = 'agent';
// Canvas bounds in *grid units* (1 unit = 80 px). The conductor canvas model
// persists `CanvasPosition.x/y/w/h` in grid units, so all layout math below
// (clamp, align, default origin) operates in grid units too.
const CANVAS_WIDTH_UNITS = 40;
const CANVAS_HEIGHT_UNITS = 30;

/** Truncate a string to `max` chars, appending an ellipsis when truncated. */
function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return text.slice(0, max) + '…';
}

/**
 * Provide sensible default width/height for an element when the agent
 * omits them. Keeps the canvas visually consistent and prevents downstream
 * geometry (connector anchors, hit testing) from seeing undefined sizes.
 */
function applyDefaultDimensions(
  elementKind: string,
  position: Record<string, unknown>,
): Record<string, unknown> {
  if (Number.isFinite(position.w as number) && Number.isFinite(position.h as number)) {
    return position;
  }
  const defaults: Record<string, { w: number; h: number }> = {
    'native/sticky': { w: 4, h: 3 },
    'native/shape': { w: 4, h: 2 },
    'native/document': { w: 6, h: 5 },
    'native/text': { w: 10, h: 2 },
    'native/table': { w: 5, h: 1.5 },
    'native/image': { w: 5, h: 4 },
    'native/file': { w: 4, h: 3 },
    'native/link': { w: 4, h: 1 },
    'native/connector': { w: 0, h: 0 },
    'native/group': { w: 0, h: 0 },
    'widget/dynamic': { w: 5, h: 4 },
  };
  const kindDefaults = defaults[elementKind] ?? { w: 4, h: 3 };
  return {
    ...position,
    w: Number.isFinite(position.w as number) ? position.w : kindDefaults.w,
    h: Number.isFinite(position.h as number) ? position.h : kindDefaults.h,
  };
}

/**
 * Build a minimal element summary for the agent tool result.
 * Keeps only the fields the agent actually needs to reason about
 * the canvas; drops internal metadata (permissions, dataVersion,
 * timestamps, state) to keep tool results short and readable.
 */
function summarizeElementForAgent(element: {
  id: string;
  canvasId: string;
  elementKind: string;
  position: Record<string, unknown>;
  config: Record<string, unknown>;
  sourceCode?: string | null;
}): Record<string, unknown> {
  return {
    id: element.id,
    kind: element.elementKind,
    elementKind: element.elementKind,
    position: element.position,
    config: element.config,
    ...(element.sourceCode ? { sourceCode: element.sourceCode } : {}),
  };
}

/**
 * Resolve a connector endpoint value to a display string.
 * Accepts either a raw elementId string or { nodeId: string }.
 */
function resolveConnectorEndpoint(value: unknown): string {
  if (typeof value === 'string') return value || '?';
  if (value && typeof value === 'object' && 'nodeId' in value) {
    return (value as { nodeId?: string }).nodeId || '?';
  }
  return '?';
}

/**
 * Broadcast a state:patch message to the renderer's `conductor`
 * channel. Mirrors the shape emitted by `db-handlers.ts:1524` so the
 * renderer's `onStatePatch` handler can apply it uniformly.
 */
export type BroadcastPatchFn = (patch: {
  canvasId: string;
  elementId?: string;
  actionId?: number;
  resultPatch: Record<string, unknown>;
  actor?: string;
}) => void;

export class ConductorDbService {
  private broadcastPatch: BroadcastPatchFn | null = null;

  /**
   * Inject the broadcast function. Called by main.ts after the
   * channelManager is initialized. Without this, agent edits still
   * write to the DB but the renderer won't live-update.
   */
  setBroadcastPatch(fn: BroadcastPatchFn): void {
    this.broadcastPatch = fn;
  }

  /**
   * Internal helper: broadcast a diff to the renderer if a broadcaster
   * is wired. `elementId` is lifted to the top level so the
   * `onStatePatch` handler can match it against `patch.elementId`.
   */
  private emit(canvasId: string, diff: Record<string, unknown>, elementId?: string): void {
    if (!this.broadcastPatch) return;
    this.broadcastPatch({
      canvasId,
      elementId: elementId ?? (diff.targetId as string | undefined),
      actionId: (diff.actionId as number) ?? 0,
      resultPatch: diff,
      actor: ACTOR,
    });
  }

  /**
   * Generate a fresh element ID and ensure it does not already exist.
   * Collisions are astronomically unlikely but this guards against
   * duplicate IDs when restoring / retrying operations.
   */
  private ensureUniqueElementId(): string {
    let id = randomUUID();
    while (elementExists(id)) {
      id = randomUUID();
    }
    return id;
  }

  /**
   * Normalize a connector endpoint value to { nodeId: string }.
   * Accepts either a raw elementId string or an already-normalized
   * { nodeId: string } object. Returns undefined for unresolvable input.
   */
  private normalizeConnectorEndpoint(value: unknown): { nodeId: string } | undefined {
    if (typeof value === 'string' && value) {
      return { nodeId: value };
    }
    if (value && typeof value === 'object' && 'nodeId' in value) {
      const nodeId = (value as { nodeId?: string }).nodeId;
      if (nodeId) return { nodeId };
    }
    return undefined;
  }

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
        // Bounding-box dimensions in grid units. (See CANVAS_WIDTH_UNITS
        // above for the rationale.)
        width: CANVAS_WIDTH_UNITS,
        height: CANVAS_HEIGHT_UNITS,
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

  /**
   * List every element on a canvas as a compact summary. Cheaper read
   * path than getCanvasSnapshot — omits vizSpec/state/dataVersion and
   * collapses config into a kind-specific one-line summary. Set
   * payload.includeConfig=true to attach the full config object per
   * element (useful when the model needs to inspect exact fields).
   */
  listElements(payload: Record<string, unknown>): ExecutorRpcResponse {
    const canvasId = payload.canvasId as string;
    const includeConfig = payload.includeConfig === true;

    const snapshot = getCanvasSnapshot(canvasId);
    if (!snapshot) {
      return {
        success: false,
        error: { code: 'NOT_FOUND', message: `Canvas ${canvasId} not found` },
      };
    }

    const elements = snapshot.elements;
    const overlaps = this.detectOverlaps(elements);
    const spatialOverview = this.buildSpatialOverview(elements);
    const markdown = this.buildElementsMarkdown(elements, includeConfig);

    return {
      success: true,
      result: {
        canvasId,
        markdown,
        count: elements.length,
        overlaps,
        spatialOverview,
      },
    };
  }

  /**
   * A location-first canvas read for agents. Unlike a plain element list, this
   * returns a compact spatial map and semantic edges so the model can make
   * intentional placement decisions before it edits the board.
   */
  describeCanvasContext(payload: Record<string, unknown>): ExecutorRpcResponse {
    const canvasId = payload.canvasId as string;
    const includeConfig = payload.includeConfig === true;
    const snapshot = getCanvasSnapshot(canvasId);
    if (!snapshot) {
      return {
        success: false,
        error: { code: 'NOT_FOUND', message: `Canvas ${canvasId} not found` },
      };
    }

    const elements = snapshot.elements;
    const canvas = snapshot.canvas;
    const spatialOverview = this.buildSpatialOverview(elements);
    const relationships = this.buildRelationshipsMarkdown(elements);
    const markdown = [
      `# Canvas context: ${canvas.name}`,
      canvas.description ? `Description: ${canvas.description}` : null,
      'Coordinate system: 40 × 30 grid units. Origin is top-left; x grows right, y grows down.',
      '',
      spatialOverview,
      '',
      relationships,
      '',
      this.buildElementsMarkdown(elements, includeConfig),
    ].filter(Boolean).join('\n');

    return {
      success: true,
      result: {
        canvasId,
        markdown,
        count: elements.length,
        overlaps: this.detectOverlaps(elements),
        spatialOverview,
        relationships,
      },
    };
  }

  findEmptySpace(payload: Record<string, unknown>): ExecutorRpcResponse {
    const canvasId = payload.canvasId as string;
    const preferredX = typeof payload.preferredX === 'number' ? payload.preferredX : 1;
    const preferredY = typeof payload.preferredY === 'number' ? payload.preferredY : 1;
    const w = typeof payload.w === 'number' ? payload.w : 3;
    const h = typeof payload.h === 'number' ? payload.h : 3;
    const direction = (payload.direction as 'right' | 'down' | 'auto') ?? 'auto';
    void direction;

    const snapshot = this.getCanvasSnapshot(canvasId);
    if (!snapshot.success) {
      return { success: false, error: { code: 'CANVAS_NOT_FOUND', message: `Canvas ${canvasId} not found` } };
    }
    const snapshotData = snapshot.result as CanvasSnapshotResult;

    // Build the incoming element with the requested size at the preferred
    // position; viewportAwarePack will place it avoiding existing elements.
    const incoming: LayoutElement = {
      id: '__find_empty_space__',
      position: { x: preferredX, y: preferredY, w, h, zIndex: 0, rotation: 0 },
      metadata: { locked: false, priority: 'high' },
    };

    const existing: LayoutElement[] = snapshotData.elements
      .filter(el => el.elementKind !== 'native/connector')
      .map(el => ({
        id: el.id,
        position: el.position as LayoutElement['position'],
        metadata: (el.metadata as LayoutElement['metadata']) ?? { locked: false, priority: 'mid' },
      }));

    const results = viewportAwarePack(existing, [incoming], {
      viewport: { width: CANVAS_WIDTH_UNITS, height: CANVAS_HEIGHT_UNITS },
      gap: 0.25,
      preserveLocked: true,
      maxFreeRects: 32,
      priorityWeight: { high: 0, mid: 1, low: 2 },
    });

    if (results.length === 0) {
      return {
        success: true,
        result: { x: preferredX, y: preferredY, w, h, overlapsExisting: true },
      };
    }

    const placed = results[0];
    return {
      success: true,
      result: {
        x: placed.position.x,
        y: placed.position.y,
        w,
        h,
        overlapsExisting: false,
      },
    };
  }

  /**
   * Produce a short kind-specific text describing an element's content.
   * Used by listElements to keep the per-element payload small. Truncates
   * long text fields so a single listElements response stays well under
   * the model's context budget even for canvases with many elements.
   */
  private summarizeElement(
    elementKind: string,
    config: Record<string, unknown>,
  ): string {
    const cfg = config || {};
    switch (elementKind) {
      case 'native/sticky': {
        const text = typeof cfg.text === 'string' ? cfg.text : '';
        return truncate(text, 40);
      }
      case 'native/image': {
        const name =
          (typeof cfg.fileName === 'string' && cfg.fileName) ||
          (typeof cfg.url === 'string' && cfg.url) ||
          '';
        return truncate(name, 60);
      }
      case 'native/file': {
        const name = typeof cfg.fileName === 'string' ? cfg.fileName : '';
        const page = typeof cfg.pdfPage === 'number' && Number.isFinite(cfg.pdfPage)
          ? `, PDF page ${Math.max(1, Math.round(cfg.pdfPage))}`
          : '';
        return truncate(`${name}${page}`, 60);
      }
      case 'native/shape': {
        const label =
          (typeof cfg.text === 'string' && cfg.text) ||
          (typeof cfg.label === 'string' && cfg.label) ||
          (typeof cfg.content === 'string' && cfg.content) ||
          'shape';
        return truncate(label, 60);
      }
      case 'native/text': {
        const text =
          (typeof cfg.text === 'string' && cfg.text) ||
          (typeof cfg.content === 'string' && cfg.content) ||
          '';
        return truncate(text, 60);
      }
      case 'native/document': {
        const title =
          (typeof cfg.title === 'string' && cfg.title) ||
          (typeof cfg.fileName === 'string' && cfg.fileName) ||
          (typeof cfg.content === 'string' && cfg.content) ||
          'document';
        return truncate(title, 60);
      }
      case 'native/table': {
        const title = typeof cfg.title === 'string' && cfg.title ? cfg.title : 'Table';
        const columns = Array.isArray(cfg.headers) ? cfg.headers.length : 3;
        const rows = Array.isArray(cfg.rows) ? cfg.rows.length : 3;
        return truncate(`${title} (${columns} columns × ${rows} rows)`, 60);
      }
      case 'native/connector': {
        const src = resolveConnectorEndpoint(cfg.source);
        const tgt = resolveConnectorEndpoint(cfg.target);
        return `${src} -> ${tgt}`;
      }
      case 'native/group': {
        const memberIds = Array.isArray(cfg.memberIds) ? cfg.memberIds : [];
        return `members: ${memberIds.length}`;
      }
      case 'native/link': {
        const linkType = cfg.linkType === 'session' || cfg.linkType === 'canvas' ? cfg.linkType : 'url';
        const target =
          (typeof cfg.url === 'string' && cfg.url) ||
          (typeof cfg.targetId === 'string' && cfg.targetId) ||
          '';
        const title = typeof cfg.title === 'string' ? cfg.title : '';
        return truncate(`${linkType}: ${title || target || 'untitled'}`, 60);
      }
      default: {
        if (elementKind.startsWith('widget/')) {
          const title =
            (typeof cfg.title === 'string' && cfg.title) ||
            (typeof cfg.label === 'string' && cfg.label) ||
            '';
          return title || elementKind;
        }
        return elementKind;
      }
    }
  }

  /**
   * Detect bounding box overlaps between non-connector elements.
   * position is in grid units: { x, y, w, h }.
   */
  private detectOverlaps(elements: ConductorElement[]): Array<{ a: string; b: string; reason: string }> {
    const rects = elements
      .filter((el) => el.elementKind !== 'native/connector' && el.position?.w && el.position?.h)
      .map((el) => {
        const pos = el.position as { x?: number; y?: number; w?: number; h?: number };
        return {
          id: el.id,
          x: pos.x ?? 0,
          y: pos.y ?? 0,
          w: pos.w ?? 0,
          h: pos.h ?? 0,
        };
      });

    const overlaps: Array<{ a: string; b: string; reason: string }> = [];
    for (let i = 0; i < rects.length; i++) {
      for (let j = i + 1; j < rects.length; j++) {
        const a = rects[i];
        const b = rects[j];
        // AABB overlap test
        if (a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y) {
          const overlapX = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
          const overlapY = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
          overlaps.push({
            a: a.id,
            b: b.id,
            reason: `bounding box intersection (${overlapX.toFixed(1)} x ${overlapY.toFixed(1)} grid units)`,
          });
        }
      }
    }
    return overlaps;
  }

  /**
   * Build spatial overview by quadrant (40x30 grid split into 4 quadrants).
   */
  private buildSpatialOverview(elements: ConductorElement[]): string {
    const quadrants = [
      { name: 'Top-left [0-20, 0-15]', minX: 0, minY: 0, maxX: 20, maxY: 15, items: [] as string[] },
      { name: 'Top-right [20-40, 0-15]', minX: 20, minY: 0, maxX: 40, maxY: 15, items: [] as string[] },
      { name: 'Bottom-left [0-20, 15-30]', minX: 0, minY: 15, maxX: 20, maxY: 30, items: [] as string[] },
      { name: 'Bottom-right [20-40, 15-30]', minX: 20, minY: 15, maxX: 40, maxY: 30, items: [] as string[] },
    ];

    for (const el of elements) {
      if (el.elementKind === 'native/connector') continue;
      const pos = el.position as { x?: number; y?: number; w?: number; h?: number };
      const cx = (pos.x ?? 0) + (pos.w ?? 0) / 2;
      const cy = (pos.y ?? 0) + (pos.h ?? 0) / 2;
      for (const q of quadrants) {
        if (cx >= q.minX && cx < q.maxX && cy >= q.minY && cy < q.maxY) {
          const shortKind = el.elementKind.replace('native/', '').replace('widget/', '');
          q.items.push(shortKind);
          break;
        }
      }
    }

    const lines = quadrants.map((q) => {
      if (q.items.length === 0) return `- ${q.name}: empty`;
      const counts: Record<string, number> = {};
      for (const item of q.items) counts[item] = (counts[item] ?? 0) + 1;
      const summary = Object.entries(counts).map(([k, v]) => `${v} ${k}`).join(', ');
      return `- ${q.name}: ${summary}`;
    });
    return `### Spatial Overview (40x30 grid)\n${lines.join('\n')}`;
  }

  /**
   * Map an element kind to a display category for the layered Markdown.
   */
  private categorizeElement(kind: string): string {
    if (kind === 'native/sticky') return 'Stickies';
    if (kind === 'native/shape') return 'Shapes';
    if (kind === 'native/text') return 'Text';
    if (kind === 'native/document') return 'Documents';
    if (kind === 'native/table') return 'Tables';
    if (kind === 'native/connector') return 'Connectors';
    if (kind === 'native/image') return 'Images';
    if (kind === 'native/file') return 'Files';
    if (kind === 'native/link') return 'Links';
    if (kind === 'native/group') return 'Groups';
    if (kind.startsWith('widget/')) return 'Widgets';
    return 'Other';
  }

  /**
   * Build layered Markdown of all elements grouped by kind.
   */
  private buildElementsMarkdown(elements: ConductorElement[], includeConfig: boolean): string {
    const byKind: Record<string, ConductorElement[]> = {};
    for (const el of elements) {
      const category = this.categorizeElement(el.elementKind);
      if (!byKind[category]) byKind[category] = [];
      byKind[category].push(el);
    }

    const lines: string[] = [`## Canvas State (${elements.length} elements)\n`];

    const categoryOrder = ['Stickies', 'Shapes', 'Text', 'Documents', 'Images', 'Files', 'Links', 'Connectors', 'Widgets', 'Groups', 'Other'];
    for (const cat of categoryOrder) {
      if (!byKind[cat] || byKind[cat].length === 0) continue;
      lines.push(`### ${cat} (${byKind[cat].length})`);
      for (const el of byKind[cat]) {
        const pos = el.position as { x?: number; y?: number; w?: number; h?: number };
        const posStr = `${pos?.w ?? 0}x${pos?.h ?? 0} @ (${pos?.x ?? 0},${pos?.y ?? 0})`;
        const summary = this.summarizeElement(el.elementKind, el.config);
        const location = this.describeLocation(pos);
        let line = `- ${el.id} [${posStr}; ${location}] ${summary}`;
        if (includeConfig && el.config) {
          line += `\n  config: ${JSON.stringify(el.config)}`;
        }
        lines.push(line);
      }
      lines.push('');
    }

    return lines.join('\n');
  }

  private describeLocation(position: { x?: number; y?: number; w?: number; h?: number }): string {
    const centerX = (position.x ?? 0) + (position.w ?? 0) / 2;
    const centerY = (position.y ?? 0) + (position.h ?? 0) / 2;
    const column = centerX < 13.34 ? 'left' : centerX > 26.66 ? 'right' : 'center';
    const row = centerY < 10 ? 'top' : centerY > 20 ? 'bottom' : 'middle';
    return `${row}-${column}, center (${centerX.toFixed(1)}, ${centerY.toFixed(1)})`;
  }

  private buildRelationshipsMarkdown(elements: ConductorElement[]): string {
    const labels = new Map(elements.map((element) => [
      element.id,
      this.summarizeElement(element.elementKind, element.config) || element.id,
    ]));
    const lines: string[] = ['## Relationships'];

    for (const element of elements) {
      const config = element.config || {};
      if (element.elementKind === 'native/connector') {
        const source = resolveConnectorEndpoint(config.source);
        const target = resolveConnectorEndpoint(config.target);
        const label = typeof config.label === 'string' && config.label ? ` (${config.label})` : '';
        lines.push(`- connector${label}: ${source} [${labels.get(source) ?? 'unknown'}] → ${target} [${labels.get(target) ?? 'unknown'}]`);
      }
      if (element.elementKind === 'native/group') {
        const memberIds = Array.isArray(config.memberIds)
          ? config.memberIds.filter((id): id is string => typeof id === 'string')
          : [];
        lines.push(`- group ${element.id}: ${memberIds.map((id) => `${id} [${labels.get(id) ?? 'unknown'}]`).join(', ') || 'empty'}`);
      }
      if (element.elementKind === 'native/link') {
        const target = typeof config.url === 'string' ? config.url : typeof config.targetId === 'string' ? config.targetId : 'unknown target';
        const type = config.linkType === 'canvas' || config.linkType === 'session' ? config.linkType : 'url';
        lines.push(`- link ${element.id}: ${type} → ${target}`);
      }
    }

    return lines.length === 1 ? '## Relationships\n- No explicit connectors, groups, or links.' : lines.join('\n');
  }

  createElement(payload: Record<string, unknown>): ExecutorRpcResponse {
    const canvasId = payload.canvasId as string;
    const elementKind = payload.kind as string;
    const position = payload.position as Record<string, unknown>;
    const vizSpec = (payload.vizSpec as Record<string, unknown>) || null;
    const config = (payload.config as Record<string, unknown>) || {};
    const sourceCode = (payload.sourceCode as string | null | undefined) ?? null;

    const validation = validateElementInput(elementKind, position, config);
    if (!validation.valid) {
      return {
        success: false,
        error: { code: 'INVALID_INPUT', message: formatValidationErrors(validation) },
      };
    }

    const defaultedPosition = applyDefaultDimensions(elementKind, position);
    const clampedPosition = clampPositionToCanvas(defaultedPosition, CANVAS_WIDTH_UNITS, CANVAS_HEIGHT_UNITS);
    const elementId = this.ensureUniqueElementId();
    const now = Date.now();
    const permissions = { agentCanRead: true, agentCanWrite: true, agentCanDelete: true };
    const metadata = { label: elementKind, tags: [] as string[], createdBy: ACTOR };

    insertElement(elementId, canvasId, elementKind, clampedPosition, config, vizSpec, permissions, metadata, now, null, sourceCode);

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
      position: clampedPosition,
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
        element: summarizeElementForAgent(element),
        actionId: 0,
        timestamp: now,
      },
    };

    this.emit(canvasId, result.diff, elementId);

    return { success: true, result };
  }

  /**
   * Create multiple elements and connectors in a single atomic transaction.
   * Supports ref bindings so connectors can reference elements created
   * earlier in the same batch. If any insert fails, the whole batch
   * rolls back. Dangling connector references produce warnings but do
   * not abort the batch — the LLM can fix them in a follow-up call.
   */
  batchCreate(payload: Record<string, unknown>): ExecutorRpcResponse {
    const canvasId = payload.canvasId as string;
    const operations = payload.operations as Array<Record<string, unknown>>;

    if (!Array.isArray(operations) || operations.length === 0) {
      return {
        success: false,
        error: { code: 'INVALID_INPUT', message: 'operations must be a non-empty array' },
      };
    }

    // Pass 1: pre-generate elementIds for create ops with ref bindings.
    // Connectors cannot be referenced (no ref created for op=connect).
    const refs = new Map<string, string>();
    for (const op of operations) {
      if ((op.op as string) === 'create') {
        const ref = op.ref as string | undefined;
        if (ref) {
          refs.set(ref, randomUUID());
        }
      }
    }

    const createdElements: Array<Record<string, unknown>> = [];
    const warnings: string[] = [];
    const batchTimestamp = Date.now();

    const dbInstance = getDatabase();
    if (!dbInstance) {
      return {
        success: false,
        error: { code: 'INTERNAL', message: 'Database not initialized' },
      };
    }

    // Pass 2: execute all operations inside a single transaction.
    // If any insert throws, the whole batch rolls back.
    const runBatch = dbInstance.transaction(() => {
      for (const op of operations) {
        const opType = op.op as string;

        if (opType === 'create') {
          const ref = op.ref as string | undefined;
          const elementId = ref ? (refs.get(ref) ?? this.ensureUniqueElementId()) : this.ensureUniqueElementId();
          if (ref) refs.set(ref, elementId);

          const elementKind = op.kind as string;
          const position = (op.position as Record<string, unknown>) ?? {};
          const config = (op.config as Record<string, unknown>) ?? {};
          const vizSpec = (op.vizSpec as Record<string, unknown> | undefined) ?? null;
          const sourceCode = (op.sourceCode as string | null | undefined) ?? null;

          const validation = validateElementInput(elementKind, position, config);
          if (!validation.valid) {
            throw new Error(`Invalid operation for ref '${ref ?? '(no ref)'}': ${formatValidationErrors(validation)}`);
          }

          const clampedPosition = clampPositionToCanvas(position, CANVAS_WIDTH_UNITS, CANVAS_HEIGHT_UNITS);
          const now = Date.now();
          const permissions = { agentCanRead: true, agentCanWrite: true, agentCanDelete: true };
          const metadata = { label: elementKind, tags: [] as string[], createdBy: ACTOR };

          insertElement(
            elementId,
            canvasId,
            elementKind,
            clampedPosition,
            config,
            vizSpec,
            permissions,
            metadata,
            now,
            null,
            sourceCode,
          );

          writeActionLog({
            canvasId,
            widgetId: null,
            actor: ACTOR,
            actionType: 'element.create',
            payload: { elementKind, position, config, vizSpec },
            resultPatch: { elementId },
          });

          // Include full element data (config, vizSpec, sourceCode) so the
          // renderer's batch_create patch handler can render the new element
          // immediately without a follow-up snapshot reload. Without this,
          // widget/dynamic elements appeared blank until the next reload.
          createdElements.push({
            id: elementId,
            ref: ref ?? null,
            kind: elementKind,
            elementKind,
            position: clampedPosition,
            config,
            vizSpec,
            ...(sourceCode ? { sourceCode } : {}),
            state: 'idle',
            dataVersion: 1,
            permissions,
            metadata,
            createdAt: now,
            updatedAt: now,
          });
        } else if (opType === 'connect') {
          const sourceRaw = op.source as string | undefined;
          const targetRaw = op.target as string | undefined;

          // Resolve source: ref first, then existing elementId.
          let sourceId: string | null = null;
          if (sourceRaw) {
            if (refs.has(sourceRaw)) {
              sourceId = refs.get(sourceRaw) as string;
            } else if (getElement(sourceRaw, canvasId)) {
              sourceId = sourceRaw;
            } else {
              warnings.push(
                `Connector source '${sourceRaw}' not found in refs or canvas`,
              );
            }
          }

          // Resolve target: ref first, then existing elementId.
          let targetId: string | null = null;
          if (targetRaw) {
            if (refs.has(targetRaw)) {
              targetId = refs.get(targetRaw) as string;
            } else if (getElement(targetRaw, canvasId)) {
              targetId = targetRaw;
            } else {
              warnings.push(
                `Connector target '${targetRaw}' not found in refs or canvas`,
              );
            }
          }

          const connectorPosition = { x: 0, y: 0, w: 0, h: 0, zIndex: 0, rotation: 0 };
          const curvature = (op.curvature as number) ?? 0.4;
          const style = (op.style as Record<string, unknown>) ?? {};
          const routingMode = op.routingMode === 'curve' ? 'curve' : 'elbow';
          const connectorConfig = {
            source: { nodeId: sourceId },
            target: { nodeId: targetId },
            curvature,
            routingMode,
            label: typeof op.label === 'string' ? op.label : undefined,
            strokeStyle: typeof op.strokeStyle === 'string' ? op.strokeStyle : undefined,
            lineWidth: typeof op.lineWidth === 'number' ? op.lineWidth : undefined,
            color: typeof op.color === 'string' ? op.color : undefined,
            startMarker: typeof op.startMarker === 'string' ? op.startMarker : undefined,
            endMarker: typeof op.endMarker === 'string' ? op.endMarker : undefined,
            style,
          };

          const shapeValidation = validateConnectorShape(connectorConfig);
          if (!shapeValidation.valid) {
            throw new Error(`Invalid connector operation: ${formatValidationErrors(shapeValidation)}`);
          }

          const elementId = this.ensureUniqueElementId();
          const now = Date.now();
          const nativeKind = 'connector';
          const elementKind = 'native/connector';
          const connectorMetadata = {
            label: 'Connector',
            tags: [] as string[],
            createdBy: ACTOR,
            parentId: null,
            childIds: [] as string[],
          };
          const permissions = {
            agentCanRead: true,
            agentCanWrite: true,
            agentCanDelete: true,
          };

          insertElement(
            elementId,
            canvasId,
            elementKind,
            connectorPosition,
            connectorConfig,
            null,
            permissions,
            connectorMetadata,
            now,
            nativeKind,
          );

          writeActionLog({
            canvasId,
            widgetId: null,
            actor: ACTOR,
            actionType: 'connector.create',
            payload: { source: sourceId, target: targetId, curvature, style },
            resultPatch: {
              elementId,
              elementKind,
              config: connectorConfig,
              metadata: connectorMetadata,
            },
          });

          createdElements.push({
            id: elementId,
            ref: null,
            kind: elementKind,
            elementKind,
            position: connectorPosition,
            // Connector needs config.source/target to render the line.
            config: connectorConfig,
            vizSpec: null,
            state: 'idle',
            dataVersion: 1,
            permissions,
            metadata: connectorMetadata,
            createdAt: now,
            updatedAt: now,
          });
        }
      }
    });

    try {
      runBatch();
    } catch (err) {
      return {
        success: false,
        error: {
          code: 'BATCH_FAILED',
          message: err instanceof Error ? err.message : String(err),
        },
      };
    }

    const batchDiff = {
      type: 'element.batch_create',
      canvasId,
      elements: createdElements,
      actionId: 0,
      timestamp: batchTimestamp,
    };

    // Emit patch for live update (was missing — bug fix, aligns with createElement)
    this.emit(canvasId, batchDiff);

    // Post-create overlap detection among newly created elements
    const createdRects = createdElements
      .filter((e) => {
        const kind = e.kind as string;
        const pos = e.position as Record<string, unknown> | undefined;
        return kind !== 'native/connector' && pos && pos.w && pos.h;
      })
      .map((e) => {
        const pos = e.position as Record<string, unknown>;
        return {
          id: e.id as string,
          x: (pos.x as number) ?? 0,
          y: (pos.y as number) ?? 0,
          w: (pos.w as number) ?? 0,
          h: (pos.h as number) ?? 0,
        };
      });
    for (let i = 0; i < createdRects.length; i++) {
      for (let j = i + 1; j < createdRects.length; j++) {
        const a = createdRects[i];
        const b = createdRects[j];
        if (a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y) {
          warnings.push(`overlap: ${a.id} and ${b.id} bounding boxes intersect — consider moving one`);
        }
      }
    }

    return {
      success: true,
      result: {
        diff: batchDiff,
        warnings,
      },
    };
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

    this.emit(canvasId, result.diff, elementId);

    return { success: true, result };
  }

  /**
   * Merge-patch the element's `config` field without replacing it.
   * Used by `canvas_fill_content` (content fields) and `canvas_style_element`
   * (visual fields). Reads the previous config, shallow-merges the patch,
   * then writes it back via `updateElementConfig`.
   *
   * Also handles an optional `sourceCode` payload field for widget/dynamic
   * elements — this lets the agent update a widget's HTML/SVG after creation
   * without deleting and recreating it.
   */
  updateElementContent(payload: Record<string, unknown>): ExecutorRpcResponse {
    const canvasId = payload.canvasId as string;
    const elementId = payload.elementId as string;
    const patch = (payload.config as Record<string, unknown>) || {};
    const sourceCodePatch = payload.sourceCode as string | null | undefined;

    const prev = getElement(elementId, canvasId);
    if (!prev) {
      return {
        success: false,
        error: { code: 'NOT_FOUND', message: `Element ${elementId} not found` },
      };
    }

    const prevConfig = (prev.config as Record<string, unknown>) || {};
    const mergedConfig: Record<string, unknown> = { ...prevConfig, ...patch };
    if (prev.elementKind === 'native/document') syncCanvasDocument(canvasId, mergedConfig);
    const now = Date.now();
    updateElementConfig(elementId, mergedConfig, now);

    const changes: Record<string, unknown> = {
      config: mergedConfig,
      prevConfig,
      patch,
    };

    // Update sourceCode if provided (widget/dynamic only). This allows
    // the agent to revise a widget's HTML/SVG after creation — e.g. fix
    // a layout bug or change the dashboard's data display.
    if (sourceCodePatch !== undefined && prev.elementKind === 'widget/dynamic') {
      updateElementSourceCode(elementId, sourceCodePatch, now);
      changes.sourceCode = sourceCodePatch;
      changes.prevSourceCode = prev.sourceCode;
    }

    writeActionLog({
      canvasId,
      widgetId: null,
      actor: ACTOR,
      actionType: 'element.update_content',
      payload: { elementId, config: patch, sourceCode: sourceCodePatch },
      resultPatch: changes,
    });

    const result: ElementActionResult = {
      diff: {
        type: 'element.update_content',
        targetId: elementId,
        canvasId,
        changes,
        actionId: 0,
        timestamp: now,
      },
    };

    this.emit(canvasId, result.diff, elementId);

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
        // onStatePatch handler looks for `deletedElement` to remove
        // the element from the store.
        deletedElement: { id: elementId },
        actionId: 0,
        timestamp: now,
      },
    };

    this.emit(canvasId, result.diff, elementId);

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

    this.emit(canvasId, result.diff);

    return { success: true, result };
  }

  /**
   * Compute a layout preview without applying it. The agent calls this,
   * inspects the preview (optionally via canvas_capture + vision_analyze),
   * then calls element.arrange to commit.
   */
  autoLayout(payload: Record<string, unknown>): ExecutorRpcResponse {
    const canvasId = payload.canvasId as string;
    const algorithm = (payload.algorithm as 'bin-pack' | 'flow' | 'viewport-aware') ?? 'bin-pack';
    const viewportAware = payload.viewportAware !== false;
    const preserveLocked = payload.preserveLocked !== false;
    const gap = (payload.gap as number) ?? 0.25;
    const rowAlign = (payload.rowAlign as 'start' | 'center' | 'end') ?? 'start';

    const snapshot = this.getCanvasSnapshot(canvasId);
    if (!snapshot.success) {
      return { success: false, error: { code: 'CANVAS_NOT_FOUND', message: `Canvas ${canvasId} not found` } };
    }
    const snapshotData = snapshot.result as CanvasSnapshotResult;

    // Map DB elements to the layout module's LayoutElement shape.
    const layoutElements: LayoutElement[] = snapshotData.elements
      .filter(el => el.elementKind !== 'native/connector')
      .map(el => ({
        id: el.id,
        position: el.position as LayoutElement['position'],
        metadata: ((el as any).metadata as LayoutElement['metadata']) ?? { locked: false, priority: 'mid' as const },
      }));

    // Canvas dimensions (40x30 grid units).
    const viewport = { width: CANVAS_WIDTH_UNITS, height: CANVAS_HEIGHT_UNITS };

    let results: LayoutResult[];
    if (algorithm === 'flow') {
      results = flowLayout(layoutElements, { viewport: { width: viewport.width }, gap, rowAlign, preserveLocked });
    } else if (algorithm === 'viewport-aware') {
      // Split into existing (all) and incoming (none) — viewport-aware pack
      // with no incoming just re-packs existing into the viewport.
      results = viewportAwarePack(layoutElements, [], {
        viewport,
        gap,
        preserveLocked,
        maxFreeRects: 32,
        priorityWeight: { high: 0, mid: 1, low: 2 },
      });
    } else {
      // bin-pack (default)
      results = binPack(layoutElements, { viewport, gap, preserveLocked, maxFreeRects: 32 });
    }

    // Compute stats.
    const visibleCount = results.filter(r =>
      r.position.x >= 0 && r.position.x + r.position.w <= viewport.width &&
      r.position.y >= 0 && r.position.y + r.position.h <= viewport.height
    ).length;
    const fillRate = results.length > 0
      ? visibleCount / results.length
      : 0;

    return {
      success: true,
      result: {
        preview: results.map(r => ({
          id: r.id,
          x: r.position.x,
          y: r.position.y,
          w: r.position.w,
          h: r.position.h,
        })),
        stats: { fillRate, visibleCount, total: results.length },
      },
    };
  }
  alignElement(payload: Record<string, unknown>): ExecutorRpcResponse {
    const canvasId = payload.canvasId as string;
    const elementId = payload.elementId as string;
    const alignment = payload.alignment as string;
    // `margin` is documented to be in screen pixels; convert to grid units
    // (1 unit = 80 px) so the stored x/y stays in the same coordinate
    // system as the element's existing w/h.
    const marginPx = (payload.margin as number) || 20;
    const margin = marginPx / 80;

    const element = getElement(elementId, canvasId);
    if (!element) {
      return {
        success: false,
        error: { code: 'NOT_FOUND', message: `Element ${elementId} not found` },
      };
    }

    const elPos = element.position as Record<string, number>;
    const elW = elPos.w || 0;
    const elH = elPos.h || 0;
    const newPos: Record<string, number> = { ...elPos };

    switch (alignment) {
      case 'top-left': newPos.x = margin; newPos.y = margin; break;
      case 'top-right': newPos.x = CANVAS_WIDTH_UNITS - elW - margin; newPos.y = margin; break;
      case 'bottom-left': newPos.x = margin; newPos.y = CANVAS_HEIGHT_UNITS - elH - margin; break;
      case 'bottom-right': newPos.x = CANVAS_WIDTH_UNITS - elW - margin; newPos.y = CANVAS_HEIGHT_UNITS - elH - margin; break;
      case 'center': newPos.x = (CANVAS_WIDTH_UNITS - elW) / 2; newPos.y = (CANVAS_HEIGHT_UNITS - elH) / 2; break;
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
        // onStatePatch handler reads `position` from resultPatch
        position: newPos,
        actionId: 0,
        timestamp: now,
      },
    };

    this.emit(canvasId, result.diff, elementId);

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

    this.emit(canvasId, result.diff);

    return { success: true, result };
  }

  createNativeElement(payload: Record<string, unknown>): ExecutorRpcResponse {
    const canvasId = payload.canvasId as string;
    const nodeType = payload.nodeType as string;
    const position = payload.position as Record<string, unknown>;
    const content = (payload.content as Record<string, unknown>) || {};
    const style = (payload.style as Record<string, unknown>) || {};
    const parentId = payload.parentId as string | null | undefined;

    const elementKind = `native/${nodeType}`;
    const elementId = this.ensureUniqueElementId();
    const config = nodeType === 'document'
      ? { ...prepareCanvasDocument(canvasId, elementId, content), style }
      : { ...content, style };

    const validation = validateElementInput(elementKind, position, config);
    if (!validation.valid) {
      return {
        success: false,
        error: { code: 'INVALID_INPUT', message: formatValidationErrors(validation) },
      };
    }

    const defaultedPosition = applyDefaultDimensions(elementKind, position);
    const clampedPosition = clampPositionToCanvas(defaultedPosition, CANVAS_WIDTH_UNITS, CANVAS_HEIGHT_UNITS);
    const now = Date.now();
    const nativeKind = nodeType;
    const metadata = {
      label: content.label || nodeType,
      tags: [],
      createdBy: ACTOR,
      parentId: parentId || null,
      childIds: [],
    };
    const permissions = { agentCanRead: true, agentCanWrite: true, agentCanDelete: true };

    insertElement(elementId, canvasId, elementKind, clampedPosition, config, null, permissions, metadata, now, nativeKind);

    writeActionLog({
      canvasId,
      widgetId: null,
      actor: ACTOR,
      actionType: 'element.create_native',
      payload: { nodeType, position, content, style, parentId },
      resultPatch: { elementId, elementKind, config, metadata },
    });

    const diff = {
      type: 'element.create_native',
      targetId: elementId,
      canvasId,
      element: summarizeElementForAgent({
        id: elementId,
        canvasId,
        elementKind,
        position: clampedPosition,
        config,
      }),
      actionId: 0,
      timestamp: now,
    };

    this.emit(canvasId, diff, elementId);

    return { success: true, result: { diff } };
  }

  createConnector(payload: Record<string, unknown>): ExecutorRpcResponse {
    const canvasId = payload.canvasId as string;
    const rawSource = payload.source;
    const rawTarget = payload.target;
    const curvature = (payload.curvature as number) || 0.4;
    const style = (payload.style as Record<string, unknown>) || {};
    const routingMode = payload.routingMode === 'curve' ? 'curve' : 'elbow';

    const source = this.normalizeConnectorEndpoint(rawSource) ?? (rawSource as Record<string, unknown>);
    const target = this.normalizeConnectorEndpoint(rawTarget) ?? (rawTarget as Record<string, unknown>);
    const config = {
      source,
      target,
      curvature,
      routingMode,
      label: typeof payload.label === 'string' ? payload.label : undefined,
      strokeStyle: typeof payload.strokeStyle === 'string' ? payload.strokeStyle : undefined,
      lineWidth: typeof payload.lineWidth === 'number' ? payload.lineWidth : undefined,
      color: typeof payload.color === 'string' ? payload.color : undefined,
      startMarker: typeof payload.startMarker === 'string' ? payload.startMarker : undefined,
      endMarker: typeof payload.endMarker === 'string' ? payload.endMarker : undefined,
      style,
    };
    const shapeValidation = validateConnectorShape(config);
    if (!shapeValidation.valid) {
      return {
        success: false,
        error: { code: 'INVALID_INPUT', message: formatValidationErrors(shapeValidation) },
      };
    }

    const warnings: string[] = [];
    const sourceId = (source as { nodeId?: string }).nodeId ?? (rawSource as string);
    const targetId = (target as { nodeId?: string }).nodeId ?? (rawTarget as string);
    if (!getElement(sourceId, canvasId)) {
      warnings.push(`Connector source element ${sourceId} not found on canvas ${canvasId}`);
    }
    if (!getElement(targetId, canvasId)) {
      warnings.push(`Connector target element ${targetId} not found on canvas ${canvasId}`);
    }

    const elementId = this.ensureUniqueElementId();
    const now = Date.now();
    const nativeKind = 'connector';
    const elementKind = 'native/connector';
    const position = { x: 0, y: 0, w: 0, h: 0, zIndex: 0, rotation: 0 };
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

    const diff = {
      type: 'connector.create',
      targetId: elementId,
      canvasId,
      element: summarizeElementForAgent({
        id: elementId,
        canvasId,
        elementKind,
        position,
        config,
      }),
      actionId: 0,
      timestamp: now,
    };

    this.emit(canvasId, diff, elementId);

    return {
      success: true,
      result: {
        diff,
        warnings: warnings.length > 0 ? warnings : undefined,
      },
    };
  }

  /**
   * Create a group element. Group kind is `native/group`; the config
   * stores the GroupContent ({ title?, bgColor?, memberIds }). All
   * memberIds must already exist on the same canvas — cross-canvas
   * references are rejected.
   */
  createGroup(payload: Record<string, unknown>): ExecutorRpcResponse {
    const canvasId = payload.canvasId as string;
    const memberIds = payload.memberIds as string[];
    const title = payload.title as string | undefined;
    const bgColor = payload.bgColor as string | undefined;

    if (!Array.isArray(memberIds) || memberIds.length === 0) {
      return {
        success: false,
        error: { code: 'INVALID_INPUT', message: 'memberIds must be a non-empty array' },
      };
    }

    // Cross-canvas validation: every memberId must already exist on canvasId.
    for (const mid of memberIds) {
      const found = getElement(mid, canvasId);
      if (!found) {
        return {
          success: false,
          error: { code: 'INVALID_INPUT', message: `Member ${mid} not found on canvas ${canvasId}` },
        };
      }
    }

    // Reuse createNativeElement path so the renderer's existing patch
    // handler picks up the new element via resultPatch.element.
    const groupPayload: Record<string, unknown> = {
      canvasId,
      nodeType: 'group',
      position: { x: 0, y: 0, w: 0, h: 0, zIndex: -1, rotation: 0 },
      content: {
        title: title ?? '',
        bgColor: bgColor ?? '',
        memberIds,
      },
      style: {},
    };
    return this.createNativeElement(groupPayload);
  }

  /**
   * Delete a group element. Member elements are NOT deleted — only the
   * group frame is removed. Reuses the existing deleteElement path so
   * the renderer removes the group element via resultPatch.deletedElement.
   */
  ungroup(payload: Record<string, unknown>): ExecutorRpcResponse {
    const canvasId = payload.canvasId as string;
    const groupId = payload.groupId as string;

    if (!groupId) {
      return {
        success: false,
        error: { code: 'INVALID_INPUT', message: 'groupId is required' },
      };
    }

    const existing = getElement(groupId, canvasId);
    if (!existing) {
      return {
        success: false,
        error: { code: 'NOT_FOUND', message: `Group ${groupId} not found on canvas ${canvasId}` },
      };
    }
    if (existing.elementKind !== 'native/group') {
      return {
        success: false,
        error: { code: 'INVALID_INPUT', message: `Element ${groupId} is not a group` },
      };
    }

    const deletePayload: Record<string, unknown> = { canvasId, elementId: groupId };
    return this.deleteElement(deletePayload);
  }

  /**
   * Append memberIds to an existing group's config.memberIds (deduped).
   * Rejects self-reference (memberIds containing groupId itself) and
   * cross-canvas references. Reuses updateElementContent so the
   * renderer applies a merge-patch via resultPatch.config.
   */
  addGroupMembers(payload: Record<string, unknown>): ExecutorRpcResponse {
    const canvasId = payload.canvasId as string;
    const groupId = payload.groupId as string;
    const memberIds = payload.memberIds as string[];

    if (!groupId) {
      return {
        success: false,
        error: { code: 'INVALID_INPUT', message: 'groupId is required' },
      };
    }
    if (!Array.isArray(memberIds) || memberIds.length === 0) {
      return {
        success: false,
        error: { code: 'INVALID_INPUT', message: 'memberIds must be a non-empty array' },
      };
    }

    // Self-reference check: a group cannot contain itself.
    if (memberIds.includes(groupId)) {
      return {
        success: false,
        error: { code: 'INVALID_INPUT', message: 'A group cannot be a member of itself' },
      };
    }

    const existing = getElement(groupId, canvasId);
    if (!existing) {
      return {
        success: false,
        error: { code: 'NOT_FOUND', message: `Group ${groupId} not found on canvas ${canvasId}` },
      };
    }
    if (existing.elementKind !== 'native/group') {
      return {
        success: false,
        error: { code: 'INVALID_INPUT', message: `Element ${groupId} is not a group` },
      };
    }

    // Cross-canvas validation: every new memberId must exist on canvasId.
    for (const mid of memberIds) {
      const found = getElement(mid, canvasId);
      if (!found) {
        return {
          success: false,
          error: { code: 'INVALID_INPUT', message: `Member ${mid} not found on canvas ${canvasId}` },
        };
      }
    }

    const existingConfig = (existing.config as Record<string, unknown>) || {};
    const existingMemberIds = (existingConfig.memberIds as string[]) || [];
    const merged = Array.from(new Set([...existingMemberIds, ...memberIds]));

    const contentPayload: Record<string, unknown> = {
      canvasId,
      elementId: groupId,
      config: { ...existingConfig, memberIds: merged },
    };
    return this.updateElementContent(contentPayload);
  }

  /**
   * Remove memberIds from an existing group's config.memberIds.
   * Reuses updateElementContent so the renderer applies a merge-patch
   * via resultPatch.config.
   */
  removeGroupMembers(payload: Record<string, unknown>): ExecutorRpcResponse {
    const canvasId = payload.canvasId as string;
    const groupId = payload.groupId as string;
    const memberIds = payload.memberIds as string[];

    if (!groupId) {
      return {
        success: false,
        error: { code: 'INVALID_INPUT', message: 'groupId is required' },
      };
    }
    if (!Array.isArray(memberIds) || memberIds.length === 0) {
      return {
        success: false,
        error: { code: 'INVALID_INPUT', message: 'memberIds must be a non-empty array' },
      };
    }

    const existing = getElement(groupId, canvasId);
    if (!existing) {
      return {
        success: false,
        error: { code: 'NOT_FOUND', message: `Group ${groupId} not found on canvas ${canvasId}` },
      };
    }
    if (existing.elementKind !== 'native/group') {
      return {
        success: false,
        error: { code: 'INVALID_INPUT', message: `Element ${groupId} is not a group` },
      };
    }

    const existingConfig = (existing.config as Record<string, unknown>) || {};
    const existingMemberIds = (existingConfig.memberIds as string[]) || [];
    const removeSet = new Set(memberIds);
    const merged = existingMemberIds.filter((id) => !removeSet.has(id));

    const contentPayload: Record<string, unknown> = {
      canvasId,
      elementId: groupId,
      config: { ...existingConfig, memberIds: merged },
    };
    return this.updateElementContent(contentPayload);
  }

}
