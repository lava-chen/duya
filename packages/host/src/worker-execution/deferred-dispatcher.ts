import { createToolInvokeDispatcherFromRegistry as createRuntimeDispatcher } from '@duya/agent-runtime/tools/discovery';
import type { ToolInvokeDispatcherDeps } from '@duya/agent-runtime/tools/discovery';
import { logger } from '@duya/host/worker-logger';
import { checkCheckoutToolWrite } from '../workspace/tool-write-gate.js';
import { acquireExecutionLocation, type ExecutionLocationSnapshot } from '../workspace/execution-location-fence.js';
export type { ToolInvokeDispatcherDeps, ToolInvokePermissionDecision } from '@duya/agent-runtime/tools/discovery';
export const createToolInvokeDispatcherFromRegistry = (deps: ToolInvokeDispatcherDeps) =>
  createRuntimeDispatcher({
    ...deps,
    logger,
    acquireExecutionLease: (context) => {
      // Discovery carries an opaque product context. The capability is created
      // by WorkerSession, never by model arguments or an external connector.
      const lease = acquireExecutionLocation(context as { executionLocation?: ExecutionLocationSnapshot } | undefined, deps.workingDirectory);
      if (!lease.ok) return { result: `[${lease.code}] ${lease.message}`, error: true, errorCode: lease.code };
      try {
        const downstream = deps.acquireExecutionLease?.(context);
        if (downstream && !('release' in downstream)) {
          lease.release();
          return downstream;
        }
        return { release: () => { try { downstream?.release(); } finally { lease.release(); } } };
      } catch (error) {
        lease.release();
        throw error;
      }
    },
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
