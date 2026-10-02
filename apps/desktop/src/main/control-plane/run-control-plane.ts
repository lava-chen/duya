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

/** The db-bridge request shape (`chat-runtime-lock.ts:36`). */
export type ControlPlaneRequest = (
  action: string,
  payload: Record<string, unknown>,
) => Promise<unknown>;

const logger = () => getLogger();

// ── run:create ──────────────────────────────────────────────────────────

/**
 * Open a run: persist the frozen manifest and its hash, return the run id.
 *
 * Idempotent on `runId`. The agent-server mints the id before dispatching so it
 * can log and correlate, which means a retry after a lost response would
 * otherwise collide on the primary key. `INSERT OR IGNORE` plus a read-back
 * turns that retry into a no-op instead of a 500.
 */
export async function createRun(p: Record<string, unknown>): Promise<unknown> {
  const { runs } = getCoreStores();
  const runId = String(p.runId ?? '');
  const sessionId = String(p.sessionId ?? '');
  const manifest = p.manifest;
  const manifestHash = String(p.manifestHash ?? '');

  if (runId === '' || sessionId === '' || manifestHash === '' || manifest == null) {
    // Refuse rather than insert a partial row. A `runs` row with an empty
    // manifest_hash can never be verified and would poison the run's identity
    // for as long as it exists.
    return { ok: false, error: 'run:create requires runId, sessionId, manifest and manifestHash' };
  }

  try {
    runs.createRun({
      runId,
      sessionId,
      manifest,
      manifestHash,
      ...(typeof p.origin === 'string' ? { origin: p.origin as never } : {}),
      ...(typeof p.parentRunId === 'string' ? { parentRunId: p.parentRunId } : {}),
    });
  } catch (error) {
    // A duplicate on retry is success: the run exists, which is what the
    // caller asked for.
    if (isUniqueViolation(error)) {
      return { ok: true, runId, existed: true };
    }
    logger().error('run:create failed', error instanceof Error ? error : new Error(String(error)), { runId, sessionId }, LogComponent.DB);
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }

  logger().info('Run opened', { runId, sessionId, origin: p.origin }, LogComponent.DB);
  return { ok: true, runId, existed: false };
}

// ── run:append ──────────────────────────────────────────────────────────

/**
 * Append durable run events.
 *
 * Never throws. A lost batch degrades the durable transcript; aborting a user's
 * in-flight turn because one batch of events did not persist would trade a
 * partial record for a visibly broken product, and the record is the cheaper
 * loss.
 */
export async function appendRunEvents(p: Record<string, unknown>): Promise<unknown> {
  const { runs } = getCoreStores();
  const envelopes = p.events;
  if (!Array.isArray(envelopes)) {
    return { ok: false, written: 0, error: 'run:append requires an events array' };
  }

  try {
    const written = runs.appendEvents(envelopes as RunEventEnvelope[]);
    return { ok: true, written };
  } catch (error) {
    logger().warn('run:append failed — durable transcript degraded', { error: error instanceof Error ? error.message : String(error) }, LogComponent.DB);
    return { ok: false, written: 0, error: error instanceof Error ? error.message : String(error) };
  }
}

// ── run:complete ────────────────────────────────────────────────────────

/**
 * Land the run's one-shot terminal state.
 *
 * Reports whether the CAS was WON. A lost CAS is not an error to swallow: it
 * means something else already decided this run's history, and the caller
 * needs to know so it can log the race instead of assuming it recorded the
 * outcome.
 */
export async function completeRun(p: Record<string, unknown>): Promise<unknown> {
  const { runs } = getCoreStores();
  const runId = String(p.runId ?? '');
  const terminal = p.terminal as RunTerminalState | undefined;
  if (runId === '' || terminal == null || typeof terminal.status !== 'string') {
    return { ok: false, error: 'run:complete requires runId and terminal' };
  }

  try {
    const won = runs.completeRun(runId, terminal, p.metrics);
    if (!won) {
      logger().warn('Run terminal CAS lost — another writer already settled this run', { runId, attempted: terminal.status }, LogComponent.DB);
      return { ok: true, runId, applied: false };
    }
    logger().info('Run settled', { runId, status: terminal.status }, LogComponent.DB);
    return { ok: true, runId, applied: true };
  } catch (error) {
    logger().error('run:complete failed', error instanceof Error ? error : new Error(String(error)), { runId }, LogComponent.DB);
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
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
