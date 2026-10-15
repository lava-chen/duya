/** Host-owned composition binding for the Host MCP apply state machine. */

import { MCPManager } from '@duya/capabilities/MCP/MCPManager';
import {
  createMCPToolExecutor,
  type MCPExecutorPorts,
} from '@duya/agent-runtime/tools/mcp-executor';
import {
  applyMCPConfiguration,
  type ApplyReason,
  type MCPApplyResult,
  type MCPApplyRuntimePort,
} from './apply.js';

/** The small portion of a worker session needed to install an MCP generation. */
export type WorkerMCPApplyTarget<TContext extends object> = Pick<
  MCPApplyRuntimePort<MCPManager, TContext>,
  'getActiveMCPManager' | 'getNonMCPModelVisibleToolNames' | 'setActiveMCPRuntime'
>;

export interface WorkerMCPApplyOptions<TContext extends object> {
  readonly target: WorkerMCPApplyTarget<TContext>;
  /** Runtime authorization and invocation context for MCP tool executors. */
  readonly executorPorts: MCPExecutorPorts<TContext>;
  readonly reason: ApplyReason;
  readonly agentProfileId?: string;
}

/** Bind one worker session to Host-owned manager/executor construction. */
export function createWorkerMCPApplyRuntime<TContext extends object>(
  target: WorkerMCPApplyTarget<TContext>,
  executorPorts: MCPExecutorPorts<TContext>,
): MCPApplyRuntimePort<MCPManager, TContext> {
  return {
    getActiveMCPManager: () => target.getActiveMCPManager(),
    getNonMCPModelVisibleToolNames: () => target.getNonMCPModelVisibleToolNames(),
    setActiveMCPRuntime: (snapshot) => target.setActiveMCPRuntime(snapshot),
    createManager: () => new MCPManager(),
    createMCPToolExecutor: (options) => createMCPToolExecutor({
      ...options,
      ports: executorPorts,
    }),
  };
}

/** The production worker entry point for MCP config/reload operations. */
export function applyWorkerMCPConfiguration<TContext extends object>(
  options: WorkerMCPApplyOptions<TContext>,
): Promise<MCPApplyResult> {
  return applyMCPConfiguration({
    runtime: createWorkerMCPApplyRuntime(options.target, options.executorPorts),
    reason: options.reason,
    ...(options.agentProfileId === undefined ? {} : { agentProfileId: options.agentProfileId }),
  });
}
