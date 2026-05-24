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

        case 'element.create_native':
          return this.dbService.createNativeElement(payload);

        case 'connector.create':
          return this.dbService.createConnector(payload);

        case 'mindmap.create':
          return this.dbService.createMindMap(payload);

        case 'mindmap.add_node': {
          const mindmapId = payload.mindmapId as string;
          const parentId = payload.parentId as string;
          const newNode = payload.newNode as Record<string, unknown>;
          return this.dbService.mindmapAddNode(mindmapId, parentId, newNode);
        }

        case 'mindmap.remove_node': {
          const mindmapId = payload.mindmapId as string;
          const nodeId = payload.nodeId as string;
          return this.dbService.mindmapRemoveNode(mindmapId, nodeId);
        }

        case 'mindmap.toggle_collapse': {
          const mindmapId = payload.mindmapId as string;
          const nodeId = payload.nodeId as string;
          return this.dbService.mindmapToggleCollapse(mindmapId, nodeId);
        }

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