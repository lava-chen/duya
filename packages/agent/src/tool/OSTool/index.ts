/**
 * index.ts — OSTool barrel (plan 454 §5 Task B).
 *
 * Exports the single computer_use tool (definition + executor pair)
 * so the ModeModifier can inject it directly. Re-exports the
 * constants + schema so other modules (tests, prompts) can reference
 * them without reaching into private paths.
 *
 * plan 519 (D2): also exports the conditional `computer_use_context`
 * sibling tool + its trigger registry, and the pair-returning
 * `getComputerUseToolsWithContext()` used by computer-use-mode's
 * function-form `tools.inject` when the escape hatch is armed.
 */

import type { ToolRegistration } from '../../modes/types.js';
import { definition, executor } from './ComputerUseTool.js';
import { contextDefinition, contextExecutor } from './context-tool.js';

export {
  definition as computerUseDefinition,
  executor as computerUseExecutor,
  ComputerUseErrorCode,
  type ComputerUseErrorCode as ComputerUseErrorCodeType,
  type ComputerUseToolEnvelope,
} from './ComputerUseTool.js';

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
  type ComputerUseAction,
  type ComputerUseContextAction,
  type ComputerUseExecuteAction,
} from './constants.js';

export {
  type ComputerUseContextTrigger,
  computerUseContextInputSchema,
  contextDefinition,
  contextExecutor,
  recordComputerUseContextTrigger,
  shouldInjectComputerUseContext,
  getComputerUseContextTriggers,
  clearComputerUseContextTrigger,
} from './context-tool.js';

export { computerUseInputSchema } from './schema.js';

/**
 * Return the single tool as a ToolRegistration pair. Phase 2 uses
 * this in `computer-use-mode.ts` ModeModifier's `tools.inject`.
 */
export function getComputerUseTools(): ToolRegistration[] {
  return [{ definition, executor }];
}

/**
 * plan 519 §3.2 (D2): the vision tool plus the conditional
 * `computer_use_context` escape hatch. The CALLER decides whether the
 * context tool belongs in this run's tool list (computer-use-mode's
 * inject consults `shouldInjectComputerUseContext(sessionId)`); this
 * helper just pairs the two registrations.
 */
export function getComputerUseToolsWithContext(): ToolRegistration[] {
  return [
    { definition, executor },
    { definition: contextDefinition, executor: contextExecutor },
  ];
}
