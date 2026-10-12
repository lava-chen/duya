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
 *          -> normalizeWorkerEvent (the SAME normalizer the Desktop router
 *             uses, moved into Host)
 *          -> RunOrchestrator.observe -> durable run_events
 *
 * Worker `db:request` messages are served by the injected `WorkerDbBridge`.
 * The bridge is a REQUIRED member on purpose: a silently missing bridge turns
 * into 30-second worker timeouts that look like hangs. Unknown actions reject
 * with a typed error so a missing domain is discovered in one round trip.
 */

import type {
  CancelAgentRunResult,
  RunId,
  StartAgentRunInput,
  StartAgentRunResult,
} from '@duya/agent-protocol';
import type { RunRepository } from './repository-port.js';
import { createRunControlPlaneActions, type RunControlPlaneLogger } from './run-control-plane.js';
import {
  RunOrchestrator,
  createWorkerExecutionChannel,
  type RunOrchestratorLogger,
  type RunTurnIntent,
} from './run-orchestrator.js';
import { WorkerManager } from './worker-manager.js';
import { SessionState, WorkerSessionRegistry } from './worker-session-registry.js';
import { normalizeWorkerEvent } from './worker-frames.js';

/** Serves the worker's `db:request` frames from Host-owned stores. */
export interface WorkerDbBridge {
  dispatch(action: string, payload: Record<string, unknown>): Promise<unknown>;
}

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

export interface HostRunExecutionControllerOptions {
  /** The ONE durable run ledger; shared with the Host Run API (no second store). */
  readonly runs: RunRepository;
  /** Resolves a session's turn defaults; `null` means the session does not exist. */
  readonly sessionDefaults: (sessionId: string) => Promise<HostTurnDefaults | null>;
  /** Serves the worker's `db:request` frames. Required — see module doc. */
  readonly bridge: WorkerDbBridge;
  readonly logger: HostRunExecutionLogger;
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
  readonly #options: HostRunExecutionControllerOptions;
  readonly #registry: WorkerSessionRegistry;
  readonly #workerManager: WorkerManager;
  readonly #orchestrator: RunOrchestrator;
  /** runId -> sessionId for cancellation lookups. */
  readonly #sessionByRun = new Map<string, string>();

  constructor(options: HostRunExecutionControllerOptions) {
    this.#options = options;

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
      logger: adaptOrchestratorLogger(options.logger),
      channel: createWorkerExecutionChannel({
        dispatch: (command) => this.#workerManager.sendCommand(command.sessionId, { ...command }),
        interrupt: (sessionId, graceMs, reason) =>
          this.#workerManager.interruptWorker(sessionId, graceMs, reason),
      }),
    });

    this.#workerManager.setMessageHandler((sessionId, msg) => {
      void this.#onWorkerMessage(sessionId, msg);
    });
  }

  async startAgentRun(input: StartAgentRunInput): Promise<StartAgentRunResult> {
    const sessionId = input.sessionId;
    const defaults = await this.#options.sessionDefaults(sessionId);
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
    if (!this.#workerManager.hasWorker(sessionId)) {
      try {
        this.#workerManager.spawnWorker(sessionId);
      } catch (error) {
        return {
          accepted: false,
          stage: 'refused_dispatch_failed',
          reason: `could not spawn worker: ${error instanceof Error ? error.message : String(error)}`,
        };
      }
    }

    const intent: RunTurnIntent = {
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
      ...(defaults.agentProfileId !== undefined && defaults.agentProfileId !== null
        ? { agentProfileId: defaults.agentProfileId }
        : {}),
      ...(input.traceId === undefined ? {} : { traceId: input.traceId }),
      prompt: input.prompt,
      options: input.options ?? {},
    };

    const acceptance = await this.#orchestrator.openRun(sessionId, intent);
    if (acceptance.accepted) {
      this.#sessionByRun.set(acceptance.runId, sessionId);
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
    const outcome = await this.#orchestrator.cancelSession(sessionId, reason ?? 'host_run_cancel');
    if (outcome === null) {
      return { requested: false, runId, reason: `run ${runId} is not live or recently ended` };
    }
    return { requested: true, runId };
  }

  /** The supervision pieces, exposed so the owning process can shut them down. */
  get supervision(): { workerManager: WorkerManager; registry: WorkerSessionRegistry } {
    return { workerManager: this.#workerManager, registry: this.#registry };
  }

  async #serveDbRequest(sessionId: string, msg: Record<string, unknown>): Promise<void> {
    const id = msg.id as string;
    try {
      const result = await this.#options.bridge.dispatch(
        String(msg.action ?? ''),
        (msg.payload ?? {}) as Record<string, unknown>,
      );
      this.#workerManager.getWorker(sessionId)?.send({ type: 'db:response', id, success: true, result });
    } catch (error) {
      this.#workerManager.getWorker(sessionId)?.send({
        type: 'db:response',
        id,
        success: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  async #onWorkerMessage(sessionId: string, msg: Record<string, unknown>): Promise<void> {
    const type = msg.type;
    if (type === 'db:request') {
      await this.#serveDbRequest(sessionId, msg);
      return;
    }

    if (typeof type === 'string' && (type.startsWith('chat:') || type.startsWith('compact:'))) {
      const normalized = normalizeWorkerEvent(msg);
      if (normalized === null) return;
      try {
        this.#orchestrator.observe(sessionId, normalized);
      } catch {
        // observe already swallows per-frame failures; this is the backstop.
      }
    }
  }
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
