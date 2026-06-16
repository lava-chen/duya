/**
 * mailbox/index.ts — Barrel for the AgentMailbox service layer (PR2).
 *
 * Public surface exposed to the run loop in `packages/agent/src/index.ts`,
 * to tool executors that opt into checkpoint hooks (PR5), and to the
 * constraint normaliser (Phase D).
 *
 * The legacy PR1 mailbox functions (`mailboxSend` / `mailboxEdit` / etc.) in
 * `session/db.ts` are NOT re-exported here — they remain IPC-shaped wrappers
 * for the renderer path and should be imported directly from
 * `session/db.ts` to avoid coupling.
 */
export { MailboxService } from './MailboxService.js';
export type {
  MailboxServiceOptions,
  ClaimBatchInput,
  ClaimBatchResult,
} from './MailboxService.js';

export { assertValidApply, isValidApply } from './assertValidApply.js';

export {
  ApplyViolationError,
  type CheckpointType,
} from './types.js';
export type {
  MailboxKind,
  MailboxStatus,
  MailboxApplyMode,
  MailboxRow,
} from './types.js';
