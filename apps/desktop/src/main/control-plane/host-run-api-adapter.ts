import type {
  AgentRunRecord,
  AgentRunOrigin,
  CreateAgentRunInput,
  HostRunApiV1,
  RunEventEnvelope,
  RunId,
  RunManifest,
  RunMetrics,
  RunTerminalState,
  SessionId,
} from '@duya/agent-protocol';
import { manifestFingerprint } from '@duya/agent-protocol';
import { HostSessionHttpError } from '@duya/host/http-client';
import type { ControlPlaneRequest } from '@duya/host/control-plane-service';
import {
  failedReceipt,
  fencedReceipt,
  writeRunReceiptOnWire,
  type RunWriteReceipt,
} from '@duya/host/run-receipt';
import { HostRunApiError } from '@duya/host/run-api';

const EVENT_PAGE_SIZE = 1000;
const RUN_ORIGINS = new Set<AgentRunOrigin>(['user', 'agent', 'background']);

/**
 * Adapt the trusted Agent Server's existing command vocabulary to the typed
 * Host Run API. ControlPlaneService still authenticates the worker sender
 * before this request is reached.
 */
export function createDesktopHostRunApiAdapter(api: HostRunApiV1): ControlPlaneRequest {
  return async (action, payload) => {
    switch (action) {
      case 'run:create':
        return createRun(api, payload);
      case 'run:append':
        return appendEvents(api, payload);
      case 'run:complete':
        return settleRun(api, payload);
      case 'run:events':
        return readEvents(api, payload);
      case 'run:get': {
        const runId = nonEmptyString(payload.runId);
        if (runId === null) return null;
        const run = await api.getAgentRun(runId as RunId);
        return run === null ? null : toLegacyRunRecord(run);
      }
      case 'run:list-session': {
        const sessionId = typeof payload.sessionId === 'string' ? payload.sessionId : '';
        const runs = await api.listAgentRunsBySession(sessionId as SessionId);
        return runs.map(toLegacyRunRecord);
      }
      default:
        return undefined;
    }
  };
}

function toLegacyRunRecord(run: AgentRunRecord): Record<string, unknown> {
  return {
    id: run.runId,
    session_id: run.sessionId,
    manifest_hash: run.manifestHash,
    manifest_json: JSON.stringify(run.manifest),
    input_hash: run.inputHash,
    status: run.status,
    terminal: run.terminal?.status ?? null,
    error_json: run.terminal?.status === 'failed' ? JSON.stringify(run.terminal.error) : null,
    metrics_json: run.metrics === null ? null : JSON.stringify(run.metrics),
    origin: run.origin,
    parent_run_id: run.parentRunId,
    created_at: run.createdAt,
    started_at: run.startedAt,
    finished_at: run.finishedAt,
    ...(run.eventCount === undefined ? {} : { eventCount: run.eventCount }),
  };
}

async function createRun(api: HostRunApiV1, payload: Record<string, unknown>): Promise<unknown> {
  const runId = nonEmptyString(payload.runId);
  const sessionId = nonEmptyString(payload.sessionId);
  // Presence is part of the legacy contract and stays refused when missing;
  // the VALUE is translated below.
  const legacyManifestHash = nonEmptyString(payload.manifestHash);
  const inputHash = typeof payload.inputHash === 'string' ? payload.inputHash : null;
  if (runId === null || sessionId === null || legacyManifestHash === null || inputHash === null || !isRecord(payload.manifest)) {
    return writeRunReceiptOnWire(failedReceipt(
      'invalid',
      runId ?? '',
      'run:create requires runId, sessionId, manifest, manifestHash and inputHash',
    ));
  }
  if (payload.origin !== undefined && (typeof payload.origin !== 'string' || !RUN_ORIGINS.has(payload.origin as AgentRunOrigin))) {
    return writeRunReceiptOnWire(failedReceipt('invalid', runId, 'run:create origin is invalid'));
  }

  // The legacy `db:request` contract carried an OPAQUE manifest hash — the old
  // in-main facade stored whatever it was handed. The Host Run API owns
  // fingerprinting instead: `manifestHash` must be the canonical fingerprint
  // of the manifest it accompanies. This boundary is where the two contracts
  // meet, so the fingerprint is RECOMPUTED here from the manifest actually
  // being forwarded; the caller's hash is required but its value is ignored.
  // The Host's tamper check stays meaningful — it now verifies the main→Host
  // hop, whose payload this recomputation made self-consistent.
  let manifestHash: string;
  try {
    manifestHash = manifestFingerprint(payload.manifest as unknown as RunManifest);
  } catch {
    return writeRunReceiptOnWire(failedReceipt(
      'invalid',
      runId,
      'run:create manifest cannot be fingerprinted',
    ));
  }

  const input: CreateAgentRunInput = {
    runId: runId as RunId,
    sessionId: sessionId as SessionId,
    manifest: payload.manifest as unknown as RunManifest,
    manifestHash,
    inputHash,
    ...(payload.origin === undefined ? {} : { origin: payload.origin as AgentRunOrigin }),
    ...(typeof payload.parentRunId === 'string' ? { parentRunId: payload.parentRunId as RunId } : {}),
  };
  try {
    const result = await api.createAgentRun(input);
    const receipt: RunWriteReceipt = result.state === 'created'
      ? { state: 'created', runId }
      : { state: 'reused', runId };
    return writeRunReceiptOnWire(receipt);
  } catch (error) {
    return writeRunReceiptOnWire(hostFailureReceipt('run:create', runId, error));
  }
}

async function appendEvents(api: HostRunApiV1, payload: Record<string, unknown>): Promise<unknown> {
  const runId = nonEmptyString(payload.runId);
  if (runId === null || !Array.isArray(payload.events)) {
    return writeRunReceiptOnWire(failedReceipt('invalid', runId ?? '', 'run:append requires runId and an events array'));
  }
  try {
    const written = await api.appendAgentRunEvents(
      runId as RunId,
      payload.events as RunEventEnvelope[],
      readEpoch(payload.epoch),
    );
    return writeRunReceiptOnWire({ state: 'applied', runId }, { written });
  } catch (error) {
    const fenced = fencedBy(error, runId, readEpoch(payload.epoch));
    if (fenced !== null) return writeRunReceiptOnWire(fenced);
    return writeRunReceiptOnWire(hostFailureReceipt('run:append', runId, error));
  }
}

async function settleRun(api: HostRunApiV1, payload: Record<string, unknown>): Promise<unknown> {
  const runId = nonEmptyString(payload.runId);
  const terminal = readTerminal(payload.terminal);
  const metrics = readMetrics(payload.metrics);
  if (runId === null || terminal === null || (payload.metrics !== undefined && metrics === null)) {
    return writeRunReceiptOnWire(failedReceipt('invalid', runId ?? '', 'run:complete requires runId and a valid terminal/metrics pair'));
  }

  try {
    const result = await api.settleAgentRun(runId as RunId, terminal, metrics ?? undefined, readEpoch(payload.epoch));
    switch (result.state) {
      case 'applied':
        return writeRunReceiptOnWire({ state: 'applied', runId });
      case 'reconciled':
        return writeRunReceiptOnWire({ state: 'reconciled', runId, committed: result.committed });
      case 'conflict':
        return writeRunReceiptOnWire({
          state: 'conflict',
          runId,
          committed: result.committed,
          reason: `run ${runId} is durably ${result.committed.status}; this call proposed ${terminal.status}`,
        });
      case 'fenced':
        // A superseded attempt loses the terminal CAS too. It is reported as
        // `fenced` and NOT as `conflict`: nothing else decided this run's
        // history, and telling the caller another writer won would send it
        // looking for a rival that does not exist.
        return writeRunReceiptOnWire(fencedReceipt(runId, result.presented, result.current));
      case 'absent':
        return writeRunReceiptOnWire(failedReceipt('absent', runId, `run ${runId} has no row, so no terminal could be recorded`));
    }
  } catch (error) {
    const fenced = fencedBy(error, runId, readEpoch(payload.epoch));
    if (fenced !== null) return writeRunReceiptOnWire(fenced);
    return writeRunReceiptOnWire(hostFailureReceipt('run:complete', runId, error));
  }
}

/**
 * The attempt a caller presented on the wire.
 *
 * `undefined` for a caller that presented none, which is an unfenced write by
 * the caller's own choice — never a silent `0`, which would hand it the first
 * attempt's authority.
 */
function readEpoch(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) ? value : undefined;
}

/**
 * The `fenced` receipt behind a refusal, or `null` for any other error.
 *
 * The attempt fence arrives as a `409 attempt_fenced` over the Host Run API,
 * because that boundary reports a status and a code rather than an outcome
 * union. Translating it here keeps the refusal a distinct receipt state on the
 * `db:request` wire instead of a generic conflict.
 */
function fencedBy(error: unknown, runId: string, presentedEpoch: number | undefined): RunWriteReceipt | null {
  if (!(error instanceof HostRunApiError) || error.code !== 'attempt_fenced') return null;
  const presented = error.fenced?.presented ?? presentedEpoch;
  if (presented === undefined) {
    // No attempt on either side of the boundary: a refusal whose subject cannot
    // be named is reported as an unnamed claim, not as a fence with a guess. It
    // is NOT reported as `fenced` — that state asserts an attempt, and an
    // assertion this layer cannot support is the thing it must not publish.
    return { state: 'conflict', runId, reason: error.message };
  }
  return fencedReceipt(runId, presented, error.fenced?.current ?? null);
}

async function readEvents(api: HostRunApiV1, payload: Record<string, unknown>): Promise<readonly RunEventEnvelope[]> {
  const runId = nonEmptyString(payload.runId);
  if (runId === null) throw new Error('run:events requires runId');
  let afterSeq = typeof payload.afterSeq === 'number' ? payload.afterSeq : 0;
  if (!Number.isSafeInteger(afterSeq) || afterSeq < 0) throw new Error('run:events afterSeq is invalid');

  const events: RunEventEnvelope[] = [];
  for (;;) {
    const page = await api.readAgentRunEvents(runId as RunId, { afterSeq, limit: EVENT_PAGE_SIZE });
    events.push(...page);
    if (page.length < EVENT_PAGE_SIZE) return events;
    const lastSeq = page[page.length - 1]?.seq;
    if (lastSeq === undefined || lastSeq <= afterSeq) throw new Error(`run:events returned a non-advancing page for ${runId}`);
    afterSeq = lastSeq;
  }
}

function hostFailureReceipt(action: string, runId: string, error: unknown): RunWriteReceipt {
  if (error instanceof HostSessionHttpError) {
    const reason = `${error.code}: ${error.message}`;
    if (error.status === 400) return failedReceipt('invalid', runId, reason);
    if (error.status === 404) return failedReceipt('absent', runId, reason);
    if (error.status === 409) return { state: 'conflict', runId, reason };
    return failedReceipt('unavailable', runId, reason);
  }
  return failedReceipt(
    'unavailable',
    runId,
    `${action} could not reach the Host Run API: ${error instanceof Error ? error.message : String(error)}`,
  );
}

function readTerminal(value: unknown): RunTerminalState | null {
  if (!isRecord(value) || typeof value.status !== 'string') return null;
  if (value.status === 'failed') {
    if (!isRecord(value.error) || typeof value.error.code !== 'string' || typeof value.error.message !== 'string') return null;
    return value as unknown as RunTerminalState;
  }
  if (value.status === 'completed' || value.status === 'cancelled' || value.status === 'budget_exhausted') {
    return value as unknown as RunTerminalState;
  }
  return null;
}

function readMetrics(value: unknown): RunMetrics | null {
  if (!isRecord(value)) return null;
  const keys = ['eventsTotal', 'eventsDurable', 'eventsVolatile', 'eventsEphemeral', 'toolCalls', 'permissionRequests', 'wallClockMs'] as const;
  if (!keys.every((key) => typeof value[key] === 'number' && Number.isFinite(value[key]) && value[key] >= 0)) return null;
  return value as unknown as RunMetrics;
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
