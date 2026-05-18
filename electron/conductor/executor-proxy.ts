/**
 * executor-proxy.ts - Conductor Executor Proxy
 *
 * Routes executor RPC requests to the appropriate database service.
 * This is the single entry point for agent-side tool execution.
 */

import { ConductorDbService } from './db-service';
import type {
  ExecutorRpcRequest,
  ExecutorRpcResponse,
} from './executor-types';

export class ConductorExecutorProxy {
  private dbService: ConductorDbService;

  constructor() {
    this.dbService = new ConductorDbService();
  }

  execute(request: ExecutorRpcRequest): ExecutorRpcResponse {
    const { action, payload } = request;

    try {
      switch (action) {
        case 'canvas.snapshot':
          return this.dbService.getCanvasSnapshot(payload.canvasId as string);

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