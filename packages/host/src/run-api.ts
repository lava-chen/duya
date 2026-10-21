import {
  manifestFingerprint,
  type AgentRunEventStreamQuery,
  type AgentRunRecord,
  type AgentRunOrigin,
  type CreateAgentRunInput,
  type HostRunApiV1,
  type RunAttemptFence,
  type RunEventEnvelope,
  type RunId,
  type RunMetrics,
  type ProtocolErrorInfo,
  type RunTerminalState,
  type SettleAgentRunResult,
  type UnfencedRunWriteAuthorization,
} from '@duya/agent-protocol';
import type { CoreDataHostStores } from '@duya/data/core-data-host';
import { RunEpochFencedError, RunEventConflictError, type RunRow } from '@duya/data/run-store';

const DEFAULT_EVENT_PAGE_SIZE = 500;
const MAX_EVENT_PAGE_SIZE = 1000;
const DEFAULT_SESSION_RUN_LIMIT = 50;
const MAX_SESSION_RUN_LIMIT = 100;

export class HostRunApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    /**
     * The attempt numbers behind a `409 attempt_fenced`, when the refusing hop
     * can report them. A remote HTTP boundary cannot — it forwards a status and
     * a message — so `undefined` here means "not reported", not "no fence".
     */
    readonly fenced?: { readonly presented: number; readonly current: number | null },
  ) {
    super(message);
    this.name = 'HostRunApiError';
  }
}

/** Host-owned adapter over the durable Agent Run store. */
export function createHostRunApi(stores: Pick<CoreDataHostStores, 'runs'>): HostRunApiV1 {
  const runs = stores.runs;
  return {
    async createAgentRun(input: CreateAgentRunInput) {
      if (input.manifest.runId !== input.runId) {
        throw new HostRunApiError(400, 'run_manifest_id_mismatch', 'Manifest runId does not match the requested run');
      }
      let actualManifestHash: string;
      try {
        actualManifestHash = manifestFingerprint(input.manifest);
      } catch {
        throw new HostRunApiError(400, 'invalid_run_manifest', 'Manifest cannot be fingerprinted');
      }
      if (actualManifestHash !== input.manifestHash) {
        throw new HostRunApiError(400, 'run_manifest_hash_mismatch', 'Manifest fingerprint does not match manifestHash');
      }
      const outcome = runs.createRun(input);
      if (outcome.state === 'conflict') {
        throw new HostRunApiError(409, 'run_identity_conflict', outcome.reason);
      }
      return { state: outcome.state, runId: input.runId };
    },

    async getAgentRun(runId: RunId) {
      const row = runs.getRun(runId);
      return row === null ? null : toAgentRunRecord(row, runs.countEvents(runId));
    },

    async listAgentRunsBySession(sessionId, limit = DEFAULT_SESSION_RUN_LIMIT) {
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_SESSION_RUN_LIMIT) {
        throw new HostRunApiError(400, 'invalid_agent_run_limit', `limit must be between 1 and ${MAX_SESSION_RUN_LIMIT}`);
      }
      return runs.listRunsBySession(sessionId, limit).map((row) => toAgentRunRecord(row));
    },

    async appendAgentRunEvents(runId: RunId, events: readonly RunEventEnvelope[], fence: RunAttemptFence) {
      if (events.some((event) => event.runId !== runId)) {
        throw new HostRunApiError(400, 'run_event_id_mismatch', 'Every event must belong to the requested run');
      }
      const run = runs.getRun(runId);
      if (run === null) {
        throw new HostRunApiError(404, 'run_not_found', `Run not found: ${runId}`);
      }
      if (events.some((event) => event.sessionId !== run.session_id)) {
        throw new HostRunApiError(400, 'run_event_session_mismatch', 'Events must belong to the run session');
      }
      // Read BEFORE the storage call, never defaulted: an unreadable fence is a
      // refusal naming the writer, because "which attempt is this?" is the
      // question a refused write exists to answer.
      const epoch = readFenceEpoch(fence);
      try {
        return runs.appendEvents(events, epoch);
      } catch (error) {
        if (error instanceof RunEventConflictError) {
          throw new HostRunApiError(409, error.code, error.message);
        }
        // A superseded attempt is a 409 with its OWN code, because the caller
        // has to be able to tell "another writer disagrees" from "you are no
        // longer the writer": the remedies are opposite, and the second one
        // means the caller drops the batch instead of reporting a conflict.
        if (error instanceof RunEpochFencedError) {
          throw new HostRunApiError(409, error.code, error.message, {
            presented: error.presented,
            current: error.current,
          });
        }
        throw error;
      }
    },

    async settleAgentRun(runId: RunId, terminal: RunTerminalState, fence: RunAttemptFence, metrics: RunMetrics) {
      return runs.settleRun(runId, terminal, metrics, readFenceEpoch(fence)) as SettleAgentRunResult;
    },

    /**
     * Deliberate unfenced append.
     *
     * Reached ONLY by naming it, with a reason and an author the caller had to
     * type. It is not the fenced method with a fence left off, so no argument
     * omission can land here — and it refuses an authorization it cannot read,
     * rather than forwarding a write whose authority it never established.
     */
    async appendAgentRunEventsUnfenced(
      runId: RunId,
      events: readonly RunEventEnvelope[],
      authorization: UnfencedRunWriteAuthorization,
    ) {
      readUnfencedAuthorization(authorization);
      if (events.some((event) => event.runId !== runId)) {
        throw new HostRunApiError(400, 'run_event_id_mismatch', 'Every event must belong to the requested run');
      }
      const run = runs.getRun(runId);
      if (run === null) {
        throw new HostRunApiError(404, 'run_not_found', `Run not found: ${runId}`);
      }
      try {
        return runs.appendEvents(events, undefined);
      } catch (error) {
        if (error instanceof RunEventConflictError) {
          throw new HostRunApiError(409, error.code, error.message);
        }
        throw error;
      }
    },

    async settleAgentRunUnfenced(
      runId: RunId,
      terminal: RunTerminalState,
      authorization: UnfencedRunWriteAuthorization,
      metrics: RunMetrics,
    ) {
      readUnfencedAuthorization(authorization);
      return runs.settleRun(runId, terminal, metrics, undefined) as SettleAgentRunResult;
    },

    async readAgentRunEvents(runId: RunId, query = {}) {
      if (runs.getRun(runId) === null) {
        throw new HostRunApiError(404, 'run_not_found', `Run not found: ${runId}`);
      }
      const afterSeq = query.afterSeq ?? 0;
      const limit = query.limit ?? DEFAULT_EVENT_PAGE_SIZE;
      if (!Number.isSafeInteger(afterSeq) || afterSeq < 0) {
        throw new HostRunApiError(400, 'invalid_run_event_cursor', 'afterSeq must be a non-negative safe integer');
      }
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_EVENT_PAGE_SIZE) {
        throw new HostRunApiError(400, 'invalid_run_event_page', `limit must be between 1 and ${MAX_EVENT_PAGE_SIZE}`);
      }
      return runs.listEvents(runId, afterSeq, limit).map((row) => {
        let parsed: unknown;
        try {
          parsed = JSON.parse(row.envelope_json);
        } catch {
          throw new HostRunApiError(500, 'corrupt_run_event', `Run ${runId} has invalid event JSON at seq ${row.seq}`);
        }
        if (
          !isRecord(parsed) || parsed.runId !== runId || parsed.seq !== row.seq ||
          !isRecord(parsed.payload) || typeof parsed.payload.type !== 'string'
        ) {
          throw new HostRunApiError(500, 'corrupt_run_event', `Run ${runId} has an invalid event at seq ${row.seq}`);
        }
        return parsed as unknown as RunEventEnvelope;
      });
    },

    async *watchAgentRunEvents(runId: RunId, query: AgentRunEventStreamQuery = {}) {
      let afterSeq = query.afterSeq ?? 0;
      const limit = query.limit ?? DEFAULT_EVENT_PAGE_SIZE;
      if (!Number.isSafeInteger(afterSeq) || afterSeq < 0) {
        throw new HostRunApiError(400, 'invalid_run_event_cursor', 'afterSeq must be a non-negative safe integer');
      }
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_EVENT_PAGE_SIZE) {
        throw new HostRunApiError(400, 'invalid_run_event_page', `limit must be between 1 and ${MAX_EVENT_PAGE_SIZE}`);
      }

      while (!query.signal?.aborted) {
        const events = await this.readAgentRunEvents(runId, { afterSeq, limit });
        for (const event of events) {
          if (event.seq <= afterSeq) {
            throw new HostRunApiError(500, 'corrupt_run_event', `Run ${runId} returned a non-advancing event cursor`);
          }
          afterSeq = event.seq;
          yield event;
        }

        // Drain every full page before checking terminal state. A settled run
        // may still have more durable events than one page.
        if (events.length === limit) continue;
        const run = await this.getAgentRun(runId);
        if (run === null) throw new HostRunApiError(404, 'run_not_found', `Run not found: ${runId}`);
        if (run.terminal !== null) return;
        await waitForRunEventPoll(query.signal);
      }
    },
  };
}

/**
 * The attempt a fence presents, or a 400 naming the writer that failed to.
 *
 * A value that is missing, non-integer, negative or unattributed is REFUSED, not
 * defaulted to `0`. This is the whole reason the fenced methods take a required
 * fence: storage reads `undefined` as a deliberate unfenced write, so a fence
 * that quietly became `undefined` here would be an unfenced write that looks
 * exactly like a fenced one.
 */
function readFenceEpoch(fence: RunAttemptFence): number {
  // Widened before it is read: the declared type says every caller passed a
  // fence, and the whole point of this function is to be honest with the ones
  // that did not.
  const value: unknown = fence;
  if (!isRecord(value) || typeof value.writer !== 'string' || value.writer.trim() === '') {
    throw new HostRunApiError(
      400,
      'invalid_run_attempt_fence',
      'A fenced run write requires an attempt fence naming the writer that presents it',
    );
  }
  const writer = value.writer;
  const epoch = value.epoch;
  if (typeof epoch !== 'number' || !Number.isSafeInteger(epoch) || epoch < 0) {
    throw new HostRunApiError(
      400,
      'invalid_run_attempt_fence',
      `${writer} presented an attempt fence that is not a non-negative integer epoch`,
    );
  }
  return epoch;
}

/**
 * The authorization behind a deliberately unfenced write.
 *
 * Refuses anything it cannot read. An unfenced write is the one operation in
 * this file that ignores the attempt fence, so the record of WHY must be as
 * strong as the fence it replaces — otherwise "unfenced" becomes the answer to
 * any problem, which is the degradation this contract exists to remove.
 */
function readUnfencedAuthorization(authorization: UnfencedRunWriteAuthorization): void {
  const value: unknown = authorization;
  if (
    !isRecord(value) ||
    typeof value.reason !== 'string' || value.reason.trim() === '' ||
    typeof value.authorizedBy !== 'string' || value.authorizedBy.trim() === ''
  ) {
    throw new HostRunApiError(
      400,
      'invalid_unfenced_run_write',
      'An unfenced run write requires an authorization carrying a reason and an author',
    );
  }
}

function waitForRunEventPoll(signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const finish = (): void => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', finish);
      resolve();
    };
    const timer = setTimeout(finish, 250);
    signal?.addEventListener('abort', finish, { once: true });
  });
}

function toAgentRunRecord(row: RunRow, eventCount?: number): AgentRunRecord {
  const manifest = parseJson(row.manifest_json, 'manifest', row.id);
  if (!isRecord(manifest) || manifest.runId !== row.id) {
    throw new HostRunApiError(500, 'corrupt_agent_run', `Run ${row.id} has an invalid manifest record`);
  }
  let manifestHash: string;
  try {
    manifestHash = manifestFingerprint(manifest as unknown as CreateAgentRunInput['manifest']);
  } catch {
    throw new HostRunApiError(500, 'corrupt_agent_run', `Run ${row.id} has an invalid manifest record`);
  }
  if (manifestHash !== row.manifest_hash) {
    throw new HostRunApiError(500, 'corrupt_agent_run', `Run ${row.id} has an invalid manifest record`);
  }
  const terminal = parseStoredTerminal(row);
  const metrics = row.metrics_json === null ? null : parseMetrics(row.metrics_json, row.id);
  const origin = parseOrigin(row.origin, row.id);
  return {
    runId: row.id as RunId,
    sessionId: row.session_id as CreateAgentRunInput['sessionId'],
    manifest: manifest as unknown as CreateAgentRunInput['manifest'],
    manifestHash: row.manifest_hash,
    inputHash: row.input_hash,
    status: row.status,
    terminal,
    metrics,
    origin,
    parentRunId: row.parent_run_id as RunId | null,
    createdAt: row.created_at,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    ...(eventCount === undefined ? {} : { eventCount }),
  };
}

function parseStoredTerminal(row: RunRow): RunTerminalState | null {
  if (row.terminal === null) return null;
  if (row.terminal === 'completed' || row.terminal === 'cancelled' || row.terminal === 'budget_exhausted') {
    return { status: row.terminal };
  }
  if (row.terminal === 'failed') {
    if (row.error_json === null) {
      throw new HostRunApiError(500, 'corrupt_agent_run', `Run ${row.id} is failed without an error record`);
    }
    const error = parseJson(row.error_json, 'error', row.id);
    if (!isRecord(error) || typeof error.code !== 'string' || typeof error.message !== 'string') {
      throw new HostRunApiError(500, 'corrupt_agent_run', `Run ${row.id} has an invalid error record`);
    }
    return {
      status: 'failed',
      error: error as unknown as ProtocolErrorInfo,
    };
  }
  throw new HostRunApiError(500, 'corrupt_agent_run', `Run ${row.id} has an unknown terminal status`);
}

function parseMetrics(json: string, runId: string): RunMetrics {
  const value = parseJson(json, 'metrics', runId);
  if (
    !isRecord(value) ||
    !['eventsTotal', 'eventsDurable', 'eventsVolatile', 'eventsEphemeral', 'toolCalls', 'permissionRequests', 'wallClockMs']
      .every((key) => typeof value[key] === 'number' && Number.isFinite(value[key]))
  ) {
    throw new HostRunApiError(500, 'corrupt_agent_run', `Run ${runId} has invalid metrics`);
  }
  return value as unknown as RunMetrics;
}

function parseOrigin(value: string | null, runId: string): AgentRunOrigin | null {
  if (value === null) return null;
  if (value === 'user' || value === 'agent' || value === 'background') return value;
  throw new HostRunApiError(500, 'corrupt_agent_run', `Run ${runId} has an unknown origin`);
}

function parseJson(json: string, field: string, runId: string): unknown {
  try {
    return JSON.parse(json) as unknown;
  } catch {
    throw new HostRunApiError(500, 'corrupt_agent_run', `Run ${runId} has invalid ${field} JSON`);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
