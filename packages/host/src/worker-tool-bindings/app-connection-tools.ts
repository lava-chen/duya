/**
 * Temporary worker adapter for the capability-owned App Connection tools.
 * Host assembly supplies the same narrow ports directly when the Agent
 * package is retired.
 */

import {
  createAppConnectionTool as createCapabilityAppConnectionTool,
  getCachedAppConnectionDescriptors,
  registerAppConnectionTools as registerCapabilityAppConnectionTools,
  setCachedAppConnectionDescriptors,
  type AppConnectionToolContext,
  type AppConnectionToolDescriptor,
  type ConnectorReauthorizationRequest,
  type ConnectorReplaceSetPort,
} from '@duya/capabilities/AppConnectionTool/index';
import type { Tool, ToolUseContext } from '@duya/host/worker-run-contracts';
import type { ToolExecutor, ToolMetaInput, ToolRegistry } from '@duya/host/worker-tool-registry';

export type { AppConnectionToolDescriptor } from '@duya/capabilities/AppConnectionTool/index';

function adaptContext(context?: ToolUseContext): AppConnectionToolContext | undefined {
  if (!context) return undefined;
  const appConnection = context.ipcRequest
    ? {
        invoke: (request: Parameters<NonNullable<AppConnectionToolContext['appConnection']>['invoke']>[0], options: { timeout: number }) =>
          context.ipcRequest!('appConnection:invoke', request, options),
        ...(context.sendToMain
          ? {
              requestReauthorization: (event: ConnectorReauthorizationRequest) =>
                context.sendToMain!({ type: 'chat:connector_auth_required', ...event }),
            }
          : {}),
      }
    : undefined;
  return {
    toolUseId: context.toolUseId,
    ...(context.options.workingDirectory === undefined ? {} : { workingDirectory: context.options.workingDirectory }),
    options: {
      ...(context.options.workingDirectory === undefined ? {} : { workingDirectory: context.options.workingDirectory }),
      mainLoopModel: context.options.mainLoopModel,
      ...(context.options.sessionId === undefined ? {} : { sessionId: context.options.sessionId }),
    },
    ...(appConnection ? { appConnection } : {}),
  };
}

export function createAppConnectionTool(desc: AppConnectionToolDescriptor): {
  definition: Tool;
  executor: ToolExecutor;
  meta: ToolMetaInput;
} {
  const tool = createCapabilityAppConnectionTool(desc);
  return {
    definition: tool.definition,
    meta: tool.meta,
    executor: {
      execute: (input: Record<string, unknown>, workingDirectory?: string, context?: ToolUseContext) =>
        tool.executor.execute(input, workingDirectory, adaptContext(context)),
    },
  };
}

/** Keep the transport-specific executor wrapper outside the capability. */
function adaptExecutor(executor: ReturnType<typeof createCapabilityAppConnectionTool>['executor']): ToolExecutor {
  return {
    execute: (input: Record<string, unknown>, workingDirectory?: string, context?: ToolUseContext) =>
      executor.execute(input, workingDirectory, adaptContext(context)),
  };
}

export function registerAppConnectionTools(
  registry: ToolRegistry,
  descriptors: AppConnectionToolDescriptor[],
): { added: number; removed: number; downgraded: number } {
  return registerCapabilityAppConnectionTools(
    registry as unknown as ConnectorReplaceSetPort<ToolExecutor>,
    descriptors,
    adaptExecutor,
  );
}

export { getCachedAppConnectionDescriptors, setCachedAppConnectionDescriptors };
