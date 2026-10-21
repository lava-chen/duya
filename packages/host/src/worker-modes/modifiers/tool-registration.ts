import type { ToolDefinition as CapabilityToolDefinition, ToolExecutor as CapabilityToolExecutor } from '@duya/capabilities/contracts';
import type { RuntimeToolDefinition, ToolExecutor as RuntimeToolExecutor } from '@duya/agent-runtime/tools/catalog';
import type { ToolUseContext as WorkerToolUseContext } from '../../worker-run-contracts.js';
import type { ToolExecutor as WorkerToolExecutor } from '../../worker-tool-registry.js';
import type { WorkerModeToolContext, WorkerModeToolContextOptions } from '../tool-ports.js';
import type { ToolRegistration } from './types.js';

interface WorkerModeToolRegistration {
  definition: RuntimeToolDefinition;
  executor: RuntimeToolExecutor<WorkerModeToolContext>;
}

/**
 * Adapt Host mode tool services to the capability registration contract.
 * Runtime tool contexts are richer than the structural capability context;
 * copying the options record preserves worker-only fields such as provider,
 * goal verifier count, and the available subagent definitions.
 */
export function adaptWorkerModeToolRegistrations(
  registrations: readonly WorkerModeToolRegistration[],
): ToolRegistration[] {
  return registrations.map(({ definition, executor }) => ({
    definition,
    executor: adaptWorkerModeToolExecutor(executor),
  }));
}

export function adaptCapabilityToolRegistrations(
  registrations: readonly { definition: CapabilityToolDefinition; executor: CapabilityToolExecutor }[],
): ToolRegistration[] {
  return registrations.map(({ definition, executor }) => ({
    definition: {
      ...definition,
      input_schema: definition.input_schema as Record<string, unknown>,
    },
    executor: executor as WorkerToolExecutor,
  }));
}

function adaptWorkerModeToolExecutor(
  executor: RuntimeToolExecutor<WorkerModeToolContext>,
): WorkerToolExecutor {
  return {
    execute: (input, workingDirectory, context) =>
      executor.execute(
        input,
        workingDirectory,
        toWorkerModeToolContext(context, workingDirectory),
      ),
  };
}

function toWorkerModeToolContext(
  context: WorkerToolUseContext | undefined,
  workingDirectory: string | undefined,
): WorkerModeToolContext | undefined {
  if (!context) return undefined;
  const options = context.options as WorkerModeToolContextOptions | undefined;
  return {
    options: {
      ...(options ?? {}),
      ...(workingDirectory === undefined ? {} : { workingDirectory }),
    },
  };
}
