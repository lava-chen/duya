/**
 * Plan 202 — AgentMailbox shared constants.
 *
 * Single source of truth for the Main side. The agent-side
 * `packages/agent/src/session/db.ts` keeps an identical copy (KEEP IN SYNC).
 *
 * Cross-package imports are avoided by design: the root package does not
 * depend on `@duya/agent`, so we duplicate the small map rather than
 * introduce a workspace dep just for one constant.
 */

export const MAILBOX_KIND_PRIORITY: Record<string, number> = {
  abort_and_replace: 0,
  stop: 10,
  correction: 50,
  constraint: 50,
  followup: 100,
};

/** Default priority used when the incoming kind is not in the map. */
export const MAILBOX_DEFAULT_PRIORITY = 100;

/** Valid mailbox kinds. Keep in sync with CHECK (kind IN ...) in schema. */
export const MAILBOX_KINDS = [
  'followup',
  'correction',
  'constraint',
  'stop',
  'abort_and_replace',
] as const;

export type MailboxKind = typeof MAILBOX_KINDS[number];

/** Valid mailbox statuses. */
export const MAILBOX_STATUSES = [
  'pending',
  'observed',
  'applied',
  'cancelled',
  'failed',
] as const;

export type MailboxStatus = typeof MAILBOX_STATUSES[number];

/** Valid mailbox apply modes. */
export const MAILBOX_APPLY_MODES = [
  'promote_to_user_message',
  'runtime_instruction',
  'tool_guard',
  'permission_context',
  'interrupt_signal',
  'deferred_to_next_turn',
] as const;

export type MailboxApplyMode = typeof MAILBOX_APPLY_MODES[number];

/** Valid sources for a mailbox row. */
export const MAILBOX_SOURCES = ['ui', 'api', 'system'] as const;
export type MailboxSource = typeof MAILBOX_SOURCES[number];

/** Valid `cancelled_by` values. */
export const MAILBOX_CANCELLED_BY = ['user', 'system', 'agent'] as const;
export type MailboxCancelledBy = typeof MAILBOX_CANCELLED_BY[number];
