/**
 * Transport-neutral Execution Checkout observation contract for Duya Host
 * (plan 621, slice B).
 *
 * ## Everything here is an observation, never an identity
 *
 * The authority matrix in the plan (§4.3) splits facts in two. Identity lives
 * in a database row or in a git object and is checked; observation is
 * recomputed on demand and may be stale the moment it is read. Every field in
 * this file is in the second group:
 *
 *   registered / worktree / owner / locked / reclaimable  → git + the owner
 *                                                          file, recomputed
 *   cwd / baseSha / sourceRoot                            → git, recomputed
 *
 * No value returned here may decide "can this session write", "can this
 * checkout be deleted", or "is this the same checkout". Those questions are
 * answered by the Host against the authority (the checkout's own owner file and
 * git registry) at the moment of the action. A client that caches
 * `reclaimable: true` and acts on it later is using an observation as if it
 * were a decision — the one thing this contract exists to prevent.
 *
 * ## Paths are part of the contract here
 *
 * `session-api.ts` deliberately never exposes a Host filesystem path; a client
 * addresses a workspace by ID. A checkout cannot follow that rule: its identity
 * *is* a directory (§4.1, decision D2), so the observation is addressed by the
 * canonical root path and repeats it in the payload. That is why this contract
 * is served by the local Host surface and not by a remote one.
 *
 * ## "No owner" and "cannot read the owner file" are different answers
 *
 * `ownerSessionId: null` with `ownerUnreadable: true` means the Host could not
 * read the checkout's owner file, so it does not know whether anyone owns it.
 * Treating that as "unowned" would hand write access to a second session on a
 * checkout that may be in active use. The two states are therefore separate
 * fields rather than one nullable id, and an unreadable owner is never
 * `reclaimable`.
 */

import type { Millis, SessionId } from './primitives.js';

/**
 * Why a checkout is retained instead of reclaimed (§4.5, fail-closed).
 *
 * Each value names the single condition that refused the deletion. The Host
 * evaluates all of them and reports the first failure; a client must render the
 * reason rather than retrying, because retrying cannot change a dirty tree.
 *
 *   not_registered      — git does not list it as a registered linked worktree,
 *                         or the `.git` file / `gitdir` back-reference disagrees.
 *   unreadable          — the state could not be observed (permissions, I/O).
 *                         Not knowing is a retain reason, never a pass.
 *   dirty_tracked       — `status --porcelain` is not empty.
 *   untracked           — untracked files exist (`ls-files --others`).
 *   ignored             — ignored files exist. They would be deleted silently,
 *                         so they block removal even though git would allow it.
 *   locked              — the worktree carries an active lock.
 *   detached_unreferenced — detached HEAD is not contained by any ref, so the
 *                         commits would be lost with the directory.
 *   reparse_point       — a junction/symlink remains inside the tree (Windows);
 *                         recursive deletion must not follow it.
 *   owner_alive         — the owning session still has a live run or worker.
 *   cwd_inside          — some active run's cwd is inside this checkout.
 */
export type HostCheckoutRetainReason =
  | 'not_registered'
  | 'unreadable'
  | 'dirty_tracked'
  | 'untracked'
  | 'ignored'
  | 'locked'
  | 'detached_unreferenced'
  | 'reparse_point'
  | 'owner_alive'
  | 'cwd_inside';

/**
 * One managed checkout as git currently reports it.
 *
 * `baseSha` is the commit pinned when the checkout was created; it is the start
 * of the ChangeSet and is NOT refreshed from `HEAD`. A newer HEAD is a
 * different question ("what has this session produced"), answered by the
 * checkpoint refs, not by this field.
 */
export interface HostCheckoutRoot {
  /** Linked worktree root, absolute and canonical (junctions resolved). */
  readonly root: string;
  /** What the caller should actually use as cwd: `root` plus the source-relative directory. */
  readonly cwd: string;
  /** The repository checkout this one was created from. */
  readonly sourceRoot: string;
  /** Commit the checkout started from. Observation only; never a re-anchor. */
  readonly baseSha: string;
}

/**
 * The observation combination for one checkout (§4.4).
 *
 * This is deliberately not a single state enum: registration, working-tree
 * cleanliness, ownership, locking and reclaimability vary independently. A
 * caller that wants one label derives it, and the derivation belongs in the UI,
 * not in the authority.
 *
 * Every field is a point-in-time observation. `observedAt` says when it was
 * taken; nothing here may be persisted as identity.
 */
export interface HostCheckoutObserved {
  /** Absolute path as observed. Canonicalisation is the Host's job, not the client's. */
  readonly root: string;
  /**
   * Effective cwd of the checkout. When the Host could only observe the root
   * (no source-relative directory available) this equals `root`; callers that
   * need the session-relative cwd read `listCheckouts()`.
   */
  readonly cwd: string;
  /** Git lists this as a registered linked worktree with matching back-references. */
  readonly registered: boolean;
  /** Working-tree cleanliness, from the most severe condition found. */
  readonly worktree: 'clean' | 'dirty_tracked' | 'untracked' | 'ignored';
  /** Owner recorded in the checkout's git dir, or null when there is none or it is unreadable. */
  readonly ownerSessionId: SessionId | null;
  /**
   * True when the owner file exists but could not be read. Distinguishes
   * "nobody owns this" (false, `ownerSessionId: null`) from "ownership is
   * unknown" (true). An unknown owner is never reclaimable.
   */
  readonly ownerUnreadable: boolean;
  /** An active worktree lock is present. */
  readonly locked: boolean;
  /** The Host's fail-closed verdict. True only when every §4.5 condition passed. */
  readonly reclaimable: boolean;
  /** The first condition that refused reclaim, or null when `reclaimable` is true. */
  readonly retainReason: HostCheckoutRetainReason | null;
  /** When this combination was observed, not when it was cached. */
  readonly observedAt: Millis;
}

/** Which checkout a session currently sits in, and whether it may write there. */
export interface HostSessionCheckoutView {
  readonly sessionId: SessionId;
  /** null means the session is not inside any checkout; it is not an error. */
  readonly checkout: HostCheckoutObserved | null;
  /**
   * True when this session is the recorded owner. Ownership is exclusive, so a
   * false value means read-only for this session by construction (§4.5) — it is
   * not an invitation to re-bind.
   */
  readonly isOwner: boolean;
}

/** Wire contract for checkout observation and reclaim. */
export interface HostCheckoutApiV1 {
  /** Observe the checkout the given session sits in, reusing no cached state. */
  observeForSession(sessionId: SessionId): Promise<HostSessionCheckoutView>;

  /** Observe one checkout by root path. */
  observeCheckout(root: string): Promise<HostCheckoutObserved>;

  /** Enumerate managed checkouts of the repository at `sourceCwd`, derived from git. */
  listCheckouts(sourceCwd: string): Promise<readonly HostCheckoutRoot[]>;

  /**
   * Ask the Host to remove one checkout.
   *
   * A refusal is a normal result, not an error: `removed: false` with the
   * retaining reason is the answer to "may this be deleted", and no deletion
   * happened. Only transport or I/O failures reject.
   */
  requestReclaim(
    root: string,
  ): Promise<
    | { readonly removed: true }
    | { readonly removed: false; readonly reason: HostCheckoutRetainReason }
  >;
}
