/** Legacy Agent worker adapter for the Host-owned workflow runner. */

import {
  launchSavedWorkflow as launchHostWorkflow,
  type WorkflowLaunchRequest,
  type WorkflowRunnerDeps as HostWorkflowRunnerDeps,
} from '@duya/host/worker-workflows/runner';
import { createLegacyWorkflowExecutionPorts } from './legacy-workflow-execution.js';

export type WorkflowRunnerDeps = Omit<HostWorkflowRunnerDeps, 'execution'>;

export async function launchSavedWorkflow(
  deps: WorkflowRunnerDeps,
  request: WorkflowLaunchRequest,
  signal?: AbortSignal,
): Promise<void> {
  return launchHostWorkflow(
    {
      ...deps,
      execution: {
        createPorts: (workingDirectory) =>
          createLegacyWorkflowExecutionPorts({
            sessionId: deps.sessionId,
            llm: deps.llm,
            workingDirectory,
          }),
      },
    },
    request,
    signal,
  );
}

export {
  applyArgDefaults,
  findMissingRequiredArgs,
} from '@duya/host/worker-workflows/runner';
export type {
  WorkflowArtifactDescriptor,
  WorkflowDefinitionSnapshot,
  WorkflowExecutionPorts,
  WorkflowLaunchRequest,
  WorkflowRunCreateRequest,
  WorkflowRunTerminal,
  WorkflowRunnerLlmConfig,
  WorkflowRunnerTransport,
  WorkflowToolCallContext,
  WorkflowToolCallResult,
} from '@duya/host/worker-workflows/runner';
