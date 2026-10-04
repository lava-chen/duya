/**
 * apps/desktop/src/main/automation/agent-run.ts
 *
 * Cron execution through the main agent HTTP channel — the same
 * `POST /sessions/:id/chat` endpoint the renderer chat and the gateway use.
 * A cron run is an ordinary agent session (mode='chat', source='cron') that a
 * system component kicks off by sending it a prompt; its history lives in the
 * session's rollout.
 *
 * Interactive tools stay suppressed for headless runs via the `cron` agent
 * profile deny list (AskUserQuestion / show_widget / Agent / canvas:* /
 * mode-switch) passed as `options.agentProfileId`. See Scheduler.ts history:
 * without a restrictive profile the agent falls back to the full toolset and
 * interactive tools hang forever.
 */

import * as http from 'node:http';
import { BrowserWindow } from 'electron';
import { getAgentServerPort } from '../agents/agent-server-lifecycle';
import { getCoreStores } from '../db/core-connection';
// ipcMessageToNewEvent was used by the eager cron-prompt write that plan
// 441 deleted. The import is no longer needed at runtime; kept commented
// here so the historical reference survives in case future plan work
// reintroduces an eager-write path.
// import { ipcMessageToNewEvent } from '../ipc/core-db-adapters';
import { getLogger, LogComponent } from '../logging/logger';
import { resolveCronProvider } from './provider';
import { buildCronProviderConfig } from './provider-config';
import type { CronProviderConfig } from './provider-config';
import { resolveCompactModelConfig } from './compact-config';
export type { CronProviderConfig } from './provider-config';
import { prepareAutomationWorkspace } from './workspace';
import type { AutomationCron } from './types.js';

const RUN_TIMEOUT_MS = 10 * 60_000;

export type RunOrigin = 'user' | 'agent' | 'background';

/** Type-safe knobs accepted by the Chat API `POST /sessions/:id/chat`
 *  `options` body. Kept in sync with the keys `apps/desktop/src/main/agents/server/router.ts`
 *  + the worker chat:start command consume, plus the headless-run knobs
 *  (`agentProfileId`/`llmRequestTimeoutMs`) — plan 505 Part A. */
export interface ChatRunOptions {
  agentProfileId?: string;
  runOrigin?: RunOrigin;
  wakeRun?: boolean;
  wakeless?: boolean;
  effort?: 'off' | 'low' | 'medium' | 'high' | 'max';
  llmRequestTimeoutMs?: number;
  platform?: string;
  securityScanEnabled?: boolean;
  permissionRules?: unknown;
}

/**
 * Validate a per-cron permission profile (plan 574). Anything outside the
 * session-profile vocabulary falls back to 'auto' — the hard-coded default
 * cron sessions used before per-cron profiles existed.
 */
function normalizeSessionPermissionMode(value: string | null | undefined): string {
  return value === 'default' || value === 'auto' || value === 'full_access' ? value : 'auto';
}

export interface RunPromptInSessionOptions {
  sessionId: string;
  prompt: string;
  workingDirectory: string;
  providerConfig: CronProviderConfig;
  options?: ChatRunOptions;
  timeoutMs?: number;
  onText?: (text: string) => void;
}

export interface RunPromptResult {
  output: string;
  events: Array<{ type: string; data?: unknown }>;
  /**
   * The run's `RunResult`, read back from the Control Plane after the stream
   * closed.
   *
   * This is the authority on whether the run succeeded — `output` is only the
   * text the stream happened to carry. `null` when the host does not expose
   * run results, which is reported rather than papered over: see
   * {@link readRunResult}.
   */
  run: AutomationRunResult | null;
}

/**
 * The part of the protocol's `RunResult` that automation actually reads.
 *
 * ## Why this is a local type and not `@duya/agent-protocol`'s
 *
 * Two reasons, and the second is the real one.
 *
 * The dependency is a cost. `automation` is an `electron-main` module and
 * `@duya/agent-protocol` is a separate package; importing it here adds a
 * cross-boundary edge to a module that needs three fields, and the accepted
 * `module-dependency-permitted` budget is a ratchet rather than a suggestion.
 * Contract §B also asks consumers to depend on the DTO they use rather than
 * on whole shared `types.ts` barrels.
 *
 * More importantly, the value arrives as PARSED JSON. The alternative was
 * `run as RunResult` — a cast asserting a structure nothing had checked, from
 * a body this function never inspected. A local type next to a runtime
 * narrowing is strictly more honest than the protocol type next to a blind
 * cast: the fields are validated, and a body that does not carry them is
 * reported as unreadable rather than silently believed.
 *
 * The cost is stated rather than hidden: if the protocol's terminal
 * vocabulary grows, this union has to grow with it. `RUN_RESULT_STATUSES` is
 * the single place that happens, and `runResultFailure`'s `default` arm turns
 * an unrecognised value into a failure rather than a success, so a vocabulary
 * that outruns this type degrades safely.
 */
export type AutomationRunStatus = 'completed' | 'cancelled' | 'budget_exhausted' | 'failed';

const RUN_RESULT_STATUSES: readonly AutomationRunStatus[] = [
  'completed',
  'cancelled',
  'budget_exhausted',
  'failed',
];

export interface AutomationRunResult {
  readonly runId: string;
  readonly status: AutomationRunStatus;
  readonly stopReason?: string;
  readonly error?: { readonly message?: string };
}

/**
 * Narrow a parsed run-result body to the fields above, or `null` if it is not
 * one.
 *
 * Returning `null` for an unrecognisable body is the fail-closed choice: the
 * caller treats `null` as "no receipt" and refuses the run, so a shape this
 * function cannot read becomes a refusal rather than a guess. The
 * alternative — defaulting `status` to `completed` — would turn a protocol
 * change into a silent success, which is the one outcome this whole change
 * exists to prevent.
 */
function narrowRunResult(value: unknown): AutomationRunResult | null {
  if (typeof value !== 'object' || value === null) return null;
  const record = value as Record<string, unknown>;
  const { runId, status, stopReason, error } = record;
  if (typeof runId !== 'string' || runId === '') return null;
  if (typeof status !== 'string') return null;
  if (!RUN_RESULT_STATUSES.includes(status as AutomationRunStatus)) return null;
  return {
    runId,
    status: status as AutomationRunStatus,
    ...(typeof stopReason === 'string' && stopReason !== '' ? { stopReason } : {}),
    ...(typeof error === 'object' &&
    error !== null &&
    typeof (error as { message?: unknown }).message === 'string'
      ? { error: { message: (error as { message: string }).message } }
      : {}),
  };
}

/**
 * How long the post-stream `RunResult` read may take.
 *
 * Separate from `RUN_TIMEOUT_MS` on purpose. That budget covers the TURN; this
 * one covers a single local HTTP GET issued after the turn already ended. A
 * budget that spans both would let a turn that consumed the whole allowance
 * make its own receipt unreadable, which is how a scheduler loses the verdict
 * on the runs that took longest.
 */
const RUN_RESULT_READ_TIMEOUT_MS = 15_000;

/**
 * Read the run's `RunResult` back from the agent server.
 *
 * ## Why automation reads it at all
 *
 * The stream's `done` frame is the WORKER's statement that it finished
 * emitting. The `RunResult` is the RUN LAYER's statement of how the run
 * ended. For a scheduler these are not the same claim: a turn that was
 * cancelled, stopped on a budget ceiling, or failed inside the runtime can
 * still be followed by a `done` frame, and treating that as success records a
 * successful wake for a run that did not succeed.
 *
 * ## It cannot widen the gate
 *
 * This is a read of a verdict that has already been decided. It carries no
 * permission decision, no grant and no budget of its own, so reading it cannot
 * make a tool run that the policy would have stopped — the run it describes
 * already went through the same coordinator the renderer goes through. The
 * value of reading it is the opposite of a bypass: it is how automation learns
 * that the gate said no.
 *
 * ## Absent is never success
 *
 * `null` means the host could not produce a receipt — no orchestrator wired, no
 * run for the session, or a read that failed. Contract §C requires a durable
 * consumer to refuse an unconfirmed success, so the caller treats this as a
 * failure to confirm rather than defaulting to the frame's opinion.
 */
export function readRunResult(sessionId: string): Promise<AutomationRunResult | null> {
  const port = getAgentServerPort();
  if (!port) return Promise.resolve(null);
  const requestPath = `/sessions/${encodeURIComponent(sessionId)}/run-result`;
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn();
    };
    const req = http.request(
      {
        method: 'GET',
        hostname: '127.0.0.1',
        port,
        path: requestPath,
        headers: { Accept: 'application/json' },
      },
      (res) => {
        let body = '';
        res.on('data', (chunk: Buffer) => (body += chunk.toString()));
        res.on('end', () => {
          // 501 is the honest "this host has no run layer" answer. It is not
          // an error to throw over a cron job, and it is deliberately not
          // turned into a success either.
          if (res.statusCode === 501) {
            finish(() => resolve(null));
            return;
          }
          if (res.statusCode !== 200) {
            finish(() => reject(new Error(`run result read failed: HTTP ${res.statusCode}`)));
            return;
          }
          let parsed: unknown;
          try {
            parsed = JSON.parse(body);
          } catch {
            finish(() => reject(new Error('run result read returned unparseable JSON')));
            return;
          }
          const run = (parsed as { run?: unknown } | null)?.run;
          if (run === undefined || run === null) {
            // A 200 with no run is "the run layer has nothing for this
            // session", which is a failure to confirm rather than a success.
            finish(() => resolve(null));
            return;
          }
          // Narrowed, not cast. A body that is present but unreadable is
          // treated exactly like an absent one, so the caller refuses rather
          // than believing a shape nothing checked.
          finish(() => resolve(narrowRunResult(run)));
        });
      },
    );
    const timer = setTimeout(() => {
      // Destroy the socket so the read cannot outlive its budget and hold the
      // cron worker open after the turn it was waiting on is long finished.
      req.destroy();
      finish(() => reject(new Error('run result read timed out')));
    }, RUN_RESULT_READ_TIMEOUT_MS);
    req.on('error', (e: Error) => finish(() => reject(e)));
    req.end();
  });
}

/**
 * Turn a `RunResult` into the error a caller should see, or `null` when the
 * run completed.
 *
 * The mapping is total and closed on purpose: a status this function does not
 * recognise is treated as a FAILURE, because the alternative is reporting an
 * unexamined status as a success. `budget_exhausted` and `cancelled` each get
 * their own message because "the run stopped" and "the run was stopped" are
 * different operational facts, and a scheduler that cannot tell them apart
 * retries the wrong one.
 */
function runResultFailure(run: AutomationRunResult): Error | null {
  switch (run.status) {
    case 'completed':
      return null;
    case 'cancelled':
      return new Error(`automation run ${run.runId} was cancelled${run.stopReason ? ` (${run.stopReason})` : ''}`);
    case 'budget_exhausted':
      return new Error(`automation run ${run.runId} stopped on its budget ceiling`);
    case 'failed':
      return new Error(
        `automation run ${run.runId} failed${run.error?.message ? `: ${run.error.message}` : ''}`,
      );
    default:
      // Unreachable, because `narrowRunResult` refuses a status outside the
      // union rather than admitting it. Kept so that if the protocol's
      // vocabulary ever outruns this module's, an unrecognised terminal is
      // still a failure rather than a success.
      return new Error(`automation run ${run.runId} reported an unrecognised terminal`);
  }
}

/**
 * Create the core session row for a cron run. The Agent Server rejects a chat
 * POST when the session row is missing (router 404), so this MUST run first.
 * Idempotent: reuses an existing row for the same session id (runCronNow may
 * create it eagerly so the UI can open the run view immediately).
 *
 * Also pre-inserts the cron prompt as a durable user message (deterministic
 * id → idempotent across the eager runCronNow create + runCronInSession
 * reuse). The worker's same-content duplicate check at turn start reuses this
 * row instead of inserting a second copy at turn end, so opening the run view
 * shows the task immediately and the transcript stays clean.
 */
export function createCronSessionRow(params: {
  sessionId: string;
  title: string;
  model: string;
  providerId: string;
  workingDirectory: string;
  cronId: string;
  prompt: string;
  /** Per-cron permission profile (plan 574); invalid/absent values keep the legacy 'auto'. */
  permissionMode?: string | null;
}): void {
  const { sessions, messageLog } = getCoreStores();
  const created = !sessions.get(params.sessionId);
  if (created) {
    sessions.create({
      id: params.sessionId,
      title: params.title,
      model: params.model,
      providerId: params.providerId,
      workingDirectory: params.workingDirectory,
      status: 'active',
      mode: 'chat',
      // Cron runs are headless: there is no user watching the session in
      // real time, so the profile decides whether tool approvals pause the
      // run. 'auto' (the default) trusts the workspace and routes workspace
      // escapes through the LLM classifier — same model the gateway sessions
      // use (GATEWAY_PERMISSION_PROFILE). 'default' pauses on approvals as
      // persistent cards (plan 498) the user can answer later; 'full_access'
      // skips approvals entirely. Per-cron override (plan 574).
      permissionMode: normalizeSessionPermissionMode(params.permissionMode),
      extensions: {
        source: 'cron',
        cron_job_id: params.cronId,
        system_prompt: '',
        context_summary: '',
        context_summary_updated_at: 0,
      },
    });
  }
  // Plan 441: the eager `messageLog.appendBatch` of the cron prompt was
  // deleted. The cron run is followed by a `chat:start` to the agent
  // server, which constructs a DuyaAgent that fires `user_msg_added`
  // through the Journal at the moment the user message is pushed to the
  // timeline. The cron prompt lands in the rollout at that point with
  // the same id the renderer would assign (`cron-prompt:<sessionId>`),
  // so opening the run view shows the task immediately without a
  // duplicate eager write here. See `apps/desktop/src/main/automation/Scheduler.ts`
  // for the chat:start dispatch path.
  // A cron run is created by the main process, outside any renderer action,
  // so the normal `sync:threads-changed` path (renderer → main → other
  // windows) never fires for it. Broadcast to every window so the session
  // list and sidebar cron group pick up the new run without a manual refresh.
  if (created) broadcastThreadsChanged(params.sessionId);
}

/**
 * Best-effort broadcast of `sync:threads-changed` to every renderer window.
 * The renderer handler force-syncs the session list on receipt, so a
 * scheduled run shows up in the UI while it is still executing. Swallows
 * failures (headless boot / CLI bootstrap have no windows at all).
 */
function broadcastThreadsChanged(sessionId: string): void {
  try {
    for (const window of BrowserWindow.getAllWindows()) {
      if (!window.isDestroyed()) {
        window.webContents.send('sync:threads-changed');
      }
    }
  } catch (error) {
    getLogger().warn(
      'Failed to broadcast threads-changed after cron session creation',
      { sessionId, error: error instanceof Error ? error.message : String(error) },
      LogComponent.Automation,
    );
  }
}

/**
 * POST a prompt to the main agent session and collect the streamed reply.
 * Resolves on the SSE `done` event, rejects on `error` / timeout / non-2xx.
 */
export function runPromptInSession(opts: RunPromptInSessionOptions): Promise<RunPromptResult> {
  const port = getAgentServerPort();
  if (!port) throw new Error('agent server not running');
  const timeoutMs = opts.timeoutMs ?? RUN_TIMEOUT_MS;
  const startedAt = Date.now();
  // Renderer parity: interactive runs inject `compactModelConfig` from the
  // same auxiliary.compact settings, so a configured compact (summarization)
  // model applies to wake/cron/bot runs too — not only interactive chats.
  const compactModelConfig = resolveCompactModelConfig();
  const providerConfig: CronProviderConfig = compactModelConfig
    ? { ...opts.providerConfig, compactModelConfig }
    : opts.providerConfig;
  const body = JSON.stringify({
    prompt: opts.prompt,
    providerConfig,
    workingDirectory: opts.workingDirectory,
    defaultWorkspaceDirectory: opts.workingDirectory,
    options: opts.options ?? {},
  });

  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        method: 'POST',
        hostname: '127.0.0.1',
        port,
        path: `/sessions/${encodeURIComponent(opts.sessionId)}/chat`,
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body),
          'Accept': 'text/event-stream',
        },
      },
      (res) => {
        if (res.statusCode && (res.statusCode < 200 || res.statusCode >= 300)) {
          let errBuf = '';
          res.on('data', (c: Buffer) => (errBuf += c.toString()));
          res.on('end', () => {
            reject(new Error(`agent server returned ${res.statusCode}: ${errBuf.slice(0, 200)}`));
          });
          return;
        }

        const chunks: string[] = [];
        const events: RunPromptResult['events'] = [];
        let sseBuffer = '';
        let settled = false;
        /**
         * True once the worker has said `done`.
         *
         * Separate from `settled` because the two now answer different
         * questions. `done` means "the stream is finished"; `settled` means
         * "this promise has an answer". Between them sits the `RunResult`
         * read, so the socket's own `end` — which fires moments after `done`,
         * since that is how an SSE stream closes — must no longer be read as a
         * missing terminal. Collapsing the two would reject every run in this
         * window, so the flag is kept explicit.
         */
        let doneSeen = false;
        const timeout = setTimeout(() => {
          if (settled) return;
          settled = true;
          reject(new Error('cron run timeout'));
        }, timeoutMs);
        const finish = (fn: () => void): void => {
          if (settled) return;
          settled = true;
          clearTimeout(timeout);
          fn();
        };
        /**
         * Settle with a rejection. Split from `finish` so the two failure
         * shapes stay distinguishable at the call site: `finish` guards on
         * `settled`, which is exactly the guard needed when an async read
         * resolves after some other path already answered.
         */
        const fail = (error: Error): void => finish(() => reject(error));

        res.on('data', (chunk: Buffer) => {
          sseBuffer += chunk.toString();
          const lines = sseBuffer.split('\n');
          sseBuffer = lines.pop() || '';

          for (const line of lines) {
            if (!line.startsWith('data: ')) continue;
            let event: { type?: string; data?: Record<string, unknown> };
            try {
              event = JSON.parse(line.slice(6));
            } catch {
              continue; // partial SSE frame; wait for the rest
            }
            if (!event || typeof event.type !== 'string') continue;
            events.push({ type: event.type, data: event.data });

            if (event.type === 'text') {
              const content = typeof event.data?.content === 'string' ? event.data.content : '';
              chunks.push(content);
              opts.onText?.(content);
            } else if (event.type === 'error') {
              const message = typeof event.data?.message === 'string' ? event.data.message : 'agent error';
              // The worker's error frame is reported as-is. It is a
              // statement about the TURN, and the `RunResult` is still read
              // by the run layer on its own account — this path is not where
              // the run's terminal verdict gets decided, and a caller that
              // wants that verdict reads it for a run that did not raise an
              // error frame.
              fail(new Error(message));
              return;
            } else if (event.type === 'done') {
              // The `done` frame is the WORKER saying it stopped emitting. It
              // is not the run's verdict, so it is no longer what this
              // function settles on: the stream is done, and the Control
              // Plane's `RunResult` decides the outcome.
              //
              // The outer turn timeout is cleared HERE rather than in
              // `finish`, because a long turn can legitimately consume the
              // whole `RUN_TIMEOUT_MS` and still have a readable receipt a
              // moment later. Leaving that timer armed would race this read
              // and reject a run that actually completed.
              doneSeen = true;
              clearTimeout(timeout);
              const output = chunks.join('').trim() || `completed in ${Date.now() - startedAt}ms`;
              void readRunResult(opts.sessionId).then(
                (run) => {
                  if (run === null) {
                    // No receipt. Contract §C: a durable consumer refuses an
                    // unconfirmed success, so this rejects rather than
                    // falling back to the frame's opinion.
                    fail(
                      new Error(
                        `automation run produced no RunResult, so its outcome cannot be confirmed (session ${opts.sessionId})`,
                      ),
                    );
                    return;
                  }
                  const failure = runResultFailure(run);
                  if (failure !== null) {
                    fail(failure);
                    return;
                  }
                  finish(() => resolve({ output, events, run }));
                },
                (error: unknown) => {
                  fail(error instanceof Error ? error : new Error(String(error)));
                },
              );
              return;
            }
          }
        });

        res.on('error', (e: Error) => fail(e));
        res.on('end', () => {
          // A stream that ends after `done` is the NORMAL shape of an SSE
          // response, not a truncated turn. Rejecting here would race the
          // `RunResult` read that `done` started and fail every completed run.
          if (doneSeen) return;
          fail(new Error('stream ended without done'));
        });
      },
    );

    req.on('error', (e: Error) => reject(e));
    req.write(body);
    req.end();
  });
}

/**
 * Best-effort interrupt of an in-flight session's chat (DELETE /sessions/:id/chat).
 * Used by the `replace` concurrency policy to stop a previous run.
 */
export function interruptCronSession(sessionId: string): void {
  const port = getAgentServerPort();
  if (!port) return;
  const req = http.request({
    method: 'DELETE',
    hostname: '127.0.0.1',
    port,
    path: `/sessions/${encodeURIComponent(sessionId)}/chat`,
  });
  req.on('error', () => { /* best effort: the run may already have finished */ });
  req.end();
}

/**
 * Run a cron job end-to-end: resolve provider + model, create the session row,
 * POST the prompt to the main agent channel, collect the reply.
 */
export async function runCronInSession(job: AutomationCron, sessionId: string): Promise<RunPromptResult> {
  const { provider, model } = resolveCronProvider(job.model);
  const workingDirectory = prepareAutomationWorkspace(job.workingDirectory);
  const permissionMode = normalizeSessionPermissionMode(job.permissionMode);
  // Per-cron reasoning effort (plan 574); unset/empty = legacy 'off'.
  const effort: ChatRunOptions['effort'] =
    job.effort === 'low' || job.effort === 'medium' || job.effort === 'high' || job.effort === 'max'
      ? job.effort
      : 'off';
  createCronSessionRow({
    sessionId,
    title: `[Cron] ${job.name}`,
    model,
    providerId: provider.id,
    workingDirectory,
    cronId: job.id,
    prompt: job.prompt,
    permissionMode,
  });

  getLogger().info('Cron run starting', {
    cronId: job.id,
    sessionId,
    model,
    provider: provider.id,
    effort,
    permissionMode,
    llmRequestTimeoutMs: 240_000,
  }, LogComponent.Automation);

  return runPromptInSession({
    sessionId,
    prompt: job.prompt,
    workingDirectory,
    providerConfig: buildCronProviderConfig({ provider, model }),
    options: {
      agentProfileId: 'cron',
      effort,
      llmRequestTimeoutMs: 240_000,
      runOrigin: 'background',
    },
  });
}
