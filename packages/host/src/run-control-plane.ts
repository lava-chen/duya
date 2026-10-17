import type { RunEventEnvelope, RunTerminalState } from '@duya/agent-protocol';
import { RunEpochFencedError, RunEventConflictError, type RunOrigin } from '@duya/data/run-store';

import { classifySqlFailure, fencedReceipt, writeRunReceiptOnWire, type RunWriteReceipt } from './run-receipt.js';
import type { RunRepository } from './repository-port.js';

/**
 * The writer this boundary records a refusal against.
 *
 * A refusal that cannot say who presented it cannot be acted on: the caller has
 * to decide whether to retry with an attempt or to accept the refusal, and it
 * cannot do either without knowing which of its writers was refused.
 */
const CONTROL_PLANE_WRITER = 'host/run-control-plane';

/**
 * The attempt a caller presented, or `null` when it presented none.
 *
 * ## `null` is a REFUSAL, not a fallback
 *
 * Storage fences only what a writer claims, so `undefined` here means a
 * DELIBERATE unfenced write. That made a missing epoch and a forgotten one the
 * same value, and the forgotten one is the dangerous half: on the path that
 * serves production execution, a caller that simply omitted the attempt wrote
 * straight through the fence while looking exactly like a maintenance repair.
 *
 * So the reading side refuses instead of defaulting. The deliberate unfenced
 * write is still reachable — see {@link readUnfencedAuthorization} — but only by
 * naming it with a reason and an author, which is a decision rather than an
 * omission.
 *
 * `0` is not invented for a missing value either: it would hand an unfenced
 * writer the first attempt's authority, which is precisely the thing this
 * function exists to withhold.
 */
function readAttemptFence(payload: Record<string, unknown>): { readonly epoch: number } | null {
  const epoch = payload.epoch;
  if (typeof epoch !== 'number' || !Number.isSafeInteger(epoch) || epoch < 0) return null;
  return { epoch };
}

/**
 * The explicit authorization for a deliberately UNFENCED maintenance write, or
 * `null` when the caller did not name one.
 *
 * Deliberately unfenced is a real need — a bulk backfill, an administrative
 * repair of a run whose attempt history is gone — so it stays reachable. What
 * must not stay reachable is arriving there by omission, and that is the whole
 * difference between this and the previous `readEpoch`.
 *
 * `reason` and `authorizedBy` are both required and both non-empty, so an
 * unfenced write is attributable to a decision and a person rather than to a
 * missing field. A reason is not optional metadata here: it is the only thing
 * that makes an unfenced write reviewable after the fact.
 */
function readUnfencedAuthorization(
  payload: Record<string, unknown>,
): { readonly reason: string; readonly authorizedBy: string } | null {
  const candidate = payload.unfenced;
  if (typeof candidate !== 'object' || candidate === null) return null;
  const { reason, authorizedBy } = candidate as { reason?: unknown; authorizedBy?: unknown };
  if (typeof reason !== 'string' || reason.trim() === '') return null;
  if (typeof authorizedBy !== 'string' || authorizedBy.trim() === '') return null;
  return { reason: reason.trim(), authorizedBy: authorizedBy.trim() };
}

/** The refusal a writer gets when it presents no readable attempt. */
function missingFenceReceipt(action: string, runId: string, payload: Record<string, unknown>): RunWriteReceipt {
  const presented = payload.epoch === undefined ? 'no epoch' : `epoch ${String(payload.epoch)}`;
  return {
    state: 'invalid',
    runId,
    reason:
      `${action} from ${CONTROL_PLANE_WRITER} requires an attempt epoch (${presented}): a run write with no ` +
      'attempt is refused rather than made unfenced. A deliberate unfenced write must name an ' +
      '`unfenced` authorization with a reason and an author.',
  };
}

/** The refusal a writer gets when it names an authorization it cannot read. */
function missingAuthorizationReceipt(action: string, runId: string): RunWriteReceipt {
  return {
    state: 'invalid',
    runId,
    reason:
      `${action}-unfenced from ${CONTROL_PLANE_WRITER} requires an \`unfenced\` authorization carrying ` +
      'a non-empty reason and authorizedBy: an unfenced run write is a decision on the record, not a default.',
  };
}

/**
 * Whether the caller is ASKING for an unfenced write, as opposed to having
 * forgotten the fence.
 *
 * `payload.unfenced` being present at all is the signal: a caller that never
 * heard of the field cannot have set it by accident. What the object contains is
 * validated separately, so a malformed authorization gets its OWN refusal
 * (`missingAuthorizationReceipt`) rather than being reported as a forgotten
 * fence — the two are different mistakes with different fixes, and telling a
 * caller to add a field it already added is worse than silence.
 */
function namesUnfencedWrite(payload: Record<string, unknown>): boolean {
  return typeof payload.unfenced === 'object' && payload.unfenced !== null;
}

/**
 * A deliberately unfenced write is allowed through, and is always said out loud.
 *
 * Returning `true` means "this caller is authorized to write unfenced, having
 * said so with a reason and an author"; `false` means it is refused and the
 * caller should read the receipt for which of the two mistakes it made.
 */
function unfencedWriteAuthorized(
  action: string,
  runId: string,
  payload: Record<string, unknown>,
  logger: RunControlPlaneLogger,
): boolean {
  if (!namesUnfencedWrite(payload)) {
    logger.warn(`${action} refused — the presenting writer named no attempt and no unfenced authorization`, {
      runId,
      writer: CONTROL_PLANE_WRITER,
    });
    return false;
  }
  const authorization = readUnfencedAuthorization(payload);
  if (authorization === null) {
    logger.warn(`${action} refused — an unfenced authorization was named but could not be read`, {
      runId,
      writer: CONTROL_PLANE_WRITER,
    });
    return false;
  }
  logger.warn(`${action} is landing UNFENCED — the caller named an explicit authorization`, {
    runId,
    writer: CONTROL_PLANE_WRITER,
    reason: authorization.reason,
    authorizedBy: authorization.authorizedBy,
  });
  return true;
}

export interface RunControlPlaneLogger {
  info(message: string, context?: Record<string, unknown>): void;
  warn(message: string, context?: Record<string, unknown>): void;
  error(message: string, error: Error, context?: Record<string, unknown>): void;
}

export interface RunControlPlaneActions {
  createRun(payload: Record<string, unknown>): Promise<unknown>;
  appendRunEvents(payload: Record<string, unknown>): Promise<unknown>;
  completeRun(payload: Record<string, unknown>): Promise<unknown>;
  getRun(payload: Record<string, unknown>): Promise<unknown>;
  getRunEvents(payload: Record<string, unknown>): Promise<unknown>;
  listSessionRuns(payload: Record<string, unknown>): Promise<unknown>;
  dispatchControlPlaneAction(action: string, payload: Record<string, unknown>): Promise<unknown | undefined>;
}

export function createRunControlPlaneActions(options: {
  readonly runs: RunRepository;
  readonly logger?: RunControlPlaneLogger;
}): RunControlPlaneActions {
  const { runs } = options;
  const logger = options.logger ?? {
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
  };

  const onWire = (receipt: RunWriteReceipt, extra?: Record<string, unknown>): Record<string, unknown> =>
    writeRunReceiptOnWire(receipt, extra);

  const createRun = async (payload: Record<string, unknown>): Promise<unknown> => {
    const runId = String(payload.runId ?? '');
    const sessionId = String(payload.sessionId ?? '');
    const manifest = payload.manifest;
    const manifestHash = String(payload.manifestHash ?? '');
    const inputHash = typeof payload.inputHash === 'string' ? payload.inputHash : null;

    if (runId === '' || sessionId === '' || manifestHash === '' || manifest == null) {
      return onWire({
        state: 'invalid',
        runId,
        reason: 'run:create requires runId, sessionId, manifest and manifestHash',
      });
    }
    if (inputHash === null) {
      return onWire({
        state: 'invalid',
        runId,
        reason:
          'run:create requires inputHash: without it a reused runId can never be told apart from a different run with the same manifest',
      });
    }

    try {
      const outcome = runs.createRun({
        runId,
        sessionId,
        manifest,
        manifestHash,
        inputHash,
        ...(typeof payload.origin === 'string' ? { origin: payload.origin as RunOrigin } : {}),
        ...(typeof payload.parentRunId === 'string' ? { parentRunId: payload.parentRunId } : {}),
      });
      if (outcome.state === 'conflict') {
        logger.warn('run:create refused — the runId already records different content', {
          runId,
          reason: outcome.reason,
        });
        return onWire({ state: 'conflict', runId, reason: outcome.reason });
      }
      if (outcome.state === 'reused') {
        logger.info('Run open retried — the same run was already recorded', { runId, sessionId });
        return onWire({ state: 'reused', runId });
      }
      logger.info('Run opened', { runId, sessionId, origin: payload.origin });
      return onWire({ state: 'created', runId });
    } catch (error) {
      const state = classifySqlFailure(error);
      logger.error(
        'run:create failed',
        error instanceof Error ? error : new Error(String(error)),
        { runId, sessionId, state },
      );
      return onWire({ state, runId, reason: error instanceof Error ? error.message : String(error) });
    }
  };

  const appendRunEvents = async (payload: Record<string, unknown>): Promise<unknown> => {
    const envelopes = payload.events;
    const runId = String(payload.runId ?? '');
    if (!Array.isArray(envelopes)) {
      return onWire({ state: 'invalid', runId, reason: 'run:append requires an events array' });
    }
    // Fenced or deliberately unfenced — never accidentally either. See
    // `readAttemptFence`: a missing attempt used to reach the repository as
    // `undefined`, which storage reads as a deliberate unfenced write, so a
    // caller that forgot the epoch wrote through the fence on the very path
    // that serves production execution.
    const fence = readAttemptFence(payload);
    if (fence === null && !unfencedWriteAuthorized('run:append', runId, payload, logger)) {
      return onWire(
        namesUnfencedWrite(payload)
          ? missingAuthorizationReceipt('run:append', runId)
          : missingFenceReceipt('run:append', runId, payload),
      );
    }

    try {
      const written = runs.appendEvents(
        envelopes as RunEventEnvelope[],
        fence === null ? undefined : fence.epoch,
      );
      return onWire({ state: 'applied', runId }, { written });
    } catch (error) {
      if (error instanceof RunEventConflictError) {
        logger.warn('run:append refused — the same (run, seq) already holds different content', {
          runId,
          seq: error.seq,
        });
        return onWire({ state: 'conflict', runId, reason: error.message });
      }
      if (error instanceof RunEpochFencedError) {
        // Its own state, not `conflict`: a superseded attempt loses this write
        // because it lost the RIGHT to write, and no other writer disagreed
        // with it. Reporting a conflict here would blame a rival for a refusal
        // that is entirely about the presenting attempt.
        logger.warn('run:append refused — the presenting attempt has been superseded', {
          runId,
          presented: error.presented,
          current: error.current,
        });
        return onWire(fencedReceipt(runId, error.presented, error.current));
      }
      const state = classifySqlFailure(error);
      logger.warn(`run:append failed — durable transcript degraded (${state})`, {
        runId,
        error: error instanceof Error ? error.message : String(error),
      });
      return onWire({ state, runId, reason: error instanceof Error ? error.message : String(error) });
    }
  };

  const completeRun = async (payload: Record<string, unknown>): Promise<unknown> => {
    const runId = String(payload.runId ?? '');
    const terminal = payload.terminal as RunTerminalState | undefined;
    if (runId === '' || terminal == null || typeof terminal.status !== 'string') {
      return onWire({ state: 'invalid', runId, reason: 'run:complete requires runId and terminal' });
    }
    // Same rule as `run:append`, and it matters MORE here: the terminal CAS is
    // the write the attempt fence exists for, so an unfenced settle is how a
    // superseded attempt lands a terminal it had no right to land.
    const fence = readAttemptFence(payload);
    if (fence === null && !unfencedWriteAuthorized('run:complete', runId, payload, logger)) {
      return onWire(
        namesUnfencedWrite(payload)
          ? missingAuthorizationReceipt('run:complete', runId)
          : missingFenceReceipt('run:complete', runId, payload),
      );
    }

    try {
      const outcome = runs.settleRun(runId, terminal, payload.metrics, fence === null ? undefined : fence.epoch);
      switch (outcome.state) {
        case 'applied':
          logger.info('Run settled', { runId, status: terminal.status });
          return onWire({ state: 'applied', runId });
        case 'fenced':
          // The terminal CAS is fenced by the same attempt that fences the
          // appends, so a superseded attempt cannot land a terminal either.
          logger.warn('Run terminal refused — the presenting attempt has been superseded', {
            runId,
            presented: outcome.presented,
            current: outcome.current,
          });
          return onWire(fencedReceipt(runId, outcome.presented, outcome.current));
        case 'reconciled':
          logger.warn('Run terminal CAS lost to a writer that agreed — the run is settled as asked', {
            runId,
            committed: outcome.committed.status,
          });
          return onWire({ state: 'reconciled', runId, committed: outcome.committed });
        case 'conflict':
          logger.warn('Run terminal CAS lost to a writer that disagreed — the durable terminal is not this one', {
            runId,
            committed: outcome.committed.status,
            attempted: terminal.status,
          });
          return onWire({
            state: 'conflict',
            runId,
            committed: outcome.committed,
            reason: `run ${runId} is durably ${outcome.committed.status}; this call proposed ${terminal.status}`,
          });
        case 'absent':
          logger.warn('Run terminal CAS matched no row — the run has no record to settle', { runId });
          return onWire({ state: 'absent', runId, reason: `run ${runId} has no row, so no terminal could be recorded` });
      }
    } catch (error) {
      const state = classifySqlFailure(error);
      logger.error(
        'run:complete failed',
        error instanceof Error ? error : new Error(String(error)),
        { runId, state },
      );
      return onWire({ state, runId, reason: error instanceof Error ? error.message : String(error) });
    }
  };

  const getRun = async (payload: Record<string, unknown>): Promise<unknown> => {
    const run = runs.getRun(String(payload.runId ?? ''));
    if (run === null) return null;
    return { ...run, eventCount: runs.countEvents(run.id) };
  };

  const getRunEvents = async (payload: Record<string, unknown>): Promise<unknown> => {
    const afterSeq = typeof payload.afterSeq === 'number' ? payload.afterSeq : 0;
    return runs.listEvents(String(payload.runId ?? ''), afterSeq);
  };

  const listSessionRuns = async (payload: Record<string, unknown>): Promise<unknown> =>
    runs.listRunsBySession(String(payload.sessionId ?? ''));

  const dispatchControlPlaneAction = async (
    action: string,
    payload: Record<string, unknown>,
  ): Promise<unknown | undefined> => {
    switch (action) {
      case 'run:create':
        return createRun(payload);
      case 'run:append':
        return appendRunEvents(payload);
      case 'run:complete':
        return completeRun(payload);
      case 'run:get':
        return getRun(payload);
      case 'run:events':
        return getRunEvents(payload);
      case 'run:list-session':
        return listSessionRuns(payload);
      default:
        return undefined;
    }
  };

  return {
    createRun,
    appendRunEvents,
    completeRun,
    getRun,
    getRunEvents,
    listSessionRuns,
    dispatchControlPlaneAction,
  };
}
