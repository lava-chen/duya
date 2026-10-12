import type { RunEventEnvelope, RunTerminalState } from '@duya/agent-protocol';
import { RunEventConflictError, type RunOrigin } from '@duya/data/run-store';

import { classifySqlFailure, writeRunReceiptOnWire, type RunWriteReceipt } from './run-receipt.js';
import type { RunRepository } from './repository-port.js';

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

    try {
      const written = runs.appendEvents(envelopes as RunEventEnvelope[]);
      return onWire({ state: 'applied', runId }, { written });
    } catch (error) {
      if (error instanceof RunEventConflictError) {
        logger.warn('run:append refused — the same (run, seq) already holds different content', {
          runId,
          seq: error.seq,
        });
        return onWire({ state: 'conflict', runId, reason: error.message });
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

    try {
      const outcome = runs.settleRun(runId, terminal, payload.metrics);
      switch (outcome.state) {
        case 'applied':
          logger.info('Run settled', { runId, status: terminal.status });
          return onWire({ state: 'applied', runId });
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
