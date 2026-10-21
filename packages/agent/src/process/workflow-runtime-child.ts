/** Legacy Agent worker adapter for the Host-owned workflow runtime child. */

import {
  runWorkflowRuntimeChild as runHostWorkflowRuntimeChild,
  type WorkflowRuntimeChildOptions as HostWorkflowRuntimeChildOptions,
} from '@duya/host/worker-workflows/runtime-child';
import { createLegacyWorkflowExecutionPorts } from './legacy-workflow-execution.js';

export type WorkflowRuntimeChildOptions = Omit<HostWorkflowRuntimeChildOptions, 'execution'>;
export type {
  WorkflowRuntimeInitCommand,
  WorkflowRuntimePermissionResolveCommand,
  WorkflowRuntimeCancelCommand,
} from '@duya/host/worker-workflows/runtime-child';

export async function runWorkflowRuntimeChild(
  options: WorkflowRuntimeChildOptions = {},
): Promise<void> {
  return runHostWorkflowRuntimeChild({
    ...options,
    execution: (init) => ({
      createPorts: (workingDirectory) =>
        createLegacyWorkflowExecutionPorts({
          sessionId: '',
          llm: init.llm,
          workingDirectory,
        }),
    }),
  });
}
