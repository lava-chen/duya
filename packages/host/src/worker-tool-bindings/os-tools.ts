/** Host product barrel for capability-owned computer-use tools. */

import type { ToolRegistration } from '@duya/host/worker-modes/modifiers/types';
import { definition as computerUseDefinition, executor as computerUseExecutor } from '@duya/host/worker-tool-bindings/computer-use-tool';
import { contextDefinition, contextExecutor } from '@duya/host/worker-tool-bindings/computer-use-context-tool';
import { decideDefinition, decideExecutor, isComputerUseDecideAvailable } from '@duya/host/worker-tool-bindings/computer-use-decide-tool';
import { definition as computerCuaDefinition, executor as computerCuaExecutor } from '@duya/host/worker-tool-bindings/computer-cua-tool';

export {
  definition as computerUseDefinition,
  executor as computerUseExecutor,
  ComputerUseErrorCode,
  type ComputerUseErrorCode as ComputerUseErrorCodeType,
  type ComputerUseToolEnvelope,
} from '@duya/host/worker-tool-bindings/computer-use-tool';

export {
  COMPUTER_CUA_TOOL_NAME,
  COMPUTER_CUA_IPC_CHANNEL,
  COMPUTER_CUA_TOOLS,
  computerCuaInputSchema,
  definition as computerCuaDefinition,
  executor as computerCuaExecutor,
  type ComputerCuaEnvelope,
  type ComputerCuaToolName,
} from '@duya/host/worker-tool-bindings/computer-cua-tool';

export {
  COMPUTER_USE_TOOL_NAME,
  COMPUTER_USE_ACTIONS,
  COMPUTER_USE_ACTION_LIST,
  COMPUTER_USE_IPC_CHANNEL,
  COMPUTER_USE_APPROVAL_CHANNEL,
  COMPUTER_USE_AUDIT_DIR,
  CONFIRM_REQUIRED_ACTIONS,
  COMPUTER_USE_CONTEXT_TOOL_NAME,
  COMPUTER_USE_CONTEXT_ACTIONS,
  COMPUTER_USE_DECIDE_TOOL_NAME,
  type ComputerUseAction,
  type ComputerUseContextAction,
  type ComputerUseExecuteAction,
} from '@duya/capabilities/OSTool/constants';

export {
  type ComputerUseContextTrigger,
  computerUseContextInputSchema,
  contextDefinition,
  contextExecutor,
  recordComputerUseContextTrigger,
  shouldInjectComputerUseContext,
  getComputerUseContextTriggers,
  clearComputerUseContextTrigger,
} from '@duya/host/worker-tool-bindings/computer-use-context-tool';

export {
  decideDefinition as computerUseDecideDefinition,
  decideExecutor as computerUseDecideExecutor,
  isComputerUseDecideAvailable,
  type ComputerUseDecideEnvelope,
} from '@duya/host/worker-tool-bindings/computer-use-decide-tool';

export { computerUseInputSchema } from '@duya/capabilities/OSTool/schema';

export function getComputerUseTools(): ToolRegistration[] {
  return [{ definition: computerUseDefinition, executor: computerUseExecutor }];
}

export function getComputerUseToolsWithContext(): ToolRegistration[] {
  return [
    { definition: computerUseDefinition, executor: computerUseExecutor },
    { definition: contextDefinition, executor: contextExecutor },
  ];
}

export function getComputerUseToolsWithDecide(includeContext: boolean): ToolRegistration[] {
  const registrations = includeContext ? getComputerUseToolsWithContext() : getComputerUseTools();
  if (isComputerUseDecideAvailable()) {
    registrations.push({ definition: decideDefinition, executor: decideExecutor });
  }
  return registrations;
}

export function getComputerUseToolsWithCua(includeContext: boolean): ToolRegistration[] {
  return [
    ...getComputerUseToolsWithDecide(includeContext),
    { definition: computerCuaDefinition, executor: computerCuaExecutor },
  ];
}
