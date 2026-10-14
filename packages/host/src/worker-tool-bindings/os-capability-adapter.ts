/** Compatibility boundary from the Host invocation context to OS capabilities. */

import type { DecisionResponse, Question } from '@duya/ai';
import type { ComputerUseExecutionContext, ComputerUseDecisionPort, ComputerUseRuntimePorts } from '@duya/capabilities/OSTool/ports';
import type { ToolExecutor as CapabilityToolExecutor } from '@duya/capabilities/contracts';
import type { ToolUseContext as AgentToolUseContext } from '@duya/host/worker-run-contracts';
import type { ToolExecutor as AgentToolExecutor } from '@duya/host/worker-tool-registry';
import { DecisionUnavailableError, getDecisionService } from '@duya/host/decisions';

const decisionServicePort: ComputerUseDecisionPort = {
  get available() {
    try {
      return getDecisionService().available;
    } catch {
      return false;
    }
  },
  ask(state: unknown, questions: Record<string, Question>): Promise<DecisionResponse> {
    return getDecisionService().ask(state, questions);
  },
  isUnavailableError(error: unknown): boolean {
    return error instanceof DecisionUnavailableError;
  },
};

export function getWorkerComputerUseRuntimePorts(ipcRequest?: ComputerUseRuntimePorts['ipcRequest']): ComputerUseRuntimePorts {
  return { decisionService: decisionServicePort, ...(ipcRequest === undefined ? {} : { ipcRequest }) };
}

/**
 * Expose only the session, working-directory, IPC, and decision ports used by
 * these capabilities. Agent lifecycle and application state stay on this side
 * of the package boundary.
 */
export function toCapabilityContext(
  context: AgentToolUseContext | undefined,
  workingDirectory?: string,
): ComputerUseExecutionContext | undefined {
  if (!context) return undefined;

  const effectiveWorkingDirectory = workingDirectory ?? context.options?.workingDirectory;
  return {
    toolUseId: context.toolUseId,
    ...(effectiveWorkingDirectory === undefined ? {} : { workingDirectory: effectiveWorkingDirectory }),
    options: {
      ...(context.options?.sessionId === undefined ? {} : { sessionId: context.options?.sessionId }),
      ...(effectiveWorkingDirectory === undefined ? {} : { workingDirectory: effectiveWorkingDirectory }),
      mainLoopModel: context.options?.mainLoopModel,
    },
    computerUsePorts: {
      ...(context.ipcRequest === undefined ? {} : { ipcRequest: context.ipcRequest }),
      decisionService: decisionServicePort,
    },
  };
}

export function adaptCapabilityExecutor(executor: CapabilityToolExecutor): AgentToolExecutor {
  return {
    execute: (input, workingDirectory, context) =>
      executor.execute(input, workingDirectory, toCapabilityContext(context, workingDirectory)),
  };
}
