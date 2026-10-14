import type { DecisionResponse, Question } from '@duya/ai';
import type { ToolUseContext } from '../contracts/tool.js';

export interface ComputerUseIpcResponse<T = unknown> {
  success: boolean;
  data?: T;
  error?: { code: string; message: string };
}

/** Narrow request bridge used by the OS computer-use capabilities. */
export type ComputerUseIpcRequest = <T = unknown>(
  channel: string,
  payload: unknown,
  options?: { timeout?: number },
) => Promise<ComputerUseIpcResponse<T>>;

export interface ComputerUseDecisionPort {
  available: boolean;
  ask(state: unknown, questions: Record<string, Question>): Promise<DecisionResponse>;
  isUnavailableError(error: unknown): boolean;
}

export interface ComputerUseRuntimePorts {
  ipcRequest?: ComputerUseIpcRequest;
  decisionService?: ComputerUseDecisionPort;
}

/** Tool-specific ports carried only at the Agent compatibility boundary. */
export interface ComputerUseExecutionContext extends ToolUseContext {
  computerUsePorts?: ComputerUseRuntimePorts;
}

export function getComputerUseRuntimePorts(
  context?: ToolUseContext,
): ComputerUseRuntimePorts | undefined {
  return (context as ComputerUseExecutionContext | undefined)?.computerUsePorts;
}
