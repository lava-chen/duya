/**
 * assertValidApply.ts — Pure guard for the apply-mode × checkpoint matrix
 * defined in Plan 202 §5.2.
 *
 * Single source of truth for "which apply modes are valid at which checkpoint".
 * Called from `MailboxService.apply` (and indirectly from `MailboxService.defer`)
 * before any UPDATE on `agent_mailbox`. Throws `ApplyViolationError` on a
 * forbidden pair; the transaction rolls back.
 *
 * Invariant I4 (no user message may be inserted between a `tool_use` and its
 * `tool_result`) is the reason `promote_to_user_message` is forbidden at every
 * checkpoint where the assistant's next emission would be a `tool_result`.
 *
 * No I/O. Pure. Trivially unit-testable — U8 covers the full 9×6 matrix.
 */
import type { MailboxApplyMode } from '../session/db.js';
import { ApplyViolationError, type CheckpointType } from './types.js';

/**
 * The matrix encoded as a `Set<"checkpoint:mode">` of permitted pairs. Storing
 * the inverse complement (the permitted set) is more compact and more obvious
 * to read than a `forbidden` table — the matrix is small (25 permitted pairs),
 * and the helper is the only thing that ever consults it.
 */
const PERMITTED_PAIRS: ReadonlySet<string> = new Set<string>([
  // before_model_turn (3)
  'before_model_turn:promote_to_user_message',
  'before_model_turn:runtime_instruction',
  'before_model_turn:interrupt_signal',

  // after_model_turn (3)
  'after_model_turn:runtime_instruction',
  'after_model_turn:interrupt_signal',
  'after_model_turn:deferred_to_next_turn',

  // before_tool_call (3)
  'before_tool_call:tool_guard',
  'before_tool_call:interrupt_signal',
  'before_tool_call:runtime_instruction',

  // after_tool_call (4)
  'after_tool_call:runtime_instruction',
  'after_tool_call:tool_guard',
  'after_tool_call:interrupt_signal',
  'after_tool_call:deferred_to_next_turn',

  // before_file_write (2)
  'before_file_write:tool_guard',
  'before_file_write:interrupt_signal',

  // before_shell_command (2)
  'before_shell_command:tool_guard',
  'before_shell_command:interrupt_signal',

  // before_final_answer (3)
  // NOTE: promote_to_user_message here is special — it triggers a NEW TURN,
  // not a finalisation. Plan 202 §5.2 explicitly calls this out.
  'before_final_answer:promote_to_user_message',
  'before_final_answer:runtime_instruction',
  'before_final_answer:interrupt_signal',

  // on_permission_request (2)
  'on_permission_request:permission_context',
  'on_permission_request:interrupt_signal',

  // on_error_recovery (3)
  'on_error_recovery:runtime_instruction',
  'on_error_recovery:interrupt_signal',
  'on_error_recovery:deferred_to_next_turn',
]);

/**
 * Assert that `mode` is a permitted `apply_mode` at `checkpoint`.
 *
 * @throws {ApplyViolationError} on a forbidden pair.
 */
export function assertValidApply(checkpoint: CheckpointType, mode: MailboxApplyMode): void {
  if (!PERMITTED_PAIRS.has(`${checkpoint}:${mode}`)) {
    throw new ApplyViolationError(checkpoint, mode);
  }
}

/**
 * Predicate form of `assertValidApply`. Useful for the run loop's "should I
 * even attempt this apply?" check before constructing the transaction.
 */
export function isValidApply(checkpoint: CheckpointType, mode: MailboxApplyMode): boolean {
  return PERMITTED_PAIRS.has(`${checkpoint}:${mode}`);
}

/** Exported for tests only — the canonical permitted set, in `checkpoint:mode` form. */
export const __PERMITTED_PAIRS_FOR_TESTING = PERMITTED_PAIRS;
