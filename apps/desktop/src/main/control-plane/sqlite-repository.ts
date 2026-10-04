/**
 * sqlite-repository.ts — the SQLite implementation of the Control Plane
 * repository port (plan 587 C6.1).
 *
 * ## It is a binding, not a second database
 *
 * Every method below is a delegation to a store the host ALREADY opened:
 * `getCoreStores()` for `duya-core.db` and `getDatabase()` for the legacy
 * `duya-main.db`. This file executes no DDL, runs no migration, and constructs
 * no `Database`. If it had, the port would have created a second owner for a
 * fact the host already owns — which is the defect the port exists to prevent,
 * not a design choice available to it.
 *
 * `ownership` is the assertion a reader can make instead of taking that on
 * trust, and {@link bindCoreStores} takes the stores as a PARAMETER so a test
 * can bind a fixture and prove the adapter adds no connection of its own.
 *
 * ## Why the approval surface spans two connections (the finding)
 *
 * The plan's condition is one implementation reusing THE existing connection and
 * migration owner. Measured, the approval half does not fit that sentence:
 *
 *  - the request LEDGER (`permission_requests`) is a core-DB aggregate, owned
 *    by `PermissionLedger`'s migration id=6;
 *  - the decision that actually AUTHORISES is `tool_approval_state`, whose
 *    first-wins CAS (`resolveToolApproval`) is the function both the bot card and
 *    R2.4's `recordPermissionDecision` go through — and that table is created by
 *    `ensureToolApprovalTables()` on the LEGACY connection.
 *
 * So one authorisation fact is durably owned by two different files with two
 * different migration owners, reachable through one bridge action each
 * (`permission:resolve` and `toolApproval:resolve`, `agents/db-bridge.ts:1357`
 * and `:917`). That is reported as the finding it is. It is NOT papered over by
 * opening a third connection or by pretending the ledger is the authority, and
 * it is not "fixed" here because moving `tool_approval_state` onto the core DB
 * is a schema migration of a live table — a different slice with its own
 * acceptance, and the one place where doing it quietly would be worst.
 */

import {
  listToolApprovalRules,
  resolveToolApproval,
  upsertToolApprovalRule,
} from '../db/toolApprovalState';
import type { CoreStores } from '../db/core-connection';
import { getLogger, LogComponent } from '../logging/logger';
import type {
  ApprovalRepository,
  ArtefactRepository,
  CheckpointIndexRepository,
  ConnectionOwner,
  ControlPlaneRepository,
  GoalTaskRepository,
  RepositoryOwnership,
  RunRepository,
} from './repository-port';

/**
 * The legacy connection's type, without importing `db/connection`.
 *
 * `db/connection.ts` imports `electron` (for `app.getPath`), so importing it
 * here would make the Control Plane repository unloadable without an Electron
 * runtime — and therefore untestable. The ACCESSOR is injected by composition
 * instead, which is where that import already lives. The port gains a
 * dependency-injection seam; it does not gain a dependency.
 */
export type LegacyDatabaseHandle = Parameters<typeof resolveToolApproval>[0];

/** Reads the legacy connection, or `null` when it is not open. */
export type LegacyDatabaseAccessor = () => LegacyDatabaseHandle | null;

// ── ownership ─────────────────────────────────────────────────────────────

export const CORE_OWNERSHIP: RepositoryOwnership = {
  connections: [
    {
      owner: 'initCoreDatabase',
      file: 'duya-core.db',
      aggregates: ['RunStore', 'AttachmentStore', 'PermissionLedger', 'GoalStore', 'TaskStore', 'Mailbox'],
    },
    {
      // The finding, not a preference: the first-wins authorisation CAS lives
      // here while its request ledger lives on the connection above.
      owner: 'initDatabaseFromBoot',
      file: 'duya-main.db',
      aggregates: ['tool_approval_state', 'tool_approval_rules'],
    },
  ],
  migrationOwner: 'collectMigrations',
  executingProcess: 'electron-main',
  tables: [
    'runs',
    'run_events',
    'attachments',
    'permission_requests',
    'session_goals',
    'tasks',
    'mailbox',
    'tool_approval_state',
    'tool_approval_rules',
  ],
};

/** The connection owners a given binding actually reached. Measured, not declared. */
export function connectionOwners(ownership: RepositoryOwnership): readonly ConnectionOwner[] {
  return ownership.connections.map((c) => c.owner);
}

// ── the binding ───────────────────────────────────────────────────────────

/**
 * The aggregates the port actually reaches.
 *
 * A `Pick` rather than the whole `CoreStores`, so a test can bind real stores
 * over a temporary database without constructing eleven unrelated aggregates —
 * and so adding an aggregate to `CoreStores` does not silently become a
 * Control Plane dependency.
 */
export type CoreStoreAggregates = Pick<
  CoreStores,
  'runs' | 'attachments' | 'permissions' | 'goals' | 'tasks' | 'mailbox'
>;

/**
 * Bind the port to stores the host already opened.
 *
 * Takes the stores as an argument rather than reaching for the singleton, which
 * is what lets {@link createControlPlaneRepository} be exercised against a
 * fixture without opening a database.
 */
function bindCoreStores(stores: CoreStoreAggregates, legacyDatabase: LegacyDatabaseAccessor): ControlPlaneRepository {
  const runs: RunRepository = {
    createRun: (input) => stores.runs.createRun(input),
    appendEvents: (envelopes) => stores.runs.appendEvents(envelopes),
    settleRun: (runId, terminal, metrics) => stores.runs.settleRun(runId, terminal, metrics),
    getRun: (id) => stores.runs.getRun(id),
    listRunsBySession: (sessionId, limit) => stores.runs.listRunsBySession(sessionId, limit),
    listEvents: (runId, afterSeq, limit) => stores.runs.listEvents(runId, afterSeq, limit),
    countEvents: (runId) => stores.runs.countEvents(runId),
    verifyManifest: (runId) => stores.runs.verifyManifest(runId),
  };

  const artefacts: ArtefactRepository = {
    getAttachment: (id) => stores.attachments.get(id),
    listAttachments: (sessionId) => stores.attachments.getForSession(sessionId),
  };

  const approvals: ApprovalRepository = {
    createRequest: (input) => stores.permissions.create(input),
    getRequest: (id) => stores.permissions.get(id),
    resolveRequest: (id, input) => stores.permissions.resolve(id, input),
    listPendingRequests: (sessionId) =>
      sessionId === undefined ? stores.permissions.listPending() : stores.permissions.listPending(sessionId),

    // The legacy half. Resolved per call because the legacy connection is
    // opened by a different boot step than the core one, so binding it once at
    // composition time would capture "not open yet" for the life of the process.
    resolveDecision: (id, decision) => {
      const db = legacyDatabase();
      if (!db) {
        getLogger().warn('Approval decision refused: the legacy database is not open', {}, LogComponent.DB);
        return { claimed: false, row: null };
      }
      const outcome = resolveToolApproval(db, id, decision);
      // `undefined` is "no such request", which is NOT the same as "already
      // decided". Both refuse to execute, and the caller must be able to tell
      // them apart: the first is a stale id, the second is a duplicate answer
      // to a question that was already answered.
      if (outcome === undefined) return { claimed: false, row: null };
      return { claimed: outcome.claimed, row: { decision: outcome.row.decision ?? null } };
    },
    upsertGrantRule: (scopeType, scopeId, toolName) => {
      const db = legacyDatabase();
      if (!db) {
        getLogger().warn('Approval grant refused: the legacy database is not open', { scopeType }, LogComponent.DB);
        return;
      }
      upsertToolApprovalRule(db, scopeType, scopeId, toolName);
    },
    listGrantRules: (scopeType, scopeId) => {
      const db = legacyDatabase();
      if (!db) return [];
      return listToolApprovalRules(db, scopeType, scopeId);
    },
  };

  const goalsAndTasks: GoalTaskRepository = {
    createGoal: (input) => stores.goals.create(input),
    getGoal: (sessionId) => stores.goals.get(sessionId),
    applyGoalBudget: (sessionId, delta) => stores.goals.updateBudget(sessionId, delta),
    setGoalStatus: (sessionId, status) => stores.goals.setStatus(sessionId, status),
    listGoalsByStatus: (status) => stores.goals.listByStatus(status),
    getTask: (id) => stores.tasks.get(id),
    listTasks: (sessionId) => stores.tasks.getBySession(sessionId),
    updateTask: (id, input) => stores.tasks.update(id, input),
    claimTask: (id, owner) => stores.tasks.claim(id, owner),
  };

  const checkpoints: CheckpointIndexRepository = {
    listPending: (sessionId) => stores.mailbox.list(sessionId, { status: ['pending'] }),
    getItem: (id) => stores.mailbox.get(id),
    claimBatch: (input) => stores.mailbox.claimBatch(input),
    runAssociations: (sessionId) =>
      stores.mailbox
        .listForSession(sessionId)
        .map((item) => ({
          id: item.id,
          submittedRunId: item.submittedRunId,
          injectedRunId: item.injectedRunId,
        })),
  };

  return { ownership: CORE_OWNERSHIP, runs, artefacts, approvals, goalsAndTasks, checkpoints };
}

/**
 * The process-wide repository, created by the composition root.
 *
 * `null` before composition runs, which is a state a caller must handle rather
 * than something to paper over: a Control Plane action that arrives before
 * `initCoreDatabase()` has no owner to write through, and inventing one by
 * opening the file here is exactly the second owner this port forbids.
 */
let bound: ControlPlaneRepository | null = null;

/**
 * Create the Control Plane's repository over the connections the host opened.
 *
 * Called once, from composition (`main/index.ts`, right after
 * `initCoreDatabase`). Idempotent: a second call returns the first binding
 * rather than producing a second object over the same stores, because two
 * bindings of one port is how "which repository?" becomes answerable two ways.
 */
export interface CreateRepositoryOptions {
  /**
   * The core aggregates, supplied by composition.
   *
   * Required rather than defaulted to `getCoreStoresOrNull()`: reaching for the
   * singleton would import `db/core-connection`, which imports `db/connection`,
   * which imports `electron`. The port then could not be constructed — and so
   * not tested — without an Electron runtime. Passing the stores in makes the
   * dependency direction explicit (composition knows everything; the port knows
   * nothing) and costs one argument at one call site.
   */
  readonly stores: CoreStoreAggregates;
  /**
   * Reads the legacy `duya-main.db` handle, or `null` when it is not open.
   *
   * Injected for the same reason: `db/connection` imports `electron`.
   * Composition passes `getDatabase` — the same handle every other legacy
   * caller uses, so no second connection is created.
   */
  readonly legacyDatabase: LegacyDatabaseAccessor;
}

export function createControlPlaneRepository(options: CreateRepositoryOptions): ControlPlaneRepository {
  if (bound !== null) return bound;
  if (options.stores === null || options.stores === undefined) {
    throw new Error(
      'Control Plane repository needs the core aggregates: createControlPlaneRepository() must be called after initCoreDatabase()',
    );
  }
  bound = bindCoreStores(options.stores, options.legacyDatabase);
  return bound;
}

/** The bound repository, or `null` when composition has not run. */
export function getControlPlaneRepository(): ControlPlaneRepository | null {
  return bound;
}

/**
 * Forget the binding.
 *
 * Test-only, mirroring `db/core-connection.ts`'s own `_setCoreStoresForTesting`.
 * Present because a process-wide binding that cannot be reset is a binding that
 * cannot be tested twice, which is how a suite starts passing for the wrong
 * reason.
 */
export function _resetControlPlaneRepositoryForTesting(): void {
  bound = null;
}
