/**
 * sqlite-repository.ts — the SQLite implementation of the Control Plane
 * repository port (plan 587 C6.1).
 *
 * ## It is a binding, not a second database
 *
 * Synchronous repository methods delegate only to the CoreStores the host
 * already opened for `duya-core.db`. Approval capabilities are async Host API
 * clients. This file executes no DDL, runs no migration, and constructs no
 * `Database`.
 *
 * `ownership` is the assertion a reader can make instead of taking that on
 * trust, and {@link bindCoreStores} takes the stores as a PARAMETER so a test
 * can bind a fixture and prove the adapter adds no connection of its own.
 *
 * ## Approval storage is a Host API dependency
 *
 * Permission request rows and approval-card rows have separate schemas, but
 * this repository no longer opens or reaches either storage surface. It is
 * given the asynchronous Host APIs at composition time, so the repository
 * cannot accidentally fall back to a Main-process SQLite handle when the
 * Host transport becomes process-remote.
 */

import type { CoreStores } from '../db/core-connection';
import type {
  ApprovalRepository,
  ArtefactRepository,
  CheckpointIndexRepository,
  ConnectionOwner,
  ControlPlaneRepository,
  GoalTaskRepository,
  RepositoryOwnership,
  RunRepository,
} from '@duya/host/repository-port';
import type { HostPermissionRequestApiV1, HostToolApprovalApiV1 } from '@duya/agent-protocol';

// ── ownership ─────────────────────────────────────────────────────────────

export const CORE_OWNERSHIP: RepositoryOwnership = {
  connections: [
    {
      owner: 'initCoreDatabase',
      file: 'duya-core.db',
      aggregates: ['RunStore', 'AttachmentStore', 'GoalStore', 'TaskStore', 'Mailbox'],
    },
  ],
  migrationOwner: 'collectMigrations',
  executingProcess: 'electron-main',
  tables: [
    'runs',
    'run_events',
    'attachments',
    'session_goals',
    'tasks',
    'mailbox',
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
  'runs' | 'attachments' | 'goals' | 'tasks' | 'mailbox'
>;

/**
 * Bind the port to stores the host already opened.
 *
 * Takes the stores as an argument rather than reaching for the singleton, which
 * is what lets {@link createControlPlaneRepository} be exercised against a
 * fixture without opening a database.
 */
function bindCoreStores(
  stores: CoreStoreAggregates,
  permissionRequests: HostPermissionRequestApiV1,
  toolApprovals: HostToolApprovalApiV1,
): ControlPlaneRepository {
  const runs: RunRepository = {
    createRun: (input) => stores.runs.createRun(input),
    // The attempt is forwarded, never re-derived: this binding's whole job is
    // to reach the store Desktop already opened, and a fence re-computed here
    // would be a second answer to "which attempt is writing".
    appendEvents: (envelopes, epoch) => stores.runs.appendEvents(envelopes, epoch),
    settleRun: (runId, terminal, metrics, epoch) => stores.runs.settleRun(runId, terminal, metrics, epoch),
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
    createRequest: (input) => permissionRequests.createPermissionRequest(input),
    getRequest: (id) => permissionRequests.getPermissionRequest(id),
    resolveRequest: (id, input) => permissionRequests.resolvePermissionRequest(id, input),
    listPendingRequests: (sessionId) => permissionRequests.listPendingPermissionRequests(sessionId),
    resolveDecision: async (id, decision) => {
      const result = await toolApprovals.resolveToolApproval(id, decision);
      return {
        claimed: result?.claimed ?? false,
        row: result ? { decision: result.row.decision } : null,
      };
    },
    upsertGrantRule: (scopeType, scopeId, toolName) =>
      toolApprovals.upsertToolApprovalRule({ scopeType, scopeId, toolName }),
    listGrantRules: (scopeType, scopeId) => toolApprovals.listToolApprovalRules({ scopeType, scopeId }),
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
  /** Host-owned approval APIs. Storage remains behind the async boundary. */
  readonly permissionRequests: HostPermissionRequestApiV1;
  readonly toolApprovals: HostToolApprovalApiV1;
}

export function createControlPlaneRepository(options: CreateRepositoryOptions): ControlPlaneRepository {
  if (bound !== null) return bound;
  if (options.stores === null || options.stores === undefined) {
    throw new Error(
      'Control Plane repository needs the core aggregates: createControlPlaneRepository() must be called after initCoreDatabase()',
    );
  }
  bound = bindCoreStores(options.stores, options.permissionRequests, options.toolApprovals);
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
