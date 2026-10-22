/**
 * Typed failures for the workspace layer.
 *
 * Two classes, deliberately separate:
 *   - `CheckoutError` — the checkout itself cannot be created or used.
 *   - `CheckoutOwnerError` — the caller is not allowed to write an otherwise
 *     usable checkout. Callers must be able to tell "this is broken" apart
 *     from "this belongs to someone else" without string matching.
 */

export type CheckoutErrorCode =
  | 'not_a_git_repo'
  | 'no_head'
  | 'invalid_base'
  | 'dirty_worktree'
  | 'worktree_add_failed'
  | 'not_a_checkout'
  | 'worktree_remove_failed'
  | 'resolve_failed';

export class CheckoutError extends Error {
  constructor(
    readonly code: CheckoutErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'CheckoutError';
  }
}

export type CheckoutOwnerErrorCode =
  /** Another session's owner file is already present and takeover was not declared. */
  | 'owner_conflict'
  /** `prove-dead` was declared, but the current owner still has an observable heartbeat. */
  | 'owner_alive'
  /** Owner file exists but does not validate; treating it as "no owner" would allow two writers. */
  | 'owner_unreadable'
  /** `release` was called by a session that does not own the checkout. */
  | 'not_current_owner'
  | 'invalid_session'
  | 'owner_io';

export class CheckoutOwnerError extends Error {
  constructor(
    readonly code: CheckoutOwnerErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'CheckoutOwnerError';
  }
}
