import { createToolInvokeDispatcherFromRegistry as createRuntimeDispatcher } from '@duya/agent-runtime/tools/discovery';
import type { ToolInvokeDispatcherDeps } from '@duya/agent-runtime/tools/discovery';
import { logger } from '@duya/host/worker-logger';
import { checkCheckoutToolWrite } from '../workspace/tool-write-gate.js';
export type { ToolInvokeDispatcherDeps, ToolInvokePermissionDecision } from '@duya/agent-runtime/tools/discovery';
export const createToolInvokeDispatcherFromRegistry = (deps: ToolInvokeDispatcherDeps) =>
  createRuntimeDispatcher({
    ...deps,
    logger,
    beforeExecute: async (toolName, input, context) => {
      const refusal = await deps.beforeExecute?.(toolName, input, context);
      if (refusal) return refusal;
      const options = context?.options;
      const sessionId = options && 'sessionId' in options && typeof options.sessionId === 'string'
        ? options.sessionId : undefined;
      const denial = await checkCheckoutToolWrite({ toolName, input, workingDirectory: deps.workingDirectory, sessionId });
      if (denial) return { result: denial.message, error: true, errorCode: denial.code, toolName };
      return undefined;
    },
  });
