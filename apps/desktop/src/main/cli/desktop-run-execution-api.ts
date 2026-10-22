/**
 * Desktop's `HostRunExecutionApiV1`.
 *
 * ## Why this is a forwarder and not a second executor
 *
 * The Desktop already runs turns through the Agent Server child process, which
 * owns the worker manager, lazy spawn, the concurrency lock and run
 * observation. The Host HTTP surface in Electron main is the process that holds
 * the database, so it is the only Host a second client (the TUI) can attach to
 * — but main must not grow an execution path of its own: two orchestrators on
 * one session would mean two workers and two run bindings.
 *
 * So `startAgentRun` is a client of the SAME entry the renderer uses
 * (`POST /sessions/:id/chat`, SSE). That entry opens the run before it writes
 * the response headers, which is what makes the run id readable immediately
 * after the POST resolves; the SSE body is then drained in the background so
 * the worker is never back-pressured by a stream nobody reads. Durable run
 * events are written by the Agent Server, so the attaching client reads them
 * from the ledger exactly as the Desktop UI does.
 *
 * ## Cancellation
 *
 * `DELETE /sessions/:id/chat` is the same stop the renderer's stop button
 * uses. Mapping the caller's run id back to its session is a ledger read; a run
 * this process no longer tracks is still cancellable while the Agent Server is
 * alive, so the map below is an optimisation for closing our own socket, never
 * the source of truth.
 */

import type {
  HostRunExecutionApiV1,
  RunId,
  StartAgentRunInput,
  StartAgentRunResult,
} from '@duya/agent-protocol';
import { getLogger } from '../logging/logger';
import { getAgentServerUrl } from '../services/agent-server-url';

export interface DesktopRunExecutionApiDeps {
  /** Base URL of the Agent Server, or `null` when it is not running. */
  resolveAgentServerOrigin?: () => Promise<string | null>;
  /** Ledger read: which session owns this run. `null` when the run is unknown. */
  getSessionForRun: (runId: RunId) => Promise<string | null>;
  /** Structured logger; the main-process one is used unless a caller injects its own. */
  log?: { debug(message: string, meta?: Record<string, unknown>): void };
}

const ACTIVE_RUN_ATTEMPTS = 20;
const ACTIVE_RUN_RETRY_MS = 25;

/**
 * The JSON body `POST /sessions/:id/chat` expects, built from the protocol's
 * start input.
 *
 * The two shapes are not the same contract: `options` is the worker's bag and
 * `providerConfig` is what the Agent Server resolves an LLM config from. Only
 * the overrides the caller actually set are forwarded — an empty
 * `providerConfig` would read as "a config was named" and suppress the
 * server's own resolution.
 */
export function buildAgentServerChatBody(input: StartAgentRunInput): Record<string, unknown> {
  const options: Record<string, unknown> = { ...(input.options ?? {}) };
  if (input.effort !== undefined) options.effort = input.effort;
  if (input.agentProfileId !== undefined) options.agentProfileId = input.agentProfileId;
  if (input.attachments !== undefined) options.files = input.attachments;

  const body: Record<string, unknown> = { prompt: input.prompt, options };
  if (input.workingDirectory !== undefined) body.workingDirectory = input.workingDirectory;

  const providerConfig: Record<string, unknown> = {};
  if (input.model !== undefined) providerConfig.model = input.model;
  if (input.providerId !== undefined) providerConfig.providerId = input.providerId;
  if (input.apiFormat !== undefined) providerConfig.providerType = input.apiFormat;
  if (Object.keys(providerConfig).length > 0) body.providerConfig = providerConfig;

  return body;
}

export function createDesktopRunExecutionApi(
  deps: DesktopRunExecutionApiDeps,
): HostRunExecutionApiV1 {
  const logger = deps.log ?? getLogger();
  const resolveOrigin = deps.resolveAgentServerOrigin ?? getAgentServerUrl;
  /** Sockets this process opened, so a cancel can close the one it owns. */
  const liveRuns = new Map<RunId, AbortController>();

  const refuse = (
    stage: Extract<StartAgentRunResult, { accepted: false }>['stage'],
    reason: string,
  ): StartAgentRunResult => ({ accepted: false, stage, reason });

  return {
    async startAgentRun(input) {
      const origin = await resolveOrigin();
      if (origin === null) {
        return refuse('refused_dispatch_failed', 'the agent server is not running');
      }

      const controller = new AbortController();
      let response: Response;
      try {
        response = await fetch(`${origin}/sessions/${encodeURIComponent(input.sessionId)}/chat`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
          body: JSON.stringify(buildAgentServerChatBody(input)),
          signal: controller.signal,
        });
      } catch (error) {
        return refuse(
          'refused_dispatch_failed',
          `the agent server is unreachable: ${error instanceof Error ? error.message : String(error)}`,
        );
      }

      if (!response.ok || response.body === null) {
        const detail = await response.text().catch(() => '');
        // A missing route means the session is not one this server can serve;
        // a busy session (409) is a failure to dispatch, not a missing one.
        const stage = response.status === 404 ? 'refused_no_session' : 'refused_dispatch_failed';
        return refuse(stage, `the agent server answered ${response.status}${detail ? `: ${detail.slice(0, 200)}` : ''}`);
      }

      const runId = await readActiveRun(origin, input.sessionId);
      if (runId === null) {
        // Nothing to drain: a turn was dispatched but nobody can name its run,
        // so the caller must not be told it started.
        controller.abort();
        return refuse('refused_run_open_failed', 'the turn was dispatched but its run id could not be read');
      }

      liveRuns.set(runId, controller);
      void drainInBackground(response, runId, liveRuns, logger);
      return { accepted: true, stage: 'dispatched', runId };
    },

    async cancelAgentRun(runId) {
      const sessionId = await deps.getSessionForRun(runId);
      if (sessionId === null) {
        return { requested: false, runId, reason: 'run not found' };
      }
      const origin = await resolveOrigin();
      if (origin === null) {
        return { requested: false, runId, reason: 'the agent server is not running' };
      }

      let response: Response;
      try {
        response = await fetch(`${origin}/sessions/${encodeURIComponent(sessionId)}/chat`, {
          method: 'DELETE',
        });
      } catch (error) {
        return {
          requested: false,
          runId,
          reason: `the agent server is unreachable: ${error instanceof Error ? error.message : String(error)}`,
        };
      }
      const payload = await response.json().catch(() => null) as { applied?: boolean } | null;
      if (!response.ok) {
        return { requested: false, runId, reason: `the agent server answered ${response.status}` };
      }
      // `applied: false` is the Agent Server saying the run had already
      // reached a terminal or was never bound — a refusal, not a stop.
      if (payload?.applied === false) {
        liveRuns.get(runId)?.abort();
        return { requested: false, runId, reason: 'the run had already ended' };
      }
      liveRuns.get(runId)?.abort();
      return { requested: true, runId };
    },
  };
}

/**
 * The run the session is executing right now.
 *
 * `openRun` has landed before the chat response headers are written, so the
 * first read normally succeeds; the retries absorb the gap between the fetch
 * resolving and the run binding becoming visible on the other side.
 */
async function readActiveRun(origin: string, sessionId: string): Promise<RunId | null> {
  for (let attempt = 0; attempt < ACTIVE_RUN_ATTEMPTS; attempt += 1) {
    try {
      const response = await fetch(`${origin}/sessions/${encodeURIComponent(sessionId)}/active-run`);
      if (response.ok) {
        const payload = await response.json() as { runId?: unknown };
        if (typeof payload.runId === 'string' && payload.runId !== '') return payload.runId;
      }
    } catch {
      return null;
    }
    await new Promise((resolve) => setTimeout(resolve, ACTIVE_RUN_RETRY_MS));
  }
  return null;
}

/**
 * Read the SSE body to the end without acting on it.
 *
 * The frames are not forwarded: the Agent Server already wrote every durable
 * event, and the attaching client reads those from the ledger. Reading is still
 * required — an unconsumed response would back-pressure the worker once its
 * socket buffer filled.
 */
async function drainInBackground(
  response: Response,
  runId: RunId,
  liveRuns: Map<RunId, AbortController>,
  logger: { debug(message: string, meta?: Record<string, unknown>): void },
): Promise<void> {
  try {
    const reader = response.body!.getReader();
    for (;;) {
      const { done } = await reader.read();
      if (done) break;
    }
  } catch (error) {
    // Aborted by a cancel, or the socket went away. Either way the turn's
    // outcome belongs to the Agent Server, not to this drain.
    logger.debug('desktop run stream closed', {
      runId,
      error: error instanceof Error ? error.message : String(error),
    });
  } finally {
    liveRuns.delete(runId);
  }
}
