/** Compatibility adapter for Agent workers while Host owns MCP discovery/apply. */

import {
  applyWorkerMCPConfiguration,
  type WorkerMCPApplyTarget,
} from '@duya/host/connector-services/worker-session-binding';
import {
  type ApplyReason,
  type MCPApplyResult,
} from '@duya/host/connector-services/apply';
import type { MCPExecutorPorts } from '@duya/agent-runtime/tools/mcp-executor';
import type { ToolExecutionLogger } from '@duya/agent-runtime/tools/execution';
import type { PermissionMode } from '@duya/agent-runtime/authorization/permissions/types';
import type { ToolUseContext } from '../worker-run-contracts.js';
import { logger } from '../worker-logger.js';

export type { ActiveMCPRuntimeSnapshot, ApplyReason, MCPApplyResult } from '@duya/host/connector-services/apply';
export {
  clearLastMCPLoadResult,
  getLastMCPLoadResult,
  MCPApplyError,
  MCPLoadError,
  MCPRegistryReplaceError,
} from '@duya/host/connector-services/apply';

interface AgentMCPApplyTarget extends WorkerMCPApplyTarget<ToolUseContext> {
  getPermissionMode?(): PermissionMode;
}

export interface ApplyOpts {
  agent: AgentMCPApplyTarget;
  reason: ApplyReason;
  agentProfileId?: string;
}

const agentMcpExecutorLogger: ToolExecutionLogger = {
  info: (message, context, component) => logger.info(message, context, component),
  warn: (message, context, component) => logger.warn(message, context, component),
};

function createExecutorPorts(
  agent: AgentMCPApplyTarget,
): MCPExecutorPorts<ToolUseContext> {
  return {
    getToolUseId: (context) => context.toolUseId,
    getPermissionMode: () => agent.getPermissionMode?.(),
    getAppState: (context) => context.getAppState(),
    setAppState: (context, update) => {
      context.setAppState?.((previous) => update(previous));
    },
    requestPermission: async (context, request) => {
      if (!context.requestPermission) return undefined;
      return context.requestPermission({
        id: request.id,
        toolName: request.toolName,
        toolInput: request.toolInput,
        mode: 'generic',
        expiresAt: request.expiresAt,
        ...(request.decisionReason === undefined
          ? {}
          : { decisionReason: request.decisionReason }),
      });
    },
    logger: agentMcpExecutorLogger,
  };
}

/** Keep the legacy worker API while forwarding the state machine to Host. */
export function applyMCPConfiguration(opts: ApplyOpts): Promise<MCPApplyResult> {
  const { agent, reason, agentProfileId } = opts;
  const ports = createExecutorPorts(agent);
  return applyWorkerMCPConfiguration({
    target: agent,
    executorPorts: ports,
    reason,
    ...(agentProfileId === undefined ? {} : { agentProfileId }),
  });
}
