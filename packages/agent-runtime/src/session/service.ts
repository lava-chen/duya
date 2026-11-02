/**
 * The Runtime Session service.
 *
 * ## What this service is
 *
 * One place that knows the ORDER of a session's operations — restore history,
 * start a run, cancel a run — and nothing about HOW any of them happen. The
 * how is a port; the order is here.
 *
 * The order is the part that was scattered before. The R1.0 audit found four
 * entry points that each started a run their own way (the standalone Host,
 * the Desktop router, the Bot dispatcher, and the sub-agent path that skipped
 * the control plane entirely), and two of them did not even apply the same
 * admission checks. Moving the order into one service is what makes the
 * convergence measurable: once every caller goes through here, "one authority
 * per fact" stops being a convention and becomes a property of the code.
 *
 * ## What this service deliberately does NOT do
 *
 * - It does not freeze a manifest. The Host freezes it, because the Host is
 *   the only layer that can see the installed capabilities, the resolved
 *   workspace and the authenticated caller. A manifest built here would be
 *   built from a subset of what the Host knows, and the run row would
 *   describe a run that could not be reconstructed from itself.
 * - It does not mint a run id. Same reason.
 * - It does not retry. Retrying an admission is a decision that depends on
 *   WHY it failed, and the reason is the Host's to give. The service reports
 *   the three outcomes it was given and lets the caller decide.
 *
 * ## The three admission outcomes are the point
 *
 * `admitted` / `rejected` / `failed` are not a taxonomy for its own sake. The
 * Host's wire vocabulary currently collapses five internal failure modes into
 * one, and that bucket mixes "busy" (wait), "already exists" (reconcile
 * against the receipt) and "not created" (retry and alert). A service that
 * returned a boolean would make that collapse permanent. Returning the
 * outcome keeps the distinction available to the caller, and makes the Host's
 * collapse a fixable Host bug instead of an architecture.
 */

import { hydrateSessionHistory } from './history.js';
import type {
  SessionAdmissionOutcome,
  SessionAdmissionPort,
  SessionExecutionPort,
  SessionHistory,
  SessionHistoryPorts,
  SessionRunRequest,
} from './ports.js';

/** The ports a session service is assembled from. */
export interface RuntimeSessionServicePorts {
  /**
   * Required.
   *
   * There is no default: a service without a way to start a run has no
   * reason to exist, and making the port optional would push that failure
   * into the first real call instead of the assembly.
   */
  readonly admission: SessionAdmissionPort;
  /**
   * Optional, and its absence is LOUD.
   *
   * A Host with no remote execution surface has nothing to cancel. It does
   * not get an empty implementation, because an empty implementation is a
   * method that returns "done" for a cancellation that never happened.
   */
  readonly execution?: SessionExecutionPort;
}

/** The Runtime Session service. */
export interface RuntimeSessionService {
  /**
   * Restore a session's history.
   *
   * The ports are passed per call rather than held by the service because
   * the row and message shapes differ per consumer, and a service that
   * captured them would be generic over types it does not own.
   */
  restoreHistory<Row, Attachment, ParsedDocument extends { readonly message_id: string }, Message>(
    sessionId: string,
    ports: SessionHistoryPorts<Row, Attachment, ParsedDocument, Message>,
  ): Promise<SessionHistory<Message>>;
  /**
   * Ask the Host to start a run.
   *
   * The request carries inputs only. The Host answers with an outcome, and
   * the outcome is returned unchanged — this service does not reinterpret a
   * refusal as an error or an error as a refusal.
   */
  startRun(request: SessionRunRequest): Promise<SessionAdmissionOutcome>;
  /**
   * Cancel a run.
   *
   * @throws when the service was assembled without an execution port. See
   *   `RuntimeSessionServicePorts.execution`.
   */
  cancelRun(runId: string, reason?: string): Promise<boolean>;
}

/**
 * Raised when a caller asks a service to cancel a run and the service has no
 * execution surface.
 *
 * A dedicated error type because "this host cannot cancel" and "the
 * cancellation failed" are different facts, and a caller that cannot tell
 * them apart will report one as the other.
 */
export class SessionExecutionUnavailableError extends Error {
  constructor(operation: string) {
    super(
      `session service: ${operation} is unavailable because no execution port was supplied`,
    );
    this.name = 'SessionExecutionUnavailableError';
  }
}

/**
 * Assemble a Runtime Session service from its ports.
 *
 * The service holds no state. A session's state lives in the Host's stores
 * and in the Run ledger the Host owns; a service that cached either would
 * become a second authority the first time a Host and a service disagreed.
 */
export function createRuntimeSessionService(
  ports: RuntimeSessionServicePorts,
): RuntimeSessionService {
  return {
    async restoreHistory(sessionId, historyPorts) {
      return await hydrateSessionHistory(sessionId, historyPorts);
    },

    async startRun(request) {
      return await ports.admission.admit(request);
    },

    async cancelRun(runId, reason) {
      if (!ports.execution) {
        throw new SessionExecutionUnavailableError('cancelRun');
      }
      return await ports.execution.cancel(runId, reason);
    },
  };
}
