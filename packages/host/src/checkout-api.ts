/**
 * Host-side implementation of `HostCheckoutApiV1` (plan 621, slice B).
 *
 * ## Why a port instead of an import
 *
 * The real implementation is A's `CheckoutProvider` (`packages/host/src/workspace/`,
 * appendix A of the plan). B ships before A, so this module depends on the
 * *shape* it needs and nothing else. A's `observe` / `list` / `reclaim` satisfy
 * {@link CheckoutObservationPort} structurally, so wiring is one object literal
 * with no adapter layer and no second source of truth.
 *
 * ## What this module does not decide
 *
 * Reclaimability is A's fail-closed verdict, computed against git and the owner
 * file. This module only renames that verdict into the wire DTO: it never
 * re-derives `reclaimable` from `dirty`/`locked`/`owner`, because a second
 * implementation of §4.5 would drift from the one that actually deletes
 * directories.
 *
 * ## Missing collaborators are errors, not empty answers
 *
 * A Host composed without a checkout port cannot observe anything. Returning
 * "no checkout" would be indistinguishable from "this session is not in a
 * checkout" and would let a client treat an unsupported Host as a supported
 * one. Both gaps therefore throw a typed error the HTTP layer renders as a
 * refusal.
 */

import type {
  HostCheckoutApiV1,
  HostCheckoutObserved,
  HostCheckoutRetainReason,
  HostCheckoutRoot,
  SessionId,
} from '@duya/agent-protocol';

/** One observation as the provider reports it (§4.4 dimensions, plus the verdict). */
export interface CheckoutObservation {
  readonly registered: boolean;
  readonly worktree: 'clean' | 'dirty_tracked' | 'untracked' | 'ignored';
  /** `'unreadable'` is distinct from `null` on purpose: unknown is not unowned. */
  readonly owner: { readonly sessionId: string } | null | 'unreadable';
  readonly locked: boolean;
  readonly reclaim: { readonly ok: true } | { readonly ok: false; readonly reason: HostCheckoutRetainReason };
  readonly observedAt: number;
}

/**
 * The narrow slice of the provider this API needs.
 *
 * A's `CheckoutProvider` satisfies this structurally; nothing here is a
 * parallel implementation of it.
 */
export interface CheckoutObservationPort {
  observe(root: string): Promise<CheckoutObservation>;
  list(sourceCwd: string): Promise<readonly { readonly root: string; readonly cwd: string; readonly sourceRoot: string; readonly baseSha: string }[]>;
  reclaim(root: string): Promise<{ removed: true } | { removed: false; reason: HostCheckoutRetainReason }>;
}

export type HostCheckoutApiErrorCode =
  | 'checkout_observation_unavailable'
  | 'checkout_session_resolver_unavailable'
  | 'invalid_checkout_query';

/** A refusal the HTTP layer can render without guessing a status. */
export class HostCheckoutApiError extends Error {
  readonly code: HostCheckoutApiErrorCode;
  readonly status: number;

  constructor(code: HostCheckoutApiErrorCode, message: string, status = 503) {
    super(message);
    this.name = 'HostCheckoutApiError';
    this.code = code;
    this.status = status;
  }
}

export interface CreateHostCheckoutApiOptions {
  /** A's provider. Absent on a Host that never observed a checkout. */
  readonly port?: CheckoutObservationPort;
  /**
   * Session → checkout root resolution (plan 621 slice D). Returns `null` when
   * the session is not inside any checkout; that is a normal answer.
   */
  readonly resolveSessionCheckoutRoot?: (sessionId: SessionId) => Promise<string | null>;
}

export function createHostCheckoutApi(options: CreateHostCheckoutApiOptions): HostCheckoutApiV1 {
  function requirePort(): CheckoutObservationPort {
    if (options.port === undefined) {
      throw new HostCheckoutApiError(
        'checkout_observation_unavailable',
        'This Host has no checkout provider, so checkouts cannot be observed.',
      );
    }
    return options.port;
  }

  return {
    async observeForSession(sessionId) {
      const port = requirePort();
      if (options.resolveSessionCheckoutRoot === undefined) {
        throw new HostCheckoutApiError(
          'checkout_session_resolver_unavailable',
          'This Host cannot resolve a session to a checkout.',
        );
      }
      requireNonEmpty(sessionId, 'sessionId');
      const root = await options.resolveSessionCheckoutRoot(sessionId);
      if (root === null) return { sessionId, checkout: null, isOwner: false };
      const checkout = toObserved(root, await port.observe(root));
      // Ownership is exclusive, so a session that is not the owner is read-only
      // by construction (§4.5) — this flag reports the fact, it never grants.
      return { sessionId, checkout, isOwner: checkout.ownerSessionId === sessionId };
    },

    async observeCheckout(root) {
      requireNonEmpty(root, 'root');
      return toObserved(root, await requirePort().observe(root));
    },

    async listCheckouts(sourceCwd) {
      requireNonEmpty(sourceCwd, 'sourceCwd');
      const roots = await requirePort().list(sourceCwd);
      return roots.map(
        (entry): HostCheckoutRoot => ({
          root: entry.root,
          cwd: entry.cwd,
          sourceRoot: entry.sourceRoot,
          baseSha: entry.baseSha,
        }),
      );
    },

    async requestReclaim(root) {
      requireNonEmpty(root, 'root');
      // A refusal is the answer to "may this be deleted", not a failure.
      return await requirePort().reclaim(root);
    },
  };
}

/**
 * Rename the provider's observation into the wire DTO.
 *
 * `cwd` is echoed as the observed root: A's `observe` does not report the
 * source-relative working directory, so claiming one here would be invention.
 * Callers that need it read `listCheckouts()`, which returns A's `CheckoutRoot`.
 */
function toObserved(root: string, observation: CheckoutObservation): HostCheckoutObserved {
  const owner = observation.owner;
  const ownerUnreadable = owner === 'unreadable';
  return {
    root,
    cwd: root,
    registered: observation.registered,
    worktree: observation.worktree,
    ownerSessionId: owner === null || ownerUnreadable ? null : owner.sessionId,
    ownerUnreadable,
    locked: observation.locked,
    reclaimable: observation.reclaim.ok,
    retainReason: observation.reclaim.ok ? null : observation.reclaim.reason,
    observedAt: observation.observedAt,
  };
}

function requireNonEmpty(value: string, field: string): void {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new HostCheckoutApiError('invalid_checkout_query', `${field} must be a non-empty string`, 400);
  }
}
