/**
 * Checkout provider contract, v0 (plan 621, appendix A — frozen for slice B).
 *
 * The split this file encodes:
 *   - **Identity** is persisted and can be re-verified: a checkout root, its
 *     owner file, its checkpoint refs.
 *   - **Observation** is always recomputable and may be stale: everything in
 *     `CheckoutObserved`.
 *
 * Nothing in `CheckoutObserved` may be used to decide "can I write here" or
 * "can I delete this". Those decisions read identity only (git registration
 * plus the owner file). A cached observation that leaks into a write or a
 * delete is a contract violation, not an optimisation.
 */

export interface CheckoutRoot {
  /** Linked worktree root, absolute, canonical (junction-resolved real path). */
  root: string;
  /**
   * The cwd callers must actually use = `root` + the directory the source
   * checkout was invoked from. NOT `root` itself.
   *
   * A sub-agent started at `<repo>/packages/host` must land in
   * `<worktree>/packages/host`, otherwise every relative path in the prompt,
   * every tool call and every `tsconfig` rootDir silently refers to a
   * different place. That is why this field exists instead of letting callers
   * join the paths themselves.
   */
  cwd: string;
  /** Repository root the checkout was created from. Never changes. */
  sourceRoot: string;
  /** Directory inside the source repository that `cwd` mirrors. */
  sourceCwd: string;
  /**
   * Base commit pinned at creation time; the start of the detached HEAD.
   *
   * Identity, not observation: a later observation of a different HEAD must
   * not overwrite it, otherwise the ChangeSet loses its `from` boundary.
   */
  baseSha: string;
}

export interface CheckoutOwner {
  /** Session that currently holds write access. The only writer, 1:1. */
  sessionId: string;
  /**
   * When the owner file was last written, in epoch milliseconds.
   *
   * Derived from the file's mtime, so it is evidence for humans and rollout
   * history only. It is deliberately NOT a lease: there is no expiry, and no
   * decision may be made from this number (plan 621, decision D4).
   */
  boundAt: number;
}

/** Observation combination, not an enum: the five dimensions are independent. */
export interface CheckoutObserved {
  /** Git still knows this root as a linked worktree of the source repository. */
  registered: boolean;
  /** Worktree hygiene, worst-first: tracked edits shadow untracked, which shadow ignored. */
  worktree: 'clean' | 'dirty_tracked' | 'untracked' | 'ignored';
  /** Current owner file contents; `unreadable` when the file exists but is malformed. */
  owner: CheckoutOwner | null | 'unreadable';
  /** `git worktree list` marks it locked — an active session holds it. */
  locked: boolean;
  /** Fail-closed reclaim verdict (plan 621 §4.5). */
  reclaim: { ok: true } | { ok: false; reason: CheckoutRetainReason };
  /**
   * Epoch milliseconds when this snapshot was computed.
   *
   * Observation only. Two callers may hold different values for the same
   * checkout, and neither is authoritative: recomputation is the authority.
   * Never persist this as a fact and never compare it to decide staleness —
   * use `isSessionAlive` / `cwdInUse` facts instead.
   */
  observedAt: number;
}

/**
 * Why a checkout must be retained. Every value is a fail-closed reason:
 * seeing one means "do not delete", never "delete after a timeout".
 */
export type CheckoutRetainReason =
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

export interface CheckoutProvider {
  create(input: {
    sourceCwd: string;
    base?: string;
    /**
     * Session that receives write access at creation time. Empty string
     * creates an unowned checkout (used by the legacy sub-agent isolation
     * path, which has no session identity of its own).
     */
    ownerSessionId: string;
    label: string;
  }): Promise<CheckoutRoot>;

  observe(root: string): Promise<CheckoutObserved>;

  /** Reverse-derived from git, never from a registry. Managed checkouts of this repository only. */
  list(sourceCwd: string): Promise<CheckoutRoot[]>;

  /**
   * Write ownership. `takeover` is a required argument, not an optional
   * boolean, so "I forgot to declare why I am taking this" and "I have a
   * reason" cannot be spelled the same way.
   */
  bind(
    root: string,
    sessionId: string,
    takeover: 'fresh' | 'explicit-release' | 'prove-dead',
  ): Promise<void>;

  release(root: string, sessionId: string): Promise<void>;

  /** Write current HEAD to `refs/duya/checkpoint/<session>/<n>` and return the ref name. */
  checkpoint(root: string, sessionId: string): Promise<string>;

  /** The only deletion entry point. Refusal is a normal result, not an exception. */
  reclaim(root: string): Promise<{ removed: true } | { removed: false; reason: CheckoutRetainReason }>;

  /** Write gate at the tool boundary: resolve the checkout from cwd, then compare owners. */
  assertWritable(
    cwd: string,
    sessionId: string,
  ): Promise<{ ok: true; root: string } | { ok: false; reason: 'not_a_checkout' | 'unowned' | 'not_owner' }>;
}
