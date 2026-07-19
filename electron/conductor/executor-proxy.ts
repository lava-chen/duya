/**
 * executor-proxy.ts - Conductor Executor Proxy
 *
 * Routes executor RPC requests to the appropriate database service.
 * This is the single entry point for agent-side tool execution.
 *
 * NOTE: This is infrastructure code. ConductorAgent does not yet emit
 * `conductor:executor:rpc` messages; tool execution currently goes through
 * the standard Agent loop. This proxy is pre-wired in main.ts and will be
 * activated when the ConductorAgent is updated to use the RPC pattern.
 */

import { ConductorDbService } from './db-service';
import type {
  ExecutorRpcRequest,
  ExecutorRpcResponse,
} from './executor-types';
import {
  createCanvas,
  listCanvases,
  listCanvasesForProject,
  updateCanvas,
  type ConductorCanvas,
} from '../db/queries/conductors';
import { getSession, updateSession } from '../db/queries/sessions';

export type { ExecutorRpcRequest, ExecutorRpcResponse } from './executor-types';

/**
 * Function that requests a canvas screenshot from the renderer process.
 * The main process injects this when constructing the proxy — it sends
 * a message to the renderer via channelManager and resolves when the
 * renderer responds via IPC.
 */
export type CanvasCaptureFn = (
  canvasId: string,
  scope: string,
  elementId?: string,
  region?: { x: number; y: number; w: number; h: number },
) => Promise<{
  pngBase64: string;
  width: number;
  height: number;
  dataUrl: string;
  scope: string;
  capturedAt: string;
}>;

export interface CanvasManagementEvent {
  operation: 'create' | 'switch' | 'rename';
  sessionId?: string;
  canvas: ConductorCanvas;
  currentCanvasId?: string;
}

export type CanvasManagementChangedFn = (event: CanvasManagementEvent) => void;

export class ConductorExecutorProxy {
  private dbService: ConductorDbService;
  private captureFn: CanvasCaptureFn | null = null;
  private canvasManagementChangedFn: CanvasManagementChangedFn | null = null;

  constructor() {
    this.dbService = new ConductorDbService();
  }

  /**
   * Inject the renderer capture function. Called by main.ts after the
   * renderer window is ready and channelManager is initialized.
   */
  setCaptureFn(fn: CanvasCaptureFn): void {
    this.captureFn = fn;
  }

  /**
   * Inject the broadcast function used to push state:patch messages
   * to the renderer. Called by main.ts after channelManager is ready.
   * Without this, agent edits write to DB but the canvas won't
   * live-update.
   */
  setBroadcastPatch(fn: import('./db-service').BroadcastPatchFn): void {
    this.dbService.setBroadcastPatch(fn);
  }

  setCanvasManagementChangedFn(fn: CanvasManagementChangedFn): void {
    this.canvasManagementChangedFn = fn;
  }

  private resolveCurrentCanvas(sessionId: string | undefined, fallbackCanvasId?: string): ConductorCanvas | null {
    const canvases = listCanvases();
    const persistedCanvasId = sessionId ? getSession(sessionId)?.conductor_canvas_id : null;
    const currentCanvasId = persistedCanvasId ?? fallbackCanvasId;
    return currentCanvasId ? canvases.find((canvas) => canvas.id === currentCanvasId) ?? null : null;
  }

  private bindSessionToCanvas(sessionId: string | undefined, canvas: ConductorCanvas): ExecutorRpcResponse | null {
    if (!sessionId) {
      return {
        success: false,
        error: { code: 'NO_SESSION', message: 'A chat session is required to switch canvases' },
      };
    }
    const updated = updateSession(sessionId, {
      conductor_mode_enabled: 1,
      conductor_canvas_id: canvas.id,
    });
    if (!updated) {
      return {
        success: false,
        error: { code: 'SESSION_NOT_FOUND', message: `Session ${sessionId} not found` },
      };
    }
    return null;
  }

  private manageCanvas(request: ExecutorRpcRequest): ExecutorRpcResponse {
    const payload = request.payload;
    const action = payload.action as 'get_current' | 'list' | 'create' | 'switch' | 'rename';
    const fallbackCanvasId = payload.currentCanvasId as string | undefined;
    const currentCanvas = this.resolveCurrentCanvas(request.sessionId, fallbackCanvasId);
    // Resolve the session's working directory once so every branch below
    // (list / create / switch / rename) agrees on the project scope.
    const session = request.sessionId ? getSession(request.sessionId) : null;
    const sessionProjectPath = session?.working_directory ?? null;

    if (action === 'get_current') {
      return { success: true, result: { action, currentCanvas } };
    }

    if (action === 'list') {
      const canvases = sessionProjectPath
        ? listCanvasesForProject(sessionProjectPath)
        : listCanvases();
      // Always include the current canvas even if it didn't match the
      // project filter (defensive — keeps the agent's current target
      // visible even when its project_path disagrees with the session).
      if (currentCanvas && !canvases.some((c) => c.id === currentCanvas.id)) {
        canvases.unshift(currentCanvas);
      }
      return { success: true, result: { action, currentCanvas, canvases } };
    }

    if (action === 'create') {
      const name = typeof payload.name === 'string' ? payload.name.trim() : '';
      if (!name) {
        return { success: false, error: { code: 'INVALID_INPUT', message: 'Canvas name is required' } };
      }
      const shouldSwitch = payload.switchTo !== false;
      if (shouldSwitch && (!request.sessionId || !getSession(request.sessionId))) {
        return {
          success: false,
          error: { code: 'SESSION_NOT_FOUND', message: 'A valid chat session is required to create and switch canvases' },
        };
      }
      const canvas = createCanvas({
        name,
        description: payload.description as string | undefined,
        projectPath: sessionProjectPath,
      });
      if (shouldSwitch) {
        const bindError = this.bindSessionToCanvas(request.sessionId, canvas);
        if (bindError) return bindError;
      }
      this.canvasManagementChangedFn?.({
        operation: 'create',
        sessionId: request.sessionId,
        canvas,
        currentCanvasId: shouldSwitch ? canvas.id : undefined,
      });
      return {
        success: true,
        result: { action, canvas, currentCanvas: shouldSwitch ? canvas : currentCanvas, switched: shouldSwitch },
      };
    }

    const canvasId = payload.canvasId as string;
    const target = listCanvases().find((canvas) => canvas.id === canvasId);
    if (!target) {
      return { success: false, error: { code: 'NOT_FOUND', message: `Canvas ${canvasId} not found` } };
    }

    if (action === 'switch') {
      if (!this.isCanvasAccessible(target, sessionProjectPath)) {
        return {
          success: false,
          error: {
            code: 'CANVAS_NOT_ACCESSIBLE',
            message: `Canvas ${canvasId} belongs to a different project and cannot be switched to from this session`,
          },
        };
      }
      const bindError = this.bindSessionToCanvas(request.sessionId, target);
      if (bindError) return bindError;
      this.canvasManagementChangedFn?.({
        operation: 'switch',
        sessionId: request.sessionId,
        canvas: target,
        currentCanvasId: target.id,
      });
      return { success: true, result: { action, currentCanvas: target, canvas: target, switched: true } };
    }

    if (action === 'rename') {
      const name = typeof payload.name === 'string' ? payload.name.trim() : '';
      if (!name) {
        return { success: false, error: { code: 'INVALID_INPUT', message: 'Canvas name is required' } };
      }
      if (!this.isCanvasAccessible(target, sessionProjectPath)) {
        return {
          success: false,
          error: {
            code: 'CANVAS_NOT_ACCESSIBLE',
            message: `Canvas ${canvasId} belongs to a different project and cannot be renamed from this session`,
          },
        };
      }
      const renamed = updateCanvas(canvasId, { name });
      this.canvasManagementChangedFn?.({
        operation: 'rename',
        sessionId: request.sessionId,
        canvas: renamed,
        currentCanvasId: currentCanvas?.id,
      });
      return {
        success: true,
        result: {
          action,
          canvas: renamed,
          currentCanvas: currentCanvas?.id === renamed.id ? renamed : currentCanvas,
        },
      };
    }

    return { success: false, error: { code: 'INVALID_ACTION', message: `Unknown canvas management action: ${action}` } };
  }

  /**
   * A canvas is accessible to a session when:
   *   - it has no project_path (legacy / shared), OR
   *   - its project_path matches the session's working directory, OR
   *   - it is already the session's current canvas (caller checks this
   *     before calling by only invoking switch/rename on a target the
   *     agent picked, but the helper stays defensive by treating null
   *     sessionProjectPath as "no project scope, anything shared OK").
   *
   * Returns false when the canvas is bound to a different project and
   * the session has no claim to it.
   */
  private isCanvasAccessible(canvas: ConductorCanvas, sessionProjectPath: string | null): boolean {
    if (canvas.projectPath === null || canvas.projectPath === undefined) return true;
    if (!sessionProjectPath) return false;
    return canvas.projectPath === sessionProjectPath;
  }

  async execute(request: ExecutorRpcRequest): Promise<ExecutorRpcResponse> {
    const { action, payload } = request;

    try {
      switch (action) {
        case 'canvas.manage':
          return this.manageCanvas(request);

        case 'canvas.snapshot':
          return this.dbService.getCanvasSnapshot(payload.canvasId as string);

        case 'canvas.describe_context':
          return this.dbService.describeCanvasContext(payload);

        case 'canvas.capture': {
          if (!this.captureFn) {
            return {
              success: false,
              error: {
                code: 'CAPTURE_NOT_READY',
                message: 'Canvas capture is not available (renderer not connected)',
              },
            };
          }
          const canvasId = payload.canvasId as string;
          const scope = (payload.scope as string) || 'viewport';
          const elementId = payload.elementId as string | undefined;
          const region = payload.region as
            | { x: number; y: number; w: number; h: number }
            | undefined;

          const captureResult = await this.captureFn(canvasId, scope, elementId, region);
          return {
            success: true,
            result: captureResult,
          };
        }

        case 'element.create':
          return this.dbService.createElement(payload);

        case 'element.batch_create':
          return this.dbService.batchCreate(payload);

        case 'element.update':
          return this.dbService.updateElement(payload);

        case 'element.update_content':
          return this.dbService.updateElementContent(payload);

        case 'element.delete':
          return this.dbService.deleteElement(payload);

        case 'element.arrange':
          return this.dbService.arrangeElements(payload);

        case 'element.align':
          return this.dbService.alignElement(payload);

        case 'element.layout_grid':
          return this.dbService.layoutGridElements(payload);

        case 'element.create_native':
          return this.dbService.createNativeElement(payload);

        case 'connector.create':
          return this.dbService.createConnector(payload);

        case 'group.create':
          return this.dbService.createGroup(payload);

        case 'group.ungroup':
          return this.dbService.ungroup(payload);

        case 'group.add_members':
          return this.dbService.addGroupMembers(payload);

        case 'group.remove_members':
          return this.dbService.removeGroupMembers(payload);

        case 'canvas.list_elements':
          return this.dbService.listElements(payload);

        case 'canvas.find_empty_space':
          return this.dbService.findEmptySpace(payload);
        case 'canvas.auto_layout':
          return this.dbService.autoLayout(payload);

        default:
          return {
            success: false,
            error: { code: 'UNKNOWN_ACTION', message: `Unknown executor action: ${action}` },
          };
      }
    } catch (err) {
      return {
        success: false,
        error: { code: 'INTERNAL', message: err instanceof Error ? err.message : String(err) },
      };
    }
  }
}
