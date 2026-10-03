/**
 * Control Plane — main-process run orchestration (plan 586).
 *
 * NOT a package, on purpose. `03-target-structure.md` §2 and RFC §3.3 both
 * rule out a `control-plane` package until the `wake` ↔ `automation` cycle is
 * unwired: extracting the package now would move the cycle into the new
 * package rather than remove it. So this is a directory under the host, sized
 * to be extracted later without a rename.
 *
 * What lives here is the smallest slice that makes a run a durable fact: it
 * decides what a run is (`manifest-factory`), and it records what happened
 * (`run-store` in the core DB, reached through the dispatcher below).
 */

export { buildRunManifest } from './manifest-factory';
export type { BuiltRun, RunIntent } from './manifest-factory';

export {
  dispatchControlPlaneAction,
  createRun,
  appendRunEvents,
  completeRun,
  getRun,
  getRunEvents,
  listSessionRuns,
  type ControlPlaneRequest,
} from './run-control-plane';

// Plan 587 R2.4: the permission decision path. Exported from the same barrel
// as the run actions because the contract makes them the same kind of thing --
// a decision the Control Plane owns and records, not a message a host forwards.
export {
  PermissionCoordinator,
  type AuditRecord,
  type PermissionDecisionStore,
  type PermissionDeliverer,
  type PermissionGrantStore,
  type PermissionReceipt,
  type PermissionRefusal,
  type ResolveInput,
  type TimerHandle,
} from './permission-coordinator';

export { recordPermissionDecision, type RecordOutcome, type DecisionBridge } from './permission-decision-record';

export {
  acceptedVerbs,
  asProtocolAction,
  bindGrantScope,
  surfaceOrigins,
  translate,
  GRANT_PENDING_TOOL,
  type PermissionSurface,
  type ToolGrantScope,
  type TranslatedDecision,
} from './permission-vocabulary';
