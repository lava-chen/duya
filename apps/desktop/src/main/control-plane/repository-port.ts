/**
 * repository-port.ts — the ONE port the Control Plane reads and writes through
 * (plan 587 C6.1).
 *
 * ## What a port is for here
 *
 * The Control Plane is the durable decision owner, and this file is the shape of
 * everything it owns. It is an *interface set over storage that already
 * exists*: it adds no table, opens no second connection, and runs no migration
 * of its own. It names the capabilities so that "who owns this fact" has exactly
 * one answer, and so a second writer cannot introduce itself by quietly calling
 * a store directly.
 *
 * ## Why the types are re-exported rather than restated
 *
 * R1.3 hardened `RunStore` and R2.4 built the permission vocabulary. Restating
 * those shapes here would create a second declaration of each, and two
 * declarations of one fact drift the first time a field is added to one of
 * them. So the port names capabilities and ALIASES the owning module's types.
 * Where a capability has no existing type — the checkpoint index and the
 * artefact index are aggregates, not single tables — the port declares it and
 * says which store backs it.
 *
 * ## The five surfaces the plan names
 *
 *  | port                        | backed by (today)                          |
 *  | --------------------------- | ------------------------------------------ |
 *  | {@link RunRepository}       | `RunStore` (`db/core/run-store.ts`)        |
 *  | {@link ArtefactRepository}  | `AttachmentStore`                          |
 *  | {@link ApprovalRepository}  | `PermissionLedger` + `tool_approval_state` |
 *  | {@link GoalTaskRepository}  | `GoalStore` + `TaskStore`                  |
 *  | {@link CheckpointIndexRepository} | `Mailbox` (checkpoint kinds)         |
 *
 * ## `ownership` is load-bearing, and it is plural on purpose
 *
 * The plan's condition is "SQLite implementation REUSES the existing connection
 * and migration owner" — a claim about a whole tree that a comment cannot carry.
 * So ownership is DATA on the implementation.
 *
 * It is an ARRAY, not a single value, because the truthful answer today is two
 * connections, and collapsing that to one to make the type read nicely would
 * hide exactly the finding C6.1 is meant to produce. See
 * `sqlite-repository.ts` for the measured split: the approval surface's durable
 * decision (`tool_approval_state`, the first-wins CAS the bot card and the
 * worker HTTP path both use) lives in the LEGACY `duya-main.db`, while
 * `permission_requests` lives in `duya-core.db`. One decision, two connection
 * owners. That is reported, not routed around.
 */

import type { RunEventEnvelope, RunTerminalState } from '@duya/agent-protocol';

import type {
  AttachmentWithData,
  ClaimBatchInput,
  CoreAttachment,
  CoreTask,
  GoalBudgetDelta,
  GoalCreateInput,
  GoalStatus,
  MailboxClaimBatchResult,
  MailboxItem,
  PermissionRequest,
  PermissionResolveInput,
  RunCreateInput,
  RunEventRow,
  RunOpenOutcome,
  RunRow,
  RunSettleOutcome,
  SessionGoal,
  TaskClaimResult,
  TaskUpdateInput,
} from '../db/core';

// ── ownership ─────────────────────────────────────────────────────────────

/**
 * Who owns the bytes and the schema behind a port implementation.
 *
 * A named union rather than a free string, so that adding an owner is a
 * deliberate act with a reviewer attached to it — the failure this port exists
 * to surface should not be expressible as a typo.
 */
export type ConnectionOwner =
  /** `duya-core.db`, opened by `initCoreDatabase()`. */
  | 'initCoreDatabase'
  /** `duya-main.db`, opened by `initDatabaseFromBoot()`. */
  | 'initDatabaseFromBoot';

export interface RepositoryOwnership {
  /**
   * Every connection this port's implementation writes through, with the
   * aggregates reached on each. More than one entry is a FINDING, and the
   * comment beside each must name why it is still correct.
   */
  readonly connections: readonly {
    readonly owner: ConnectionOwner;
    readonly file: string;
    /** The aggregates reached on this connection. */
    readonly aggregates: readonly string[];
  }[];
  /**
   * The module that owns the schema: the per-aggregate `static migrations`
   * spread by `collectMigrations()` for the core DB, and
   * `ensureToolApprovalTables()` for the legacy one. This port contributes
   * neither.
   */
  readonly migrationOwner: 'collectMigrations';
  /**
   * The process that owns the files. The Control Plane runs in main; the
   * agent-server is a fork and reaches this port over `db:request`, never
   * directly. A second value would mean a second writer.
   */
  readonly executingProcess: 'electron-main';
  /** The tables this port is allowed to touch. */
  readonly tables: readonly string[];
}

// ── runs and the durable transcript ───────────────────────────────────────

/**
 * The run's own row, plus the event stream that is its transcript.
 *
 * `createRun` / `settleRun` return the R1.3 outcome unions verbatim. The port
 * does NOT re-derive them: the CAS and idempotency semantics were hardened in
 * R1.3, and a second copy of that logic is a second answer to "did my write
 * land".
 */
export interface RunRepository {
  createRun(input: RunCreateInput): RunOpenOutcome;
  appendEvents(envelopes: readonly RunEventEnvelope[]): number;
  settleRun(runId: string, terminal: RunTerminalState, metrics?: unknown): RunSettleOutcome;
  getRun(id: string): RunRow | null;
  listRunsBySession(sessionId: string, limit?: number): RunRow[];
  /** The durable transcript, from an exclusive `afterSeq` cursor. */
  listEvents(runId: string, afterSeq?: number, limit?: number): RunEventRow[];
  countEvents(runId: string): number;
  /**
   * Re-derive a run's manifest fingerprint and compare it to the stored digest.
   * `null` when the run has no row. On the port rather than left to whoever
   * notices, because a corrupted run row is otherwise only visible when a
   * reader happens to care.
   */
  verifyManifest(runId: string): { ok: boolean; expected: string; actual: string } | null;
}

// ── transcript and artefacts ──────────────────────────────────────────────

/**
 * Artefacts: the durable, file-backed payload index.
 *
 * Scope note, stated rather than glossed: the RUN-scoped artefact index the
 * plan's phrase "transcript/artifacts" could be read as asking for does not
 * exist. Artefacts are conversation-keyed rows, and a run's association with
 * one is carried by the transcript event that names it, not by an artefact row.
 * So this port exposes the index that exists. Inventing a run-scoped table here
 * would create a second artefact index that nothing writes.
 */
export interface ArtefactRepository {
  getAttachment(id: string): CoreAttachment | null;
  listAttachments(sessionId: string): AttachmentWithData[];
}

// ── approvals ─────────────────────────────────────────────────────────────

/**
 * Permission requests and their durable answers.
 *
 * The two halves genuinely live in different databases today
 * (`permission_requests` in the core DB, the first-wins decision in
 * `tool_approval_state` in the legacy one), so the port declares both rather
 * than pretending one connection serves both. See `sqlite-repository.ts`.
 */
export interface ApprovalRepository {
  // ── core DB: the request ledger ──
  createRequest(input: {
    id: string;
    sessionId?: string | null;
    toolName: string;
    toolInput?: Record<string, unknown> | null;
  }): PermissionRequest;
  getRequest(id: string): PermissionRequest | null;
  resolveRequest(id: string, input: PermissionResolveInput): PermissionRequest | null;
  listPendingRequests(sessionId?: string): PermissionRequest[];

  // ── legacy DB: the decision that actually authorises ──
  /**
   * Record the decision, first-wins.
   *
   * `@returns` `claimed: true` when THIS call is the one that decided it, and
   * the row on record when it was not. First-wins lives here and nowhere else:
   * it is the whole late/duplicate guard.
   */
  resolveDecision(id: string, decision: 'allow' | 'always' | 'deny'): {
    readonly claimed: boolean;
    readonly row: { readonly decision: string | null } | null;
  };
  /** A lasting grant, keyed by a real scope. `always` is not a one-shot. */
  upsertGrantRule(scopeType: 'bot' | 'session', scopeId: string, toolName: string): void;
  listGrantRules(scopeType: 'bot' | 'session', scopeId: string): readonly string[];
}

// ── goals and tasks ───────────────────────────────────────────────────────

/**
 * The durable goal and the task list for a session.
 *
 * `sessionId` is the key on every method, and that is the whole of the C6.1
 * ownership claim: a run does not carry its own copy of either, so there is no
 * second row that could disagree with this one.
 */
export interface GoalTaskRepository {
  createGoal(input: GoalCreateInput): SessionGoal;
  getGoal(sessionId: string): SessionGoal | null;
  applyGoalBudget(sessionId: string, delta: GoalBudgetDelta): SessionGoal | null;
  setGoalStatus(sessionId: string, status: GoalStatus): SessionGoal | null;
  listGoalsByStatus(status: GoalStatus): SessionGoal[];
  getTask(id: string): CoreTask | null;
  listTasks(sessionId: string): CoreTask[];
  updateTask(id: string, input: TaskUpdateInput): CoreTask | null;
  /** First-wins claim. The result carries its own refusal reason. */
  claimTask(id: string, owner: string): TaskClaimResult;
}

// ── the checkpoint index ──────────────────────────────────────────────────

/**
 * The checkpoint index: work a session has queued but not yet applied, keyed by
 * the checkpoint kind it was observed at.
 *
 * This is the durable surface behind the agent-server's in-memory
 * `CheckpointBatcher`. The batcher is a QUEUE, not a record — it holds at most
 * `MAX_BATCH_SIZE` entries and re-enqueues on a failed flush — so what is here
 * is the thing that survives a restart. Named an index and not a log because
 * the mailbox is a pending-work index, and calling it a log would invite an
 * `append` nothing needs.
 *
 * The run-association reads are here rather than invented as a separate
 * structure because the mailbox row ALREADY carries them
 * (`submittedRunId` / `observedByRunId` / `injectedRunId`). C6.1's "record the
 * durable association rather than imply it" is satisfied by a read of the
 * columns that exist.
 */
export interface CheckpointIndexRepository {
  listPending(sessionId: string): MailboxItem[];
  getItem(id: string): MailboxItem | null;
  /** Claim up to `limit` pending items for delivery. */
  claimBatch(input: ClaimBatchInput): MailboxClaimBatchResult;
  /**
   * The run ids durably associated with a session's pending work: which run
   * submitted it, and which run reserved it for injection.
   */
  runAssociations(sessionId: string): readonly {
    readonly id: string;
    readonly submittedRunId: string;
    readonly injectedRunId: string | null;
  }[];
}

// ── the port ──────────────────────────────────────────────────────────────

/**
 * The whole repository, as the Control Plane holds it.
 *
 * A single object so "the Control Plane's durable owner" is one reference a
 * composition root can pass, and so a second implementation of any member is a
 * visible substitution rather than an ambient global lookup.
 */
export interface ControlPlaneRepository {
  readonly ownership: RepositoryOwnership;
  readonly runs: RunRepository;
  readonly artefacts: ArtefactRepository;
  readonly approvals: ApprovalRepository;
  readonly goalsAndTasks: GoalTaskRepository;
  readonly checkpoints: CheckpointIndexRepository;
}
