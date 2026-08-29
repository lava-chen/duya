/**
 * index.ts — OSTool barrel (plan 454 §5 Task B).
 *
 * Exports the single computer_use tool (definition + executor pair)
 * so the ModeModifier can inject it directly. Re-exports the
 * constants + schema so other modules (tests, prompts) can reference
 * them without reaching into private paths.
 */

import type { ToolRegistration } from '../../modes/types.js';
import { definition, executor } from './ComputerUseTool.js';

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
  type ComputerUseAction,
} from './constants.js';

export { computerUseInputSchema } from './schema.js';

/**
 * Return the single tool as a ToolRegistration pair. Phase 2 uses
 * this in `computer-use-mode.ts` ModeModifier's `tools.inject`.
 */
export function getComputerUseTools(): ToolRegistration[] {
  return [{ definition, executor }];
}