/** Legacy Agent-compatible barrel; the wire values are owned by agent-protocol. */
import type { ComputerUseAction } from '@duya/agent-protocol';

export {
  COMPUTER_USE_TOOL_NAME,
  COMPUTER_USE_ACTIONS,
  COMPUTER_USE_ACTION_LIST,
  COMPUTER_USE_CONTEXT_TOOL_NAME,
  COMPUTER_USE_CONTEXT_ACTIONS,
  COMPUTER_USE_DECIDE_TOOL_NAME,
  COMPUTER_USE_IPC_CHANNEL,
  COMPUTER_USE_APPROVAL_CHANNEL,
  type ComputerUseAction,
  type ComputerUseContextAction,
  type ComputerUseExecuteAction,
} from '@duya/agent-protocol';

/**
 * Actions that require user confirmation before execution. These
 * are destructive / state-changing operations where the LLM could
 * easily misuse them.
 *
 * plan 564: `invoke` joins the set (it presses real buttons) — the
 * dispatcher exempts the focus-only variant from the gate.
 */
export const CONFIRM_REQUIRED_ACTIONS: ReadonlySet<ComputerUseAction> = new Set([
  'click',
  'drag',
  'set_value',
  'invoke',
]);

/**
 * Audit log directory under the standard DUYA logs path.
 * Phase 2 will write a single JSONL file per day here.
 */
export const COMPUTER_USE_AUDIT_DIR = 'computer-use';
