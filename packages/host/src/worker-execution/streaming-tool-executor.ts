/**
 * Compatibility adapter for the Agent product context. Scheduling, streaming,
 * and tool-result production live in @duya/agent-runtime.
 */

import {
  StreamingToolExecutor as RuntimeStreamingToolExecutor,
  type CanUseToolFn,
  type CanUseToolDecision,
  type ExecutorConfig,
  type MessageUpdate as RuntimeMessageUpdate,
  type ToolCompleteCallback,
  type ToolErrorCallback,
  type ToolExecutionPorts,
  type ToolExecutionRegistry,
  type ToolExecutionResult as RuntimeToolExecutionResult,
  type ToolProgress,
  type ToolStartCallback,
  type ToolStatus,
  type ProgressStage,
  type ToolExecutionStats,
  type TrackedTool,
  type ProgressCallback,
  formatWorkerFailureContent,
  normalizeWorkerInput,
} from '@duya/agent-runtime/tools/execution';
import type { Message, PermissionRequestEvent, Tool, ToolUseContext } from '@duya/host/worker-run-contracts';
import type { ToolRegistry } from '@duya/host/worker-tool-registry';
import { getCachedAppConnectionDescriptors } from '@duya/capabilities/AppConnectionTool';
import { buildToolParamsDisplay } from '@duya/capabilities/AppConnectionTool/approval-message';
import { WorkerPool, getWorkerPool, type WorkerTaskExtended } from '@duya/host/worker-tool-pool';
import { logger } from '@duya/host/worker-logger';
import { LEGACY_TODO_WIRE_NAMES, TODO_TOOL_NAME } from '@duya/capabilities/TodoTool/TodoTool';

export type {
  CanUseToolDecision,
  CanUseToolFn,
  ExecutorConfig,
  ProgressCallback,
  ProgressStage,
  ToolCompleteCallback,
  ToolErrorCallback,
  ToolExecutionStats,
  ToolProgress,
  ToolStartCallback,
  ToolStatus,
  TrackedTool,
};
export { formatWorkerFailureContent, normalizeWorkerInput };

/** Legacy context shape retained for source compatibility. */
export interface ToolExecutionContext {
  abortController: AbortController;
  tools: Tool[];
  canUseTool: (toolName: string) => Promise<boolean>;
  toolUseContext: ToolUseContext;
}

/** Legacy result helper shape retained for source compatibility. */
export interface ToolExecutionResult {
  message: Message;
  contextModifier?: (context: ToolUseContext) => ToolUseContext;
}

export type MessageUpdate = RuntimeMessageUpdate<ToolUseContext>;

export function adaptAgentToolRegistry(registry: ToolRegistry): ToolExecutionRegistry {
  return {
    getTool: (name) => registry.getTool(name),
    getExecutor: (name) => registry.getExecutor(name),
    execute: async (name, input, workingDirectory, context) => {
      const result = await registry.execute(
        name,
        input,
        workingDirectory,
        context as ToolUseContext | undefined,
      );
      return result as unknown as RuntimeToolExecutionResult | null;
    },
    isToolConcurrencySafe: (name) => registry.isToolConcurrencySafe(name),
  };
}

export function createAgentToolExecutionPorts(
  context: ToolUseContext,
  config?: ExecutorConfig,
): ToolExecutionPorts<ToolUseContext> {
  const ports: ToolExecutionPorts<ToolUseContext> = {
    readSession: (current) => ({
      abortController: current.abortController,
      workingDirectory: current.options.workingDirectory,
      sessionId: current.options.sessionId,
    }),
    getAppState: (current) => current.getAppState() as Record<string, unknown>,
    isInvocationApproved: (current, invocationId) => {
      const approved = current.getAppState()._approvedToolUses as Record<string, boolean> | undefined;
      return approved?.[invocationId] === true;
    },
    markInvocationApproved: (current, invocationId) => {
      current.setAppState((previous) => ({
        ...previous,
        _approvedToolUses: {
          ...(previous._approvedToolUses as Record<string, boolean> | undefined),
          [invocationId]: true,
        },
      }));
    },
    createToolContext: (current, input) => ({
      ...current,
      toolUseId: input.toolUseId,
      abortController: input.abortController,
      options: {
        ...current.options,
        ...(input.workingDirectory !== undefined ? { workingDirectory: input.workingDirectory } : {}),
        ...(input.sessionId !== undefined ? { sessionId: input.sessionId } : {}),
      },
      ...(input.reportAgentProgress
        ? { reportAgentProgress: input.reportAgentProgress as ToolUseContext['reportAgentProgress'] }
        : {}),
    }),
    createPermissionContext: (current, input) => ({
      toolUseId: input.toolUseId,
      workingDirectory: input.workingDirectory,
      abortController: input.abortController,
      sessionId: input.sessionId,
      getAppState: current.getAppState,
    }),
    resolveToolKey: (current, name) => {
      const canonicalName = LEGACY_TODO_WIRE_NAMES.includes(
        name as (typeof LEGACY_TODO_WIRE_NAMES)[number],
      ) ? TODO_TOOL_NAME : name;
      return current.options.resolveMCPProviderToolName?.(canonicalName) ?? canonicalName;
    },
    getApprovalMetadata: (toolName, input) => {
      const descriptor = getCachedAppConnectionDescriptors().find((item) => item.name === toolName);
      if (!descriptor) return undefined;
      const toolParamsDisplay = buildToolParamsDisplay(input, descriptor.inputSchema);
      return toolParamsDisplay.length > 0 ? { toolParamsDisplay } : undefined;
    },
    logger: {
      debug: (message, details, component) => logger.debug(message, details, component),
      info: (message, details, component) => logger.info(message, details, component),
      warn: (message, details, component) => logger.warn(message, details, component),
      error: (message, error, details, component) => logger.error(
        message,
        error instanceof Error ? error : undefined,
        details,
        component,
      ),
    },
  };

  if (context.requestPermission) {
    ports.requestPermission = async (current, request) =>
      await current.requestPermission!(request as PermissionRequestEvent);
  }

  if (config?.workerTools && config.workerTools.length > 0) {
    const workerPool: WorkerPool = getWorkerPool();
    ports.worker = {
      executeTask: (request) => {
        const task: WorkerTaskExtended = {
          id: request.id,
          toolName: request.toolName,
          input: request.input,
          abortController: request.abortController,
          ...(request.workingDirectory !== undefined ? { workingDirectory: request.workingDirectory } : {}),
          ...(request.timeoutMs !== undefined ? { timeoutMs: request.timeoutMs } : {}),
          ...(request.sessionId !== undefined ? { sessionId: request.sessionId } : {}),
          ...(request.onOutput ? { onOutput: request.onOutput } : {}),
          ...(request.onProgress ? { onProgress: request.onProgress } : {}),
        };
        return workerPool.executeTask(task);
      },
    };
  }

  return ports;
}

export class StreamingToolExecutor extends RuntimeStreamingToolExecutor<ToolUseContext> {
  constructor(
    toolRegistry: ToolRegistry,
    canUseTool: CanUseToolFn,
    toolUseContext: ToolUseContext,
    config?: ExecutorConfig,
  ) {
    super(
      adaptAgentToolRegistry(toolRegistry),
      canUseTool,
      toolUseContext,
      config,
      createAgentToolExecutionPorts(toolUseContext, config),
    );
  }
}
