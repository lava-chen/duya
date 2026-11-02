/**
 * The Host's admission adapter for the Runtime Session service.
 *
 * ## What this file is
 *
 * The one place where the Host answers the Runtime's "may this turn start?"
 * question. The Runtime asks; the Host decides — and the answer carries
 * enough detail that the caller does not have to guess what to do next.
 *
 * ## Why the Host owns this and not the Runtime
 *
 * The Host is the only layer that can see the installed capabilities, the
 * resolved workspace, the persisted session row and the authenticated caller.
 * An admission decision needs all four. The Runtime builds the frozen
 * manifest and the durable receipt, so a Runtime-side admission would be a
 * decision made from a subset of what the Host knows — and the run row would
 * describe a run that could not be reconstructed from itself.
 *
 * ## The direction is one-way
 *
 * The adapter calls the Control Plane's atomic operations directly. It must
 * NOT call a public start entry that forwards back into the Runtime service:
 * that is a recursion, and it is the failure mode the R1 plan names
 * explicitly. The Runtime asks, the Host decides.
 *
 * ## Why the stage is not a boolean
 *
 * The Host's wire vocabulary used to collapse five internal failure modes
 * into one stage, and the collapsed bucket mixed three situations that need
 * different next steps: "the session is busy" (wait), "this exact run already
 * exists" (reconcile against the receipt) and "the run row was never written"
 * (retry, and alert). This adapter is where that collapse is undone, so the
 * distinction survives the trip from the Control Plane to the caller.
 *
 * The mapping is a TABLE rather than a chain of conditionals because the
 * mapping is the contract: every internal stage appears exactly once, and a
 * new internal stage that nobody classified fails the type check below rather
 * than silently joining the bucket it looks most like.
 */

import type {
  SessionAdmissionOutcome,
  SessionAdmissionStage,
  SessionRunIdentity,
} from '@duya/agent-runtime/session';
import {
  createRuntimeSessionService,
  type RuntimeSessionService,
} from '@duya/agent-runtime/session';
import type { RunStartAcceptance, RunStartStage } from '@duya/agent-runtime';
import type { RunId, StartAgentRunResult, StartAgentRunStage } from '@duya/agent-protocol';
import type { RunDispatchAdmission, RunTurnIntent } from './run-orchestrator.js';

/**
 * How one internal Control Plane stage maps onto the session vocabulary.
 *
 * `rejected` means "the same request will be refused the same way" and
 * `failed` means "retrying is meaningful". The stage says WHICH.
 *
 * ## Why `run_already_exists` is `rejected` and not `admitted`
 *
 * The run exists and is correct, but this call did not admit a run — it
 * declined to dispatch a SECOND execution onto it. Reporting it as admitted
 * would tell the caller "your turn is running" when what actually happened is
 * "your turn was already running, and here is its id". The stage
 * `run_already_exists` is what lets the caller reconcile against the receipt
 * instead of either retrying or reporting an error.
 */
const STAGE_CLASSIFICATION: {
  readonly [K in RunStartStage]: {
    readonly state: 'rejected' | 'failed';
    readonly stage: SessionAdmissionStage;
  };
} = {
  // The session is busy. The refusal is a property of the session's state,
  // so the caller waits rather than retries.
  run_active: { state: 'rejected', stage: 'session_busy' },
  // The run already exists with the same manifest and input. Reconcile.
  run_already_exists: { state: 'rejected', stage: 'run_already_exists' },
  // The Control Plane would not create the row. A durability problem:
  // retrying is meaningful and an operator should be told.
  run_not_created: { state: 'failed', stage: 'run_not_created' },
  // The row exists but `run.started` never landed. Transient storage.
  started_not_durable: { state: 'failed', stage: 'not_durable' },
  // The executor was not there. Retrying after one spawns is the fix.
  dispatch_refused: { state: 'failed', stage: 'dispatch_refused' },
  // The dispatch itself threw. A Host bug rather than a state.
  dispatch_threw: { state: 'failed', stage: 'dispatch_failed' },
  // The Host's own plumbing failed before anything could be attributed.
  unknown: { state: 'failed', stage: 'unknown' },
};

/**
 * The refusal stages a start can end at.
 *
 * `StartAgentRunStage` also carries the two SUCCESS stages (`created` and
 * `dispatched`), and a refusal is not one of those — so the wire stage for a
 * refusal is this narrower union.
 */
export type StartAgentRunRefusalStage = Exclude<StartAgentRunStage, 'created' | 'dispatched'>;

/**
 * How one session stage maps onto the wire stage.
 *
 * This is the SECOND collapse, and it is the one the R1.0 audit named as C1.
 * It used to map five internal stages onto two wire stages, which made
 * "wait", "reconcile" and "retry and alert" the same answer.
 *
 * The fine stages are now wire stages of their own, so this table no longer
 * has to choose between them. What it does have to do is keep the two
 * coarse stages meaningful: `refused_run_open_failed` is the honest answer
 * for the cases with no finer one, and `refused_dispatch_failed` stays the
 * answer for "the executor was not there" because that is the case a
 * transport-level caller has always retried.
 */
const WIRE_STAGE_BY_SESSION_STAGE: {
  readonly [K in SessionAdmissionStage]: StartAgentRunRefusalStage;
} = {
  no_session: 'refused_no_session',
  invalid_input: 'refused_invalid_input',
  session_busy: 'refused_session_busy',
  run_already_exists: 'refused_run_already_exists',
  run_not_created: 'refused_run_not_created',
  not_durable: 'refused_run_not_durable',
  dispatch_refused: 'refused_dispatch_failed',
  dispatch_failed: 'refused_dispatch_threw',
  unknown: 'refused_run_open_failed',
};

/**
 * The wire stage for one session stage.
 *
 * Exported because the mapping is worth testing on its own: it is the place
 * where the five-way collapse used to happen, and a test that only
 * exercised it through a live run would not notice a stage being
 * reclassified.
 */
export function admissionWireStage(stage: SessionAdmissionStage): StartAgentRunRefusalStage {
  return WIRE_STAGE_BY_SESSION_STAGE[stage];
}

/** Project a refused or failed admission onto the Host's wire result. */
export function toStartAgentRunRefusal(
  outcome: Extract<SessionAdmissionOutcome, { readonly state: 'rejected' | 'failed' }>,
): Extract<StartAgentRunResult, { readonly accepted: false }> {
  return {
    accepted: false,
    stage: admissionWireStage(outcome.stage),
    reason: outcome.reason,
    ...(outcome.runId === undefined ? {} : { runId: outcome.runId as RunId }),
  };
}

/**
 * Turn a Control Plane acceptance into the session vocabulary.
 *
 * Exported for the same reason the wire mapping is: the classification is
 * the contract, and it deserves a test that does not need a live run to
 * notice a stage being reclassified.
 */
export function classifyRunStartAcceptance(
  acceptance: RunStartAcceptance,
): SessionAdmissionOutcome {
  if (acceptance.accepted) {
    const identity: SessionRunIdentity = {
      runId: acceptance.runId,
      manifestHash: acceptance.manifestHash,
    };
    return { state: 'admitted', identity };
  }
  const classified = STAGE_CLASSIFICATION[acceptance.stage];
  // The run id travels with a refusal that NAMED one. `run_already_exists`
  // is the case that needs it: the run is recorded and correct, and the
  // caller's next step is to reconcile against that receipt rather than
  // start a second one. A refusal that minted an id and then abandoned it
  // reports no id, so the field is optional rather than always null.
  return {
    state: classified.state,
    stage: classified.stage,
    reason: acceptance.reason,
    ...(acceptance.runId === null ? {} : { runId: acceptance.runId }),
  };
}

/**
 * The Runtime Session service, as the Host hands it to a caller.
 *
 * ## Why the type is re-exported here
 *
 * A Desktop that wants to hold the service needs its TYPE, and the type
 * lives in the Runtime. Re-exporting it from this module means the Desktop
 * reaches for `@duya/host/session-admission` — which it already depends on —
 * rather than adding a direct dependency on `@duya/agent-runtime` for one
 * type.
 *
 * The re-export is an alias, not a wrapper: the value is the Runtime's own
 * type, so a change to the Runtime's service shape shows up here.
 */
export type { RuntimeSessionService } from '@duya/agent-runtime/session';

/**
 * What the adapter needs from the Host to make a decision.
 *
 * Narrow on purpose: the adapter is the trusted boundary, and a port that
 * handed it the whole Host would put the Host's authority back into the
 * Runtime's reach.
 */
export interface HostSessionAdmissionPorts<Request> {
  /**
   * Ask the Control Plane to open a run and dispatch the turn.
   *
   * The adapter calls THIS, never a public start entry. The recursion rule
   * is written on the port so a caller reading the type sees it.
   */
  readonly openRun: (request: Request) => Promise<RunStartAcceptance>;
}

/**
 * Assemble the Host's admission adapter.
 *
 * The adapter holds no state. A session's state lives in the Host's stores
 * and in the Run ledger the Host owns; an adapter that cached either would
 * become a second authority the first time a Host and the adapter disagreed.
 */
export function createHostSessionAdmission<Request>(
  ports: HostSessionAdmissionPorts<Request>,
): { readonly admit: (request: Request) => Promise<SessionAdmissionOutcome> } {
  return {
    async admit(request) {
      const acceptance = await ports.openRun(request);
      return classifyRunStartAcceptance(acceptance);
    },
  };
}

/**
 * The Control Plane the adapter opens runs through.
 *
 * ## Why the adapter takes the orchestrator and not a function
 *
 * A port that took an `openRun` FUNCTION would have to be filled in by the
 * caller, and the caller would have to NAME the Control Plane's start entry
 * to fill it in. A file that names it is a file that can call it, and
 * calling it directly is how the second admission path appeared in the first
 * place.
 *
 * So the wiring lives here. A caller hands over the orchestrator and the
 * request shape, and this module does the one call that must be made.
 */
export interface HostRunControlPlane {
  /**
   * Open a run and dispatch the turn.
   *
   * The adapter calls this. A caller that wants to start a turn does NOT
   * call it — it goes through the session service, which asks the adapter,
   * which calls it. That is the whole direction of the migration.
   */
  readonly openRun: (
    sessionId: string,
    intent: RunTurnIntent,
    admission?: RunDispatchAdmission,
  ) => Promise<RunStartAcceptance>;
}

/**
 * What the adapter asks the Control Plane to open.
 *
 * Mirrors the Host's own start request, and is deliberately separate from it:
 * the adapter's request says what to open, and the Host's request says what
 * the CALLER asked for. The adapter is downstream of the Host's resolution,
 * so it carries the resolved turn.
 */
export interface HostAdmissionTurn {
  readonly sessionId: string;
  readonly intent: RunTurnIntent;
  readonly admission?: RunDispatchAdmission;
}

/**
 * Assemble the adapter AND the Runtime service that uses it.
 *
 * The two are assembled together on purpose: the service forwards to the
 * adapter, and a caller that had to wire them separately could wire them
 * wrong — pointing the service at something other than the adapter, which
 * is how the recursion the plan warns about would be reintroduced.
 */
export function createHostSessionService<Request extends HostAdmissionTurn>(options: {
  readonly controlPlane: HostRunControlPlane;
}): RuntimeSessionService<Request> {
  const admission = createHostSessionAdmission<Request>({
    openRun: async (request) => await options.controlPlane.openRun(
      request.sessionId,
      request.intent,
      request.admission,
    ),
  });
  return createRuntimeSessionService<Request>({ admission });
}
