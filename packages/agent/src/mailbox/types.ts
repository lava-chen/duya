/**
 * types.ts — Mailbox type re-exports and PR2 additions.
 *
 * The PR1 surface (`MailboxKind`, `MailboxStatus`, `MailboxApplyMode`,
 * `MailboxRow`) lives in `session/db.ts` because PR1 only needed IPC-shaped
 * wrappers; PR2 introduces a service class that needs the same types without
 * creating a circular dep back into `session/db.ts`. Re-exporting here keeps
 * callers (`MailboxService`, `assertValidApply`, the run-loop patch in
 * `index.ts`) importing from a single mailbox-domain module.
 *
 * `CheckpointType` is PR2-new and lives here.
 */
export type {
  MailboxKind,
  MailboxStatus,
  MailboxApplyMode,
  MailboxRow,
} from '../session/db.js';

// =============================================================================
// PR2 additions
// =============================================================================

/**
 * The 9 checkpoint slots where the run loop / tool executor / permission gate
 * must call into `MailboxService.claimBatch` (per Plan 202 §5.2 / §9).
 *
 * Order is meaningful for `claimBatch`'s mixed-kind resolution (§6.4) but
 * not for `assertValidApply` (which is per-pair).
 */
export type CheckpointType =
  | 'before_model_turn'
  | 'after_model_turn'
  | 'before_tool_call'
  | 'after_tool_call'
  | 'before_file_write'
  | 'before_shell_command'
  | 'before_final_answer'
  | 'on_permission_request'
  | 'on_error_recovery';

/**
 * Thrown by `assertValidApply` when a checkpoint × apply_mode pair violates
 * the matrix in Plan 202 §5.2. The renderer never sees this error — it is a
 * programming-error guard inside the agent process. The error carries enough
 * context for `app.log` to surface the offending checkpoint/mode pair.
 */
export class ApplyViolationError extends Error {
  readonly checkpoint: CheckpointType;
  readonly mode: import('../session/db.js').MailboxApplyMode;

  constructor(
    checkpoint: CheckpointType,
    mode: import('../session/db.js').MailboxApplyMode,
  ) {
    super(
      `apply(mode=${mode}) is not permitted at checkpoint=${checkpoint} (see Plan 202 §5.2)`,
    );
    this.name = 'ApplyViolationError';
    this.checkpoint = checkpoint;
    this.mode = mode;
  }
}
