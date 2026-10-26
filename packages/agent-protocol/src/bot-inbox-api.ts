/**
 * bot-inbox-api.ts — the durable Bot inbox and dispatch-receipt wire DTOs
 * (framework plan S3a).
 *
 * The personal-agent framework plan (docs/exec-plans/active/
 * 2026-10-25-personal-bot-framework.md, slice S3) moves Bot scheduling out of
 * Desktop main onto a durable inbox. These types are the WIRE shape of that
 * storage contract (design doc §6 and §10): the lifecycle of one accepted
 * input, the claim lease a dispatcher holds, and the dispatch receipt that
 * makes "a run was accepted for this input" recoverable across a crash.
 *
 * ## Lifecycle
 *
 * ```text
 * verified input → inbox accepted → claimed → dispatch recorded → Run accepted
 *                                                               ↓
 *                                        terminal persisted → input settled
 * ```
 *
 * `pending / claimed / dispatched / settled / dead_letter` is the whole
 * vocabulary. Lease expiry never auto-proves a rerun — recovery consults the
 * dispatch receipt first (§6), which is why the receipt is its own durable
 * row keyed by `dispatchKey`.
 *
 * ## Dedup scope
 *
 * The dedup key spans owner, bot, source, binding and sourceEventId, so a
 * channel redelivery can never overwrite another bot's input (§6 invariant
 * 1). The key is computed by the owning store, not transported: clients send
 * the five identity fields and read the composed key back on the view.
 *
 * ## Reserve three-state
 *
 * `reserve` is the idempotent seam the Host's run-acceptance path builds on
 * (§6 invariant 4): the first caller binds `dispatchKey → runId` and gets
 * `fresh`; any later caller gets the ORIGINAL binding — its own candidate
 * runId is discarded — so a retry after a lost response can never start a
 * second run under one dispatch key.
 */

/** Lifecycle of one accepted input, from queueing to a terminal state. */
export type BotInboxStatus =
  | 'pending'
  | 'claimed'
  | 'dispatched'
  | 'settled'
  | 'dead_letter';

/**
 * Scheduling lane. Claim order is `user > agent > background`, then oldest
 * first — the same default precedence the wake scheduler keeps today (§6).
 */
export type BotInboxLane = 'user' | 'agent' | 'background';

/** The persisted state of a dispatch receipt. */
export type BotDispatchState = 'reserved' | 'opened';

export interface BotSchedulerState {
  readonly ownerId: string;
  readonly botId: string;
  readonly mode: 'legacy' | 'host';
  readonly epoch: number;
}

/** Authenticated Host-to-executor claim; never included in client inbox views. */
export interface BotDispatchTicket {
  readonly inboxId: string;
  readonly leaseOwner: string;
  readonly leaseEpoch: number;
  readonly scheduler: BotSchedulerState;
}

/**
 * Client-safe projection of one inbox row.
 *
 * Lease internals (`leaseOwner`, `leaseEpoch`, `deadlineMs`) are
 * scheduler-owned and deliberately absent: they travel to the claimer on a
 * {@link ClaimGrant}, not to every observer of the queue.
 */
export interface BotInboxEntryView {
  readonly id: string;
  readonly ownerId: string;
  readonly botId: string;
  /** Where the input came from — a channel slug, or `legacy` for imports. */
  readonly source: string;
  /** The upstream event identity within `source`. */
  readonly sourceEventId: string;
  readonly bindingId: string | null;
  /** `owner\0bot\0source\0binding\0sourceEventId`, composed by the store. */
  readonly dedupKey: string;
  readonly status: BotInboxStatus;
  /** The verbatim accepted payload, as stored. Views never parse it. */
  readonly payloadJson: string | null;
  /** Delivery attempts so far: incremented by every expiry requeue. */
  readonly attempt: number;
  /** Set once a dispatch receipt has been bound to this input. */
  readonly dispatchKey: string | null;
  readonly lane: BotInboxLane;
  /** Human-readable label for projections; never a synthesized message. */
  readonly title: string | null;
  readonly createdAtMs: number;
  readonly claimedAtMs: number | null;
  readonly dispatchedAtMs: number | null;
  readonly settledAtMs: number | null;
}

/** Command: accept one verified inbound input into the durable inbox. */
export interface AcceptInputCommand {
  readonly ownerId: string;
  readonly botId: string;
  readonly source: string;
  readonly sourceEventId: string;
  /** Channel binding the input arrived on, when the source has one. */
  readonly bindingId?: string | null | undefined;
  readonly lane?: BotInboxLane | undefined;
  /** Verbatim JSON payload, or null when the caller stores a reference. */
  readonly payloadJson?: string | null | undefined;
  readonly title?: string | null | undefined;
}

/** What accepting an input answers. */
export interface AcceptReceipt {
  readonly entry: BotInboxEntryView;
  /**
   * True when this input had already been accepted: the existing row is
   * returned unchanged and no second acceptance identity was created.
   */
  readonly deduplicated: boolean;
}

/**
 * A won claim: the row moved `pending → claimed` under a lease the claimer
 * holds until `deadlineMs` (absolute epoch ms). `leaseEpoch` is the row's
 * monotonic fencing counter — a writer presenting a superseded epoch is from
 * a lease that no longer exists (§6 invariant 3).
 */
export interface ClaimGrant {
  readonly entry: BotInboxEntryView;
  readonly leaseOwner: string;
  readonly leaseEpoch: number;
  readonly deadlineMs: number;
}

/** The durable dispatch receipt: one dispatch key bound to one run. */
export interface DispatchReceipt {
  readonly dispatchKey: string;
  /** The canonical run id this dispatch key is bound to. Never reminted. */
  readonly runId: string;
  /** The inbox input this receipt was landed for, when it has one yet. */
  readonly botInboxId: string | null;
  readonly state: BotDispatchState;
  readonly acceptedAtMs: number;
}

/**
 * What reserving a dispatch key answers — the three states of §6 invariant 4.
 *
 * `fresh`: this call created the binding with the candidate run id.
 * `reserved` / `opened`: the key was ALREADY bound (by an earlier attempt
 * whose response the caller may have lost); the original run id is returned
 * and the caller's candidate is discarded — the caller must dispatch the
 * returned `runId`, never its own.
 */
export type DispatchReserveOutcome =
  | { readonly state: 'fresh'; readonly runId: string; readonly receipt: DispatchReceipt }
  | { readonly state: 'reserved'; readonly runId: string; readonly receipt: DispatchReceipt }
  | { readonly state: 'opened'; readonly runId: string; readonly receipt: DispatchReceipt };
