/**
 * The Control Plane facade — the `db:request` surface the agent-server calls.
 *
 * ## The process problem this exists to solve
 *
 * The agent-server is a FORK. It cannot open `duya-core.db` without becoming a
 * second writer to a database the main process owns, and
 * `MONOREPO_RFC.md` §1.11 calls `db-bridge.ts` the agent process's only DB
 * action dispatcher for exactly that reason. So the Control Plane lives in main
 * and the run layer in the agent-server reach it over the existing
 * `db:request` channel — the same one `lock:acquire` already uses
 * (`chat-runtime-lock.ts:71`).
 *
 * Reusing that channel rather than adding a transport is the point. A new IPC
 * surface for runs would be a second way for two processes to agree on where
 * state lives, and the first thing anyone would build on it would be a write
 * that races the one below.
 *
 * ## Three actions, not one
 *
 * `run:create` / `run:append` / `run:complete` are separate because they have
 * different failure semantics:
 *
 *  - `create` failing is FATAL to the run — there is no run without a record,
 *    and the caller must not dispatch the execution.
 *  - `append` failing is NOT fatal. The run is already streaming; losing an
 *    event batch degrades the transcript and the caller should say so, not
 *    abort a user's turn.
 *  - `complete` failing means the run has no terminal state. It is retried by
 *    the runtime's settle path, and a lost CAS is reported as a lost CAS
 *    rather than swallowed.
 */

import type { RunEventEnvelope, RunTerminalState } from '@duya/agent-protocol';
import { getCoreStores } from '../db/core-connection';
import { getLogger, LogComponent } from '../logging/logger';
import { RunEventConflictError } from '../db/core/run-store';
import { classifySqlFailure, isDurableWrite, type RunWriteReceipt } from './run-receipt';

/** The db-bridge request shape (`chat-runtime-lock.ts:36`). */
export type ControlPlaneRequest = (
  action: string,
  payload: Record<string, unknown>,
) => Promise<unknown>;

const logger = () => getLogger();

/**
 * Put a receipt on the wire.
 *
 * The shape crosses a process boundary, so it is built once here and read once
 * by `readRunReceipt` on the other side. `ok` is present on every reply because
 * a consumer that only reads `state` and one that only reads `ok` must not be
 * able to disagree about whether the call succeeded.
 */
function onWire(receipt: RunWriteReceipt, extra?: Record<string, unknown>): Record<string, unknown> {
  const durable = isDurableWrite(receipt);
  return {
    ok: durable,
    state: receipt.state,
    runId: receipt.runId,
    // `committed` is emitted only when there IS one. A `run:create` or
    // `run:append` conflict has no committed terminal, and emitting the key with
    // an `undefined` value would leave the reader to guess whether the producer
    // meant "none" or "I forgot".
    ...(receipt.state === 'conflict'
      ? { reason: receipt.reason, ...(receipt.committed === undefined ? {} : { committed: receipt.committed }) }
      : {}),
    ...(receipt.state === 'reconciled' ? { committed: receipt.committed } : {}),
    // `applied` is the "BY ME" claim, and it is carried by the `applied` state
    // alone. A `reconciled` receipt deliberately omits it: this call did not
    // write the terminal, another writer did. Emitting `applied: true` there
    // would erase the one distinction the state exists to make.
    ...(receipt.state === 'applied' ? { applied: true } : {}),
    ...(receipt.state === 'conflict' ? { applied: false } : {}),
    ...(extra ?? {}),
  };
}

// ── run:create ──────────────────────────────────────────────────────────

/**
 * Open a run: persist the frozen manifest and its hash, return the run id.
 *
 * Idempotent on `runId`, but NOT optimistically. The store decides whether a
 * duplicate is a retry or a conflict by comparing the recorded manifest AND
 * input digests against the ones this call carries; the Control Plane only
 * translates the outcome. It used to answer `{ ok: true, existed: true }` to
 * any duplicate at all, which told a caller holding a *different* manifest that
 * its run existed when it had in fact been refused.
 *
 * `inputHash` is required here even though the store treats it as optional. The
 * orchestrator has already computed the input revision by the time it calls
 * (`RunStartInput.revision`), so requiring it here costs nothing and buys the
 * check; a caller that cannot supply one gets an explicit `invalid` rather than
 * a row that can never be verified.
 */
export async function createRun(p: Record<string, unknown>): Promise<unknown> {
  const { runs } = getCoreStores();
  const runId = String(p.runId ?? '');
  const sessionId = String(p.sessionId ?? '');
  const manifest = p.manifest;
  const manifestHash = String(p.manifestHash ?? '');
  const inputHash = typeof p.inputHash === 'string' ? p.inputHash : null;

  if (runId === '' || sessionId === '' || manifestHash === '' || manifest == null) {
    // Refuse rather than insert a partial row. A `runs` row with an empty
    // manifest_hash can never be verified and would poison the run's identity
    // for as long as it exists.
    return onWire(
      { state: 'invalid', runId, reason: 'run:create requires runId, sessionId, manifest and manifestHash' },
    );
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
      ...(typeof p.origin === 'string' ? { origin: p.origin as never } : {}),
      ...(typeof p.parentRunId === 'string' ? { parentRunId: p.parentRunId } : {}),
    });
    if (outcome.state === 'conflict') {
      logger().warn('run:create refused — the runId already records different content', { runId, reason: outcome.reason }, LogComponent.DB);
      // No `committed`: a create conflict is about the run's IDENTITY, and
      // nothing about it is terminal. Inventing a terminal to fill the field
      // would hand the next reader a verdict nobody decided.
      return onWire({ state: 'conflict', runId, reason: outcome.reason });
    }
    if (outcome.state === 'reused') {
      logger().info('Run open retried — the same run was already recorded', { runId, sessionId }, LogComponent.DB);
      return onWire({ state: 'reused', runId });
    }
    logger().info('Run opened', { runId, sessionId, origin: p.origin }, LogComponent.DB);
    return onWire({ state: 'created', runId });
  } catch (error) {
    const state = classifySqlFailure(error);
    logger().error('run:create failed', error instanceof Error ? error : new Error(String(error)), { runId, sessionId, state }, LogComponent.DB);
    return onWire({ state, runId, reason: error instanceof Error ? error.message : String(error) });
  }
}

// ── run:append ──────────────────────────────────────────────────────────

/**
 * Append durable run events.
 *
 * Never throws. A lost batch degrades the durable transcript; aborting a user's
 * in-flight turn because one batch of events did not persist would trade a
 * partial record for a visibly broken product, and the record is the cheaper
 * loss.
 *
 * A CONTENT CONFLICT is reported as its own state rather than as a generic
 * failure, because it is the one refusal that will never resolve itself: the
 * same envelope offered again fails identically, so a caller that treats it as
 * transient spends its bounded retry on a permanent disagreement.
 */
export async function appendRunEvents(p: Record<string, unknown>): Promise<unknown> {
  const { runs } = getCoreStores();
  const envelopes = p.events;
  const runId = String(p.runId ?? '');
  if (!Array.isArray(envelopes)) {
    return onWire({ state: 'invalid', runId, reason: 'run:append requires an events array' });
  }

  try {
    const written = runs.appendEvents(envelopes as RunEventEnvelope[]);
    return onWire({ state: 'applied', runId }, { written });
  } catch (error) {
    if (error instanceof RunEventConflictError) {
      logger().warn('run:append refused — the same (run, seq) already holds different content', { runId, seq: error.seq }, LogComponent.DB);
      return onWire({ state: 'conflict', runId, reason: error.message });
    }
    const state = classifySqlFailure(error);
    logger().warn(`run:append failed — durable transcript degraded (${state})`, { runId, error: error instanceof Error ? error.message : String(error) }, LogComponent.DB);
    return onWire({ state, runId, reason: error instanceof Error ? error.message : String(error) });
  }
}

// ── run:complete ────────────────────────────────────────────────────────

/**
 * Land the run's one-shot terminal state.
 *
 * Reports whether the CAS was WON, and reconciles it when it was not. A lost CAS
 * is not an error to swallow: it means something else already decided this run's
 * history, so the committed terminal is read back and compared. Agreeing means
 * the run IS settled as asked (`reconciled`); disagreeing means the claim is
 * lost (`conflict`); no row at all means the write matched nothing (`absent`).
 *
 * `reconciled` is the state that did not exist before this slice, and it is the
 * one that matters: reporting a lost CAS as a failure told a host its run had
 * failed when its run had in fact succeeded and simply lost a race to a writer
 * that agreed with it.
 */
export async function completeRun(p: Record<string, unknown>): Promise<unknown> {
  const { runs } = getCoreStores();
  const runId = String(p.runId ?? '');
  const terminal = p.terminal as RunTerminalState | undefined;
  if (runId === '' || terminal == null || typeof terminal.status !== 'string') {
    return onWire({ state: 'invalid', runId, reason: 'run:complete requires runId and terminal' });
  }

  try {
    const outcome = runs.settleRun(runId, terminal, p.metrics);
    switch (outcome.state) {
      case 'applied':
        logger().info('Run settled', { runId, status: terminal.status }, LogComponent.DB);
        return onWire({ state: 'applied', runId });
      case 'reconciled':
        logger().warn('Run terminal CAS lost to a writer that agreed — the run is settled as asked', { runId, committed: outcome.committed.status }, LogComponent.DB);
        return onWire({ state: 'reconciled', runId, committed: outcome.committed });
      case 'conflict':
        logger().warn('Run terminal CAS lost to a writer that disagreed — the durable terminal is not this one', { runId, committed: outcome.committed.status, attempted: terminal.status }, LogComponent.DB);
        return onWire({
          state: 'conflict',
          runId,
          committed: outcome.committed,
          reason: `run ${runId} is durably ${outcome.committed.status}; this call proposed ${terminal.status}`,
        });
      case 'absent':
        logger().warn('Run terminal CAS matched no row — the run has no record to settle', { runId }, LogComponent.DB);
        return onWire({ state: 'absent', runId, reason: `run ${runId} has no row, so no terminal could be recorded` });
    }
  } catch (error) {
    const state = classifySqlFailure(error);
    logger().error('run:complete failed', error instanceof Error ? error : new Error(String(error)), { runId, state }, LogComponent.DB);
    return onWire({ state, runId, reason: error instanceof Error ? error.message : String(error) });
  }
}

// ── read-only ───────────────────────────────────────────────────────────

/** A run row plus its stored event count. Read path for diagnostics and for
 *  the eval harness's `outcome` evaluator. */
export async function getRun(p: Record<string, unknown>): Promise<unknown> {
  const { runs } = getCoreStores();
  const run = runs.getRun(String(p.runId ?? ''));
  if (run === null) return null;
  return { ...run, eventCount: runs.countEvents(run.id) };
}

/** A run's durable events from a sequence cursor. `afterSeq` is exclusive. */
export async function getRunEvents(p: Record<string, unknown>): Promise<unknown> {
  const { runs } = getCoreStores();
  const afterSeq = typeof p.afterSeq === 'number' ? p.afterSeq : 0;
  return runs.listEvents(String(p.runId ?? ''), afterSeq);
}

/** A session's runs, newest first. This is the "session is a projection of
 *  its runs" read that RFC §2 describes. */
export async function listSessionRuns(p: Record<string, unknown>): Promise<unknown> {
  const { runs } = getCoreStores();
  return runs.listRunsBySession(String(p.sessionId ?? ''));
}

/**
 * Dispatch a Control Plane action.
 *
 * The one entry point, so `db-bridge.ts` gains four `case` arms and one import
 * rather than four inline SQL blocks.
 */
export async function dispatchControlPlaneAction(
  action: string,
  payload: Record<string, unknown>,
): Promise<unknown | undefined> {
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
}

/** True when a better-sqlite3 error is a primary-key / uniqueness clash. */
function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === 'SQLITE_CONSTRAINT_PRIMARYKEY'
  );
}
