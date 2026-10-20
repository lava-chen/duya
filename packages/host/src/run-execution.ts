/**
 * run-execution.ts — the Host-owned run execution controller.
 *
 * This is the piece that turns the standalone Host's run LEDGER into run
 * EXECUTION: a caller that reaches `HostRunExecutionApiV1` starts a run the
 * Host supervises end to end — worker dispatch, frame tee into the durable
 * ledger, terminal settlement, cancellation — without hosting any execution
 * itself.
 *
 * Composition (all pieces already existed; nothing here re-implements them):
 *
 *   startAgentRun(input)
 *     -> session defaults resolved from the Host's own stores
 *     -> WorkerManager.spawnWorker (the production supervisor, moved into Host)
 *     -> RunOrchestrator.openRun
 *          -> createWorkerExecutionChannel dispatches chat:start
 *          -> run:create / run:append / run:complete cross the LOCAL bridge
 *             (createRunControlPlaneActions over the same RunStore the ledger
 *             API serves) — no second writer, no second seq space
 *     -> worker frames come back through WorkerManager.setMessageHandler
 *          -> `run:event` lines: validated, attempt-fenced, and written to the
 *             durable ledger VERBATIM, under the seq the Runtime minted
 *          -> chat: / compact: frames
 *             -> normalizeWorkerEvent (the SAME normalizer the Desktop router
 *                uses, moved into Host)
 *             -> RunOrchestrator.observe -> live run-event tee ONLY. The
 *                reverse translation no longer persists: one `(run_id, seq)`
 *                identity must have exactly one writer.
 *
 * The Host is the ONLY durable writer, and the worker never opens a database.
 *
 * Worker `db:request` messages are served by the injected `WorkerDbBridge`.
 * The bridge is a REQUIRED member on purpose: a silently missing bridge turns
 * into 30-second worker timeouts that look like hangs. Unknown actions reject
 * with a typed error so a missing domain is discovered in one round trip.
 */

import type {
  AgentRunEventStreamQuery,
  CancelAgentRunResult,
  HostPermissionRequestApiV1,
  RunId,
  RunEventEnvelope,
  StartAgentRunInput,
  StartAgentRunResult,
  PluginAppMcpDescriptor,
  PluginAppInvocationResult,
} from '@duya/agent-protocol';
import { randomUUID } from 'node:crypto';
import type { RunRepository } from './repository-port.js';
import { RunEventConflictError, RunEpochFencedError } from '@duya/data/run-store';
import { isWorkerTranscriptMutationAction } from './worker-transcript-mutations.js';
import { createRunControlPlaneActions, type RunControlPlaneLogger } from './run-control-plane.js';
import {
  RunOrchestrator,
  createWorkerExecutionChannel,
  type NativeAppendOutcome,
  type NativeRunEventWriter,
  type RunOrchestratorLogger,
  type RunTurnIntent,
} from './run-orchestrator.js';
import { WorkerManager } from './worker-manager.js';
import { SessionState, WorkerSessionRegistry } from './worker-session-registry.js';
import { normalizeWorkerEvent } from './worker-frames.js';
import { WorkerPermissionRequests } from './worker-permission-requests.js';
import { LiveRunEventHub } from './live-run-event-hub.js';
import type { SessionServiceCaller } from './session-service.js';
import type { ChildProcess } from 'node:child_process';

/** Serves the worker's `db:request` frames from Host-owned stores. */
export interface WorkerDbBridge {
  dispatch(action: string, payload: Record<string, unknown>, caller?: SessionServiceCaller): Promise<unknown>;
}

/** Catalog inspection needs no user decision, so it can fail fast. */
const PLUGIN_APP_DESCRIBE_TIMEOUT_MS = 30_000;
/**
 * An invocation waits on a user approval card that stays valid for five
 * minutes. The Host deadline must outlast that window, otherwise a slow
 * approval reads as a timeout while the worker still runs the side effect.
 */
const PLUGIN_APP_INVOKE_TIMEOUT_MS = 330_000;

/** What the Host knows about a session before a turn, read from its own stores. */
export interface HostTurnDefaults {
  readonly workingDirectory: string;
  readonly model?: string;
  readonly providerId?: string;
  readonly apiFormat?: 'anthropic' | 'openai';
  readonly agentProfileId?: string | null;
}

/**
 * One logger shape for every composed piece. The three upstream logger ports
 * differ only in their `error` signature ordering, so the implementation adapts
 * instead of each call site casting.
 */
export interface HostRunExecutionLogger {
  debug(message: string, fields?: Record<string, unknown>): void;
  info(message: string, fields?: Record<string, unknown>): void;
  warn(message: string, fields?: Record<string, unknown>): void;
  error(message: string, error?: Error, fields?: Record<string, unknown>): void;
}

/**
 * The ledger surface this controller needs ON TOP of {@link RunRepository}: the
 * attempt fence.
 *
 * A port that only names `appendEvents(events)` cannot fence anything, because
 * a fence is a second argument. `RunStore` has always accepted it, so this
 * narrows the port rather than widening the store — and the write authority is
 * what makes "the Host is the only durable writer" enforceable instead of
 * merely stated.
 */
export interface AttemptFencedRunStore extends RunRepository {
  /** The attempt that currently holds write authority, or `null` for no run. */
  currentEpoch(runId: string): number | null;
  /** Appends under `epoch`, throwing `RunEpochFencedError` when superseded. */
  appendEvents(envelopes: readonly RunEventEnvelope[], epoch?: number): number;
}

export interface HostRunExecutionControllerOptions {
  /** The ONE durable run ledger; shared with the Host Run API (no second store). */
  readonly runs: AttemptFencedRunStore;
  /** Resolves a session's turn defaults; `null` means the session does not exist. */
  readonly sessionDefaults: (sessionId: string) => Promise<HostTurnDefaults | null>;
  /** Serves the worker's `db:request` frames. Required — see module doc. */
  readonly bridge: WorkerDbBridge;
  readonly logger: HostRunExecutionLogger;
  readonly permissionRequests?: HostPermissionRequestApiV1;
  readonly worker: {
    resolveWorkerPath(): string;
    resolveBetterSqlite3Path(): string;
    lowPower?: boolean;
  };
}

export class HostRunExecutionError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'HostRunExecutionError';
  }
}

export class HostRunExecutionController {
  readonly permissionRequests: WorkerPermissionRequests | undefined;
  readonly #options: HostRunExecutionControllerOptions;
  readonly #registry: WorkerSessionRegistry;
  readonly #workerManager: WorkerManager;
  readonly #orchestrator: RunOrchestrator;
  readonly #liveRunEvents = new LiveRunEventHub();
  readonly #nativeRunIds = new Set<string>();
  readonly #delegationBySession = new Map<string, SessionServiceCaller>();
  /** runId -> sessionId for cancellation lookups. */
  readonly #sessionByRun = new Map<string, string>();
  readonly #cancellingRuns = new Set<string>();
  readonly #pendingPluginAppRequests = new Map<string, {
    readonly sessionId: string;
    readonly runId: string;
    readonly epoch: number;
    readonly kind: 'tools' | 'result';
    readonly child: ChildProcess;
    readonly resolve: (value: unknown) => void;
    readonly reject: (error: Error) => void;
    readonly timer: ReturnType<typeof setTimeout>;
    readonly onWorkerExit: () => void;
  }>();

  constructor(options: HostRunExecutionControllerOptions) {
    this.#options = options;

    /**
     * The Host's ONE durable writer for Runtime-minted envelopes.
     *
     * Every refusal the store raises is translated into its own outcome here
     * rather than thrown at the orchestrator, because the four mean different
     * things to a caller on a stdout path: `fenced` is a superseded attempt that
     * must be DROPPED, `conflict` is two envelopes claiming one identity and
     * must be refused LOUDLY, `duplicate` is a retry that is already durable,
     * and only the last is a problem at all. `written` counts rows rather than
     * events, because the whole point is the count the store actually committed.
     */
    const nativeWriter: NativeRunEventWriter = {
      currentEpoch: (runId) => options.runs.currentEpoch(runId),
      append: (runId, envelopes, epoch): NativeAppendOutcome => {
        try {
          const written = options.runs.appendEvents(envelopes, epoch);
          return written > 0 ? { state: 'written', written } : { state: 'duplicate' };
        } catch (error) {
          if (error instanceof RunEpochFencedError) {
            return { state: 'fenced', presented: error.presented, current: error.current };
          }
          if (error instanceof RunEventConflictError) {
            return { state: 'conflict', seq: error.seq };
          }
          return {
            state: 'failed',
            reason: error instanceof Error ? error.message : String(error),
          };
        }
      },
    };

    this.#registry = new WorkerSessionRegistry(adaptRegistryLogger(options.logger));
    this.#workerManager = new WorkerManager(
      {
        getState: (sessionId) => this.#registry.getSession(sessionId)?.state,
        transitionToStreaming: (sessionId) => {
          if (this.#registry.getSession(sessionId) !== undefined) {
            this.#registry.transitionState(sessionId, SessionState.STREAMING);
          }
        },
        transitionToCrashed: (sessionId) => {
          if (this.#registry.getSession(sessionId) !== undefined) {
            this.#registry.transitionState(sessionId, SessionState.CRASHED);
          }
        },
      },
      {
        logger: adaptWorkerManagerLogger(options.logger),
        resolveWorkerPath: options.worker.resolveWorkerPath,
        resolveBetterSqlite3Path: options.worker.resolveBetterSqlite3Path,
        ...(options.worker.lowPower === undefined ? {} : { lowPower: options.worker.lowPower }),
      },
    );

    // The run Control Plane actions run IN-PROCESS over the same RunStore the
    // ledger API serves. This is the local replacement for the Desktop path's
    // `db:request` hop to Main — same actions, same receipts, no transport.
    const controlPlane = createRunControlPlaneActions({
      runs: options.runs,
      logger: adaptControlPlaneLogger(options.logger),
    });
    const localDbRequest = async (
      action: string,
      payload: Record<string, unknown>,
    ): Promise<unknown> => {
      const handled = await controlPlane.dispatchControlPlaneAction(action, payload);
      if (handled !== undefined) return handled;
      throw new Error(`Host run control plane does not handle action: ${action}`);
    };

    this.#orchestrator = new RunOrchestrator({
      dbRequest: localDbRequest,
      nativeWriter,
      logger: adaptOrchestratorLogger(options.logger),
      onEvent: (event) => {
        if (!this.#nativeRunIds.has(event.runId)) this.#liveRunEvents.publish(event);
      },
      onRunSettled: (runId) => {
        this.#liveRunEvents.close(runId as RunId);
        this.#nativeRunIds.delete(runId);
      },
      channel: createWorkerExecutionChannel({
        dispatch: (command) => {
          const parent = this.#delegationBySession.get(command.sessionId);
          if (parent) this.validateSessionCaller(parent);
          // Select the canonical stream before startup status frames can arrive.
          this.#nativeRunIds.add(command.runId);
          const sent = this.#workerManager.sendCommand(command.sessionId, { ...command });
          if (!sent) this.#nativeRunIds.delete(command.runId);
          return sent;
        },
        interrupt: (sessionId, graceMs, reason) =>
          this.#workerManager.interruptWorker(sessionId, graceMs, reason),
      }),
    });

    this.permissionRequests = options.permissionRequests === undefined ? undefined
      : new WorkerPermissionRequests(options.permissionRequests,
        (sessionId, message) => this.#workerManager.sendCommand(sessionId, message),
        (sessionId, runId) => !this.#cancellingRuns.has(runId) && this.#orchestrator.runForSession(sessionId) === runId);
    this.#workerManager.setMessageHandler((sessionId, msg, child) => {
      void this.#onWorkerMessage(sessionId, msg, child).catch((error: unknown) => {
        this.#options.logger.error('Worker event handling failed', error instanceof Error ? error : new Error(String(error)), { sessionId });
      });
    });
  }

  async startAgentRun(input: StartAgentRunInput, caller?: SessionServiceCaller): Promise<StartAgentRunResult> {
    if (caller) this.validateSessionCaller(caller);
    const sessionId = input.sessionId;
    const defaults = await this.#options.sessionDefaults(sessionId);
    if (caller) this.validateSessionCaller(caller);
    if (defaults === null) {
      return {
        accepted: false,
        stage: 'refused_no_session',
        reason: `session ${sessionId} does not exist in Host stores`,
      };
    }

    // Ensure the supervision registry and the worker process exist BEFORE the
    // dispatch, mirroring the Desktop router's ensure-worker order.
    if (this.#registry.getSession(sessionId) === undefined) {
      try {
        this.#registry.createSession(sessionId);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (!message.includes('already exists')) {
          return { accepted: false, stage: 'refused_run_open_failed', reason: message };
        }
      }
    }
    // A killed child can remain in the map until its exit event is reaped.
    // It cannot receive another chat:start, so replace it immediately.
    if (!this.#workerManager.hasWorker(sessionId) || this.#workerManager.getWorker(sessionId)?.killed) {
      try {
        const worker = this.#workerManager.spawnWorker(sessionId);
        // Standalone Host consumes events over IPC. Drain the mirrored stdout
        // pipe too, or a long turn can block the worker once that pipe fills.
        worker.stdout?.resume();
      } catch (error) {
        return {
          accepted: false,
          stage: 'refused_dispatch_failed',
          reason: `could not spawn worker: ${error instanceof Error ? error.message : String(error)}`,
        };
      }
    }

    let inheritedMaxTurns: number | undefined;
    if (caller) {
      const row = this.#options.runs.getRun(caller.runId);
      const manifest: unknown = row ? JSON.parse(row.manifest_json) : null;
      if (manifest && typeof manifest === 'object' && 'budget' in manifest &&
          manifest.budget && typeof manifest.budget === 'object' && 'maxTurns' in manifest.budget &&
          typeof manifest.budget.maxTurns === 'number' && Number.isFinite(manifest.budget.maxTurns) &&
          manifest.budget.maxTurns > 0) inheritedMaxTurns = manifest.budget.maxTurns;
    }
    const requested = input.options?.maxTurns;
    const requestedMaxTurns = typeof requested === 'number' && Number.isFinite(requested) && requested > 0
      ? requested : undefined;
    const effectiveMaxTurns = inheritedMaxTurns === undefined ? requestedMaxTurns
      : Math.min(inheritedMaxTurns, requestedMaxTurns ?? inheritedMaxTurns);
    const intent: RunTurnIntent = {
      ...(caller === undefined ? {} : { parentRunId: caller.runId }),
      ...(effectiveMaxTurns === undefined ? {} : { maxTurns: effectiveMaxTurns }),
      ...(input.workingDirectory === undefined
        ? { workingDirectory: defaults.workingDirectory }
        : { workingDirectory: input.workingDirectory }),
      ...(input.model !== undefined
        ? { model: input.model }
        : defaults.model !== undefined
          ? { model: defaults.model }
          : {}),
      ...(input.providerId !== undefined
        ? { providerId: input.providerId }
        : defaults.providerId !== undefined
          ? { providerId: defaults.providerId }
          : {}),
      ...(input.apiFormat !== undefined
        ? { apiFormat: input.apiFormat }
        : defaults.apiFormat !== undefined
          ? { apiFormat: defaults.apiFormat }
          : {}),
      // Effort has no persisted default: a session row does not carry one, so
      // an omitted override means the worker decides for this model.
      ...(input.effort === undefined ? {} : { effort: input.effort }),
      ...(defaults.agentProfileId !== undefined && defaults.agentProfileId !== null
        ? { agentProfileId: defaults.agentProfileId }
        : {}),
      ...(input.traceId === undefined ? {} : { traceId: input.traceId }),
      prompt: input.prompt,
      options: input.options ?? {},
    };

    if (caller) this.#delegationBySession.set(sessionId, caller);
    let acceptance;
    try {
      acceptance = await this.#orchestrator.openRun(sessionId, intent);
    } finally {
      if (caller && this.#delegationBySession.get(sessionId) === caller) {
        this.#delegationBySession.delete(sessionId);
      }
    }
    if (acceptance.accepted) {
      this.#sessionByRun.set(acceptance.runId, sessionId);
      this.#liveRunEvents.open(acceptance.runId as RunId);
      return { accepted: true, stage: 'dispatched', runId: acceptance.runId as RunId };
    }
    const stage = acceptance.stage;
    const wireStage: StartAgentRunResult extends never ? never : 'refused_run_open_failed' | 'refused_dispatch_failed' =
      stage === 'dispatch_refused' || stage === 'dispatch_threw'
        ? 'refused_dispatch_failed'
        : 'refused_run_open_failed';
    return {
      accepted: false,
      stage: wireStage,
      reason: acceptance.reason,
    };
  }

  async cancelAgentRun(runId: RunId, reason?: string): Promise<CancelAgentRunResult> {
    const sessionId =
      this.#sessionByRun.get(runId) ?? this.#options.runs.getRun(runId)?.session_id ?? null;
    if (sessionId === null) {
      return { requested: false, runId, reason: `run ${runId} has no session binding` };
    }
    this.#cancellingRuns.add(runId);
    let outcome;
    try {
      try {
        await this.permissionRequests?.closeSession(sessionId, runId);
      } catch (error) {
        this.#options.logger.error('Closing cancelled run approvals failed', error instanceof Error ? error : new Error(String(error)), { runId });
      }
      outcome = await this.#orchestrator.cancelRun(sessionId, runId, reason ?? 'host_run_cancel');
    } finally {
      this.#cancellingRuns.delete(runId);
    }
    if (!outcome?.requested) {
      return { requested: false, runId, reason: `run ${runId} is not live or retained by this Host` };
    }
    // The terminal travels with the acknowledgement. `cancelRun` settles the
    // run durably before it returns, so by now the terminal is a fact and not
    // a guess — and a client that has to ask again to learn how the run
    // ended is a client that can show "cancelling…" forever.
    return outcome.terminal === null
      ? { requested: true, runId }
      : { requested: true, runId, terminal: outcome.terminal };
  }

  watchLiveAgentRunEvents(
    runId: RunId,
    query: AgentRunEventStreamQuery = {},
  ): AsyncIterable<RunEventEnvelope> | null {
    return this.#liveRunEvents.watch(runId, query);
  }

  /** The supervision pieces, exposed so the owning process can shut them down. */
  get supervision(): { workerManager: WorkerManager; registry: WorkerSessionRegistry } {
    return { workerManager: this.#workerManager, registry: this.#registry };
  }

  /** A worker cannot lend its previous attempt the authority of a later run. */
  validateSessionCaller(caller: SessionServiceCaller): void {
    if (this.#cancellingRuns.has(caller.runId) ||
        this.#orchestrator.runForSession(caller.sessionId) !== caller.runId ||
        this.#options.runs.currentEpoch(caller.runId) !== caller.epoch ||
        this.#options.runs.getRun(caller.runId)?.status !== 'running') {
      throw new HostRunExecutionError(409, 'attempt_fenced', 'Session delegation attempt is no longer active.');
    }
  }

  currentSessionAttempt(sessionId: string): { readonly runId: string; readonly epoch: number } | null {
    const runId = this.#orchestrator.runForSession(sessionId);
    if (runId === null) return null;
    const epoch = this.#options.runs.currentEpoch(runId);
    if (epoch === null || this.#options.runs.getRun(runId)?.status !== 'running') return null;
    return { runId, epoch };
  }

  async isCurrentSessionAttempt(sessionId: string, runId: string, epoch: number): Promise<boolean> {
    try {
      this.validateSessionCaller({ sessionId, runId, epoch });
      return true;
    } catch {
      return false;
    }
  }

  async describePluginAppMcpTools(input: {
    sessionId: string; runId: string; epoch: number;
  }): Promise<readonly PluginAppMcpDescriptor[]> {
    return this.#requestPluginAppWorker({
      type: 'plugin-app:describe-tools',
      ...input,
    }, 'tools') as Promise<readonly PluginAppMcpDescriptor[]>;
  }

  async invokePluginAppMcpTool(input: {
    sessionId: string;
    runId: string;
    epoch: number;
    bindingId: string;
    nonce: string;
    toolId: string;
    schemaRevision: string;
    capabilityId: string;
    arguments: Record<string, unknown>;
    requestId: string;
  }): Promise<PluginAppInvocationResult> {
    return this.#requestPluginAppWorker({ type: 'plugin-app:invoke', ...input }, 'result') as Promise<PluginAppInvocationResult>;
  }

  #requestPluginAppWorker(
    command: Record<string, unknown>,
    kind: 'tools' | 'result',
  ): Promise<unknown> {
    const sessionId = command.sessionId;
    const runId = command.runId;
    const epoch = command.epoch;
    if (typeof sessionId !== 'string' || typeof runId !== 'string' ||
        typeof epoch !== 'number' || !Number.isSafeInteger(epoch)) {
      return Promise.reject(new HostRunExecutionError(400, 'invalid_plugin_app_command', 'Plugin App command is malformed.'));
    }
    const caller = { sessionId, runId, epoch };
    try { this.validateSessionCaller(caller); }
    catch (error) { return Promise.reject(error); }
    const child = this.#workerManager.getWorker(sessionId);
    if (!child || child.killed) {
      return Promise.reject(new HostRunExecutionError(409, 'worker_unavailable', 'The bound session worker is unavailable.'));
    }
    const requestId = randomUUID();
    return new Promise((resolve, reject) => {
      let onWorkerExit = (): void => undefined;
      const timer = setTimeout(() => {
        this.#pendingPluginAppRequests.delete(requestId);
        child.off('exit', onWorkerExit);
        reject(new HostRunExecutionError(504, 'plugin_app_worker_timeout', 'Plugin App worker did not respond.'));
      }, kind === 'result' ? PLUGIN_APP_INVOKE_TIMEOUT_MS : PLUGIN_APP_DESCRIBE_TIMEOUT_MS);
      onWorkerExit = (): void => {
        this.#pendingPluginAppRequests.delete(requestId);
        clearTimeout(timer);
        reject(new HostRunExecutionError(409, 'worker_unavailable', 'The bound session worker exited before answering.'));
      };
      this.#pendingPluginAppRequests.set(requestId, {
        sessionId, runId, epoch, kind, child, resolve, reject, timer, onWorkerExit,
      });
      child.once('exit', onWorkerExit);
      if (!this.#workerManager.sendCommand(sessionId, { ...command, requestId })) {
        clearTimeout(timer);
        child.off('exit', onWorkerExit);
        this.#pendingPluginAppRequests.delete(requestId);
        reject(new HostRunExecutionError(409, 'worker_unavailable', 'The Plugin App command could not be delivered.'));
      }
    });
  }

  #acceptPluginAppWorkerResponse(sessionId: string, msg: Record<string, unknown>, source: ChildProcess): boolean {
    const requestId = msg.requestId;
    if (typeof requestId !== 'string') return false;
    const pending = this.#pendingPluginAppRequests.get(requestId);
    if (!pending) return true;
    this.#pendingPluginAppRequests.delete(requestId);
    clearTimeout(pending.timer);
    pending.child.off('exit', pending.onWorkerExit);
    try {
      if (pending.sessionId !== sessionId || pending.child !== source ||
          this.#workerManager.getWorker(sessionId) !== source ||
          msg.sessionId !== sessionId || msg.runId !== pending.runId || msg.epoch !== pending.epoch ||
          msg.type !== (pending.kind === 'tools' ? 'plugin-app:tools' : 'plugin-app:result')) {
        throw new HostRunExecutionError(409, 'plugin_app_response_mismatch', 'Plugin App worker response does not match its request.');
      }
      this.validateSessionCaller({ sessionId, runId: pending.runId, epoch: pending.epoch });
      if (pending.kind === 'tools') {
        if (!Array.isArray(msg.tools)) throw new HostRunExecutionError(502, 'invalid_plugin_app_tools', 'Worker returned an invalid MCP descriptor list.');
        pending.resolve(msg.tools);
      } else {
        const result = msg.result;
        if (result === null || typeof result !== 'object' || Array.isArray(result) ||
            typeof (result as Record<string, unknown>).ok !== 'boolean') {
          throw new HostRunExecutionError(502, 'invalid_plugin_app_result', 'Worker returned an invalid invocation result.');
        }
        pending.resolve(result);
      }
    } catch (error) {
      pending.reject(error instanceof Error ? error : new Error(String(error)));
    }
    return true;
  }

  async #serveDbRequest(sessionId: string, msg: Record<string, unknown>, source: ChildProcess): Promise<void> {
    const id = typeof msg.id === 'string' ? msg.id : '';
    const worker = source;
    if (typeof msg.action !== 'string' || msg.action.length === 0) {
      worker.send({
        type: 'db:response', id, success: false, code: 'invalid_db_action',
        error: 'DB request action must be a non-empty string.',
      });
      return;
    }
    const action = msg.action;
    try {
      if (worker !== this.#workerManager.getWorker(sessionId) &&
          isWorkerTranscriptMutationAction(action)) {
        worker.send({
          type: 'db:response', id, success: false, code: 'superseded_worker',
          error: 'Transcript mutation from a superseded worker is refused.',
        });
        return;
      }
      let caller: SessionServiceCaller | undefined;
      if (action.startsWith('session:spawn')) {
        const raw = msg.execution;
        if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
          throw new HostRunExecutionError(403, 'missing_execution_context', 'Session delegation requires an execution context.');
        }
        const value = raw as Record<string, unknown>;
        if (value.sessionId !== sessionId || typeof value.runId !== 'string' ||
            !Number.isSafeInteger(value.epoch) || (value.epoch as number) < 0) {
          throw new HostRunExecutionError(403, 'invalid_execution_context', 'Session delegation context does not match its worker.');
        }
        caller = { sessionId, runId: value.runId, epoch: value.epoch as number };
        this.validateSessionCaller(caller);
      } else {
        // The worker process is bound to one session, but the run that owns it
        // is Host state. Derive the caller here so durable writes carry the
        // owning run identity without trusting the worker payload. A worker
        // serving work between runs has no live run and stays unstamped.
        const liveRunId = this.#orchestrator.runForSession(sessionId);
        const liveEpoch = liveRunId === null ? null : this.#options.runs.currentEpoch(liveRunId);
        if (liveRunId !== null && liveEpoch !== null &&
            this.#options.runs.getRun(liveRunId)?.status === 'running') {
          caller = { sessionId, runId: liveRunId, epoch: liveEpoch };
        }
      }
      const result = await this.#options.bridge.dispatch(
        action,
        (msg.payload ?? {}) as Record<string, unknown>,
        caller,
      );
      worker?.send({ type: 'db:response', id, success: true, result });
    } catch (error) {
      worker?.send({
        type: 'db:response',
        id,
        success: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  async #onWorkerMessage(sessionId: string, msg: Record<string, unknown>, source: ChildProcess): Promise<void> {
    const type = msg.type;
    if (type === 'plugin-app:tools' || type === 'plugin-app:result') {
      this.#acceptPluginAppWorkerResponse(sessionId, msg, source);
      return;
    }
    if (type === 'db:request') {
      await this.#serveDbRequest(sessionId, msg, source);
      return;
    }

    if (type === 'run:event') {
      await this.#acceptNativeRunEvent(sessionId, msg);
      return;
    }

    if (typeof type === 'string' && (type.startsWith('chat:') || type.startsWith('compact:'))) {
      if (type === 'chat:permission') {
        const request = msg.request;
        const runId = this.#orchestrator.runForSession(sessionId);
        if (runId === null || request === null || typeof request !== 'object' || Array.isArray(request)) return;
        if (this.permissionRequests === undefined) {
          this.#workerManager.sendCommand(sessionId, { type: 'permission:resolve', sessionId, id: (request as Record<string, unknown>).id, decision: 'deny' });
          this.#options.logger.warn('Worker approval responder unavailable', { sessionId, runId });
          return;
        }
        try {
          await this.permissionRequests.request(sessionId, runId, request as Record<string, unknown>);
        } catch (error) {
          this.#workerManager.sendCommand(sessionId, { type: 'permission:resolve', sessionId, id: (request as Record<string, unknown>).id, decision: 'deny' });
          throw error;
        }
      }
      const normalized = normalizeWorkerEvent(msg);
      if (normalized === null) return;
      try {
        this.#orchestrator.observe(sessionId, normalized);
        if (type === 'chat:done' || type === 'chat:error') await this.permissionRequests?.closeSession(sessionId);
      } catch {
        // observe already swallows per-frame failures; this is the backstop.
      }
    }
  }

  /**
   * Validate and persist ONE native `run:event` line.
   *
   * ## What is checked here, and what is checked one layer down
   *
   * Everything on this method is a WIRE-boundary check: this is untrusted
   * process output, and the ledger is append-only, so a malformed line must not
   * reach storage at all. The run-identity check lives in the orchestrator,
   * because the orchestrator owns the session→run binding and is the only place
   * that can answer "which run is this session executing".
   *
   * Dropped, with a line in the log, on:
   *
   *  - an `epoch` that is not a finite integer. There is no attempt to fence
   *    against, and a default would be a guess with write authority.
   *  - an `envelope` that is not an object, or whose `runId` is not a non-empty
   *    string. There is no identity to write under.
   *  - a `seq` that is not a safe integer ≥ 1. `(run_id, seq)` IS the event
   *    identity, so a fractional or negative sequence is not a retry, it is a
   *    row nobody can order.
   *  - a `payload` that is not an object with a string `type`. The store reads
   *    `payload.type` as the event type, and letting that throw inside the
   *    transaction would report a malformed message as a storage failure.
   *
   * And, one layer down, on an envelope naming a run this session is not
   * executing, on an absent writer, and on a superseded attempt.
   */
  async #acceptNativeRunEvent(sessionId: string, msg: Record<string, unknown>): Promise<void> {
    const epoch = msg.epoch;
    if (typeof epoch !== 'number' || !Number.isFinite(epoch) || !Number.isInteger(epoch)) {
      this.#options.logger.warn('dropped a native run:event with no finite integer attempt', { sessionId, epoch });
      return;
    }
    const envelope = msg.envelope;
    if (!isRecord(envelope)) {
      this.#options.logger.warn('dropped a native run:event with no envelope object', { sessionId, epoch });
      return;
    }
    const runId = envelope.runId;
    if (typeof runId !== 'string' || runId === '') {
      this.#options.logger.warn('dropped a native run:event with no runId', { sessionId, epoch });
      return;
    }
    const seq = envelope.seq;
    if (typeof seq !== 'number' || !Number.isSafeInteger(seq) || seq < 1) {
      this.#options.logger.warn('dropped a native run:event whose seq is not a safe integer >= 1', {
        sessionId,
        runId,
        seq,
        epoch,
      });
      return;
    }
    const payload = envelope.payload;
    if (!isRecord(payload) || typeof payload.type !== 'string') {
      this.#options.logger.warn('dropped a native run:event with no typed payload', { sessionId, runId, seq, epoch });
      return;
    }

    // A native worker owns the live identity as well as the durable identity.
    // Legacy frames still feed settlement but must not mint a second live seq.
    if (this.#orchestrator.runForSession(sessionId) === runId) this.#nativeRunIds.add(runId);
    const verdict = await this.#orchestrator.persistNativeRunEvent(
      sessionId,
      envelope as unknown as RunEventEnvelope,
      epoch,
    );
    if (verdict.accepted) {
      this.#liveRunEvents.publish(envelope as unknown as RunEventEnvelope);
    } else {
      this.#options.logger.warn(`dropped a native run:event — ${verdict.reason}`, {
        sessionId,
        runId,
        seq,
        epoch,
      });
    }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

// ─── Logger adapters ─────────────────────────────────────────────────────────
// The upstream ports state the same three methods with slightly different
// `error` orders. These adapters are the single place that maps OUR shape onto
// theirs, so a signature change upstream is one compile error here.

type UpstreamLogger = HostRunExecutionLogger;

function adaptRegistryLogger(logger: UpstreamLogger): {
  debug(message: string, fields?: Record<string, unknown>): void;
  info(message: string, fields?: Record<string, unknown>): void;
  warn(message: string, fields?: Record<string, unknown>): void;
  error(message: string, error?: Error, fields?: Record<string, unknown>): void;
} {
  return logger;
}

function adaptWorkerManagerLogger(logger: UpstreamLogger): {
  debug(message: string, fields?: Record<string, unknown>): void;
  info(message: string, fields?: Record<string, unknown>): void;
  warn(message: string, fields?: Record<string, unknown>): void;
  error(message: string, error?: Error, fields?: Record<string, unknown>): void;
} {
  return logger;
}

function adaptControlPlaneLogger(logger: UpstreamLogger): {
  info(message: string, context?: Record<string, unknown>): void;
  warn(message: string, context?: Record<string, unknown>): void;
  error(message: string, error: Error, context?: Record<string, unknown>): void;
} {
  return {
    info: (message, context) => logger.info(message, context),
    warn: (message, context) => logger.warn(message, context),
    error: (message, error, context) => logger.error(message, error, context),
  };
}

function adaptOrchestratorLogger(logger: UpstreamLogger): RunOrchestratorLogger {
  return {
    info: (message, data) => logger.info(message, data),
    warn: (message, data) => logger.warn(message, data),
    error: (message, error, data) => logger.error(message, error, data),
  };
}
