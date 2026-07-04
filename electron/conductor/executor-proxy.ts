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

export class ConductorExecutorProxy {
  private dbService: ConductorDbService;
  private captureFn: CanvasCaptureFn | null = null;

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

  async execute(request: ExecutorRpcRequest): Promise<ExecutorRpcResponse> {
    const { action, payload } = request;

    try {
      switch (action) {
        case 'canvas.snapshot':
          return this.dbService.getCanvasSnapshot(payload.canvasId as string);

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

        case 'element.update':
          return this.dbService.updateElement(payload);

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
