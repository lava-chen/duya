import type {
  AgentRunRecord,
  AgentRunOrigin,
  CreateAgentRunInput,
  HostRunApiV1,
  RunAttemptFence,
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
 * The writer this adapter is, as named on every fence it forwards.
 *
 * Constant rather than per-caller because this hop is the durable writer even
 * when the worker's request is what triggered it, and a refusal that cannot name
 * its subject is the failure this whole fence contract is about.
 */
const CONTROL_PLANE_WRITER = 'desktop/host-run-api-adapter';

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
  const fence = readAttemptFence(payload);
  if (fence === null) return writeRunReceiptOnWire(missingFenceReceipt('run:append', runId, payload));
  try {
    const written = await api.appendAgentRunEvents(
      runId as RunId,
      payload.events as RunEventEnvelope[],
      fence,
    );
    return writeRunReceiptOnWire({ state: 'applied', runId }, { written });
  } catch (error) {
    const fenced = fencedBy(error, runId, fence.epoch);
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
  const fence = readAttemptFence(payload);
  if (fence === null) return writeRunReceiptOnWire(missingFenceReceipt('run:complete', runId, payload));

  try {
    const result = await api.settleAgentRun(runId as RunId, terminal, fence, metrics ?? undefined);
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
    const fenced = fencedBy(error, runId, fence.epoch);
    if (fenced !== null) return writeRunReceiptOnWire(fenced);
    return writeRunReceiptOnWire(hostFailureReceipt('run:complete', runId, error));
  }
}

/**
 * The attempt fence a `db:request` writer presented, or `null` when it presented
 * none.
 *
 * `null` is a REFUSAL here, not a fallback to an unfenced write. `undefined` used
 * to mean "unfenced by the caller's own choice" and it also meant "the caller
 * forgot", because both arrive as a missing `epoch` — and the second one then
 * wrote straight through the attempt fence while looking exactly like the first.
 * The two callers that legitimately have no attempt are named
 * {@link CONTROL_PLANE_WRITER}'s maintenance path, not this reader.
 *
 * `0` is never invented for a missing value either: it would hand an unfenced
 * writer the first attempt's authority.
 */
function readAttemptFence(payload: Record<string, unknown>): RunAttemptFence | null {
  const epoch = payload.epoch;
  if (typeof epoch !== 'number' || !Number.isSafeInteger(epoch) || epoch < 0) return null;
  return { epoch, writer: CONTROL_PLANE_WRITER };
}

/** The refusal a `db:request` writer gets when it presents no attempt. */
function missingFenceReceipt(action: string, runId: string, payload: Record<string, unknown>): RunWriteReceipt {
  const presented = payload.epoch === undefined ? 'no epoch' : `epoch ${String(payload.epoch)}`;
  return failedReceipt(
    'invalid',
    runId,
    `${action} from ${CONTROL_PLANE_WRITER} requires an attempt epoch (${presented}): a run write with no ` +
    'attempt is refused rather than made unfenced',
  );
}

/**
 * The `fenced` receipt behind a refusal, or `null` for any other error.
 *
 * The attempt fence arrives as a `409 attempt_fenced` over the Host Run API,
 * because that boundary reports a status and a code rather than an outcome
 * union. Translating it here keeps the refusal a distinct receipt state on the
 * `db:request` wire instead of a generic conflict — and it has to be translated
 * from BOTH shapes, because the same refusal reaches this layer as a
 * `HostRunApiError` in-process and as a `HostSessionHttpError` over HTTP. Only
 * the in-process one used to be recognised, so a fenced append across the HTTP
 * boundary was reported as a conflict and the caller went looking for a rival
 * writer that does not exist.
 */
function fencedBy(error: unknown, runId: string, presentedEpoch: number | undefined): RunWriteReceipt | null {
  const fencedPair = readFencedRefusal(error);
  if (fencedPair === null) return null;
  const presented = fencedPair.fenced?.presented ?? presentedEpoch;
  if (presented === undefined) {
    // No attempt on either side of the boundary: a refusal whose subject cannot
    // be named is reported as an unnamed claim, not as a fence with a guess. It
    // is NOT reported as `fenced` — that state asserts an attempt, and an
    // assertion this layer cannot support is the thing it must not publish.
    return { state: 'conflict', runId, reason: messageOf(error) };
  }
  return fencedReceipt(runId, presented, fencedPair.fenced?.current ?? null);
}

/** The attempt pair behind an `attempt_fenced` refusal, from either error shape. */
function readFencedRefusal(
  error: unknown,
): { readonly fenced?: { readonly presented: number; readonly current: number | null } } | null {
  if (error instanceof HostRunApiError || error instanceof HostSessionHttpError) {
    if (error.code !== 'attempt_fenced') return null;
    return { ...(error.fenced === undefined ? {} : { fenced: error.fenced }) };
  }
  return null;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
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
