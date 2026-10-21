/** Temporary worker adapter for capability-owned connector management tools. */

import {
  ConnectAppTool as CapabilityConnectAppTool,
  ListAppConnectorsTool as CapabilityListAppConnectorsTool,
  CONNECT_APP_TOOL_NAME,
  LIST_APP_CONNECTORS_TOOL_NAME,
} from '@duya/capabilities/AppConnectorManageTool/AppConnectorManageTool';
import type {
  AppConnectorAuthRequest,
  AppConnectorManagementContext,
} from '@duya/capabilities/AppConnectorManageTool/ports';
import type { ToolUseContext } from '@duya/host/worker-run-contracts';

export { CONNECT_APP_TOOL_NAME, LIST_APP_CONNECTORS_TOOL_NAME };

function adaptContext(context?: ToolUseContext): AppConnectorManagementContext | undefined {
  if (!context) return undefined;
  const appConnectorManagement = context.ipcRequest
    ? {
        getCatalog: () => context.ipcRequest!('appConnection:catalog', {}, { timeout: 15_000 }),
        ...(context.sendToMain
          ? {
              requestAuthorization: (event: AppConnectorAuthRequest) =>
                context.sendToMain!({ type: 'chat:connector_auth_required', ...event }),
            }
          : {}),
      }
    : undefined;
  return {
    toolUseId: context.toolUseId,
    ...(context.options.workingDirectory === undefined ? {} : { workingDirectory: context.options.workingDirectory }),
    options: {
      ...(context.options.sessionId === undefined ? {} : { sessionId: context.options.sessionId }),
      ...(context.options.workingDirectory === undefined ? {} : { workingDirectory: context.options.workingDirectory }),
      mainLoopModel: context.options.mainLoopModel,
    },
    ...(appConnectorManagement ? { appConnectorManagement } : {}),
  };
}

export class ListAppConnectorsTool {
  readonly #delegate = new CapabilityListAppConnectorsTool();
  get name() { return this.#delegate.name; }
  get description() { return this.#delegate.description; }
  get input_schema() { return this.#delegate.input_schema; }

  toTool() { return this.#delegate.toTool(); }

  execute(input: Record<string, unknown>, workingDirectory: string | undefined, context?: ToolUseContext) {
    return this.#delegate.execute(input, workingDirectory, adaptContext(context));
  }
}

export class ConnectAppTool {
  readonly #delegate = new CapabilityConnectAppTool();
  get name() { return this.#delegate.name; }
  get description() { return this.#delegate.description; }
  get input_schema() { return this.#delegate.input_schema; }

  toTool() { return this.#delegate.toTool(); }

  execute(input: Record<string, unknown>, workingDirectory: string | undefined, context?: ToolUseContext) {
    return this.#delegate.execute(input, workingDirectory, adaptContext(context));
  }
}
