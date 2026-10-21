import { createToolInvokeDispatcherFromRegistry as createRuntimeDispatcher } from '@duya/agent-runtime/tools/discovery';
import type { ToolInvokeDispatcherDeps } from '@duya/agent-runtime/tools/discovery';
import { logger } from '@duya/host/worker-logger';
export type { ToolInvokeDispatcherDeps, ToolInvokePermissionDecision } from '@duya/agent-runtime/tools/discovery';
export const createToolInvokeDispatcherFromRegistry = (deps: ToolInvokeDispatcherDeps) =>
  createRuntimeDispatcher({ ...deps, logger });
