/**
 * run-orchestrator.ts — the agent-server's half of the run layer.
 *
 * ## What this file is for
 *
 * The agent-server is a fork with no access to `duya-core.db`, and it is the
 * only process that sees both the host's chat request and the worker's event
 * stream. So it hosts the `RunController`, and reaches the Control Plane over
 * the existing `db:request` channel — the same one `acquireChatLock` uses
 * (`chat-runtime-lock.ts:71`).
 *
 * ## The two calls the router makes
 *
 * ```ts
 * const runId = await orchestrator.openRun(sessionId, prompt, options);  // before dispatch
 * const legacy = orchestrator.observe(runId, normalizedFrame);            // per frame
 * ```
 *
 * `openRun` is awaited BEFORE `sendCommand({type:'chat:start'})`, because a
 * run whose record does not exist yet is a run that cannot be recovered. If the
 * Control Plane refuses, the router still dispatches the chat — the product
 * keeps working, and the refusal is logged — because losing the durable run is
 * a degradation and refusing the user's message is a regression.
 *
 * `observe` is a tee: it returns the legacy frame for the router to write and
 * keeps the protocol envelope for `run_events`. The router never learns the
 * protocol, and the run layer never learns about `http.ServerResponse`.
 *
 * ## Settling
 *
 * The worker emits `chat:done` or `chat:error`, which the router turns into a
 * `done` / `error` frame. The run therefore settles when that frame is
 * observed — not when the HTTP response closes.
 *
 * Note what this host does on a client disconnect: the router's own
 * `req.on('close')` handler removes the stdout listener and calls
 * `interruptWorker` (router.ts). A run is not a connection, but neither is it
 * a process that outlives its executor: the worker really does stop, and the
 * run settles as `cancelled` rather than as a crash. Recording silence as
 * `runtime_crash` there would mean accusing the runtime of a failure this very
 * host requested.
 */

import { randomUUID } from 'node:crypto';
import {
  RunController,
  type ExecutionChannel,
  type ExecutionHandle,
  type FrameOutcome,
  type TranslateContext,
} from '@duya/agent-runtime';
// Imported from the factory module, NOT the `control-plane` barrel. The barrel
// re-exports `run-control-plane`, which pulls in `core-connection` and
// therefore better-sqlite3 and the Electron config layer — none of which
// belongs in a forked process that reaches storage over `db:request`. The type
// import is likewise a direct file import for the same reason.
import { buildRunManifest } from '../../control-plane/manifest-factory';
import type { RunIntent } from '../../control-plane/manifest-factory';
import type { ControlPlaneRequest } from '../../control-plane/run-control-plane';
import { logger } from './logger';

/** The `dbRequest` seam the router already threads through `RouterDeps`. */
type DbRequest = ControlPlaneRequest;

export interface RunOrchestratorOptions {
  readonly dbRequest: DbRequest;
  /**
   * The worker's command channel. Supplied by the router, which owns
   * `WorkerManager`; the runtime reaches the worker only through this seam, so
   * a replacement executor needs no change here.
   */
  readonly channel: ExecutionChannel;
}

/** What the router resolved for one turn, passed through `openRun`. */
export interface RunModelIdentity {
  readonly model: string;
  readonly providerId: string;
  readonly apiFormat: 'anthropic' | 'openai';
}

/** Everything the router needs back from `observe`. */
export interface ObservedFrame {
  /** What to write to the SSE stream, or `null` to write nothing. */
  readonly legacy: FrameOutcome['legacy'];
  /** True when the frame had no protocol counterpart and is forward-only. */
  readonly forwardOnly: boolean;
}

export class RunOrchestrator {
  readonly #options: RunOrchestratorOptions;
  readonly #controller: RunController;
  /**
   * One `db:request` durability call, with the failure reported where it is
   * seen. A reply this adapter cannot read and a channel that throws are both
   * diagnostics only the adapter can attach a run id to.
   */
  readonly #request: DbRequest;
  /** sessionId -> the run currently executing for it. One live run per
   *  session, which the router's own STREAMING 409 already guarantees. */
  readonly #bySession = new Map<string, string>();
  /**
   * runId -> the model identity the router resolved for that turn.
   *
   * Per-run, not a field on the orchestrator: the model changes between turns
   * and between sessions, so a single slot would attribute one turn's events to
   * whichever model ran most recently. Read out when the run settles.
   */
  readonly #modelByRun = new Map<string, RunModelIdentity>();

  constructor(options: RunOrchestratorOptions) {
    this.#options = options;
    this.#request = options.dbRequest;
    // A durable call whose CHANNEL throws is reported here and re-thrown, so a
    // failure that cannot produce a reply is as visible as one that can. The
    // runtime turns a rejected append into a `persistence_failed` terminal
    // rather than an exception, so the settle path is no longer a reliable
    // place to notice it.
    const request = async (action: string, runId: string, payload: Record<string, unknown>): Promise<unknown> => {
      try {
        return await this.#request(action, payload);
      } catch (error) {
        logger.warn(`${action} channel failed — the durable transcript is degraded`, {
          runId,
          reason: error instanceof Error ? error.message : String(error),
        });
        throw error;
      }
    };
    this.#controller = new RunController({
      channel: options.channel,
      identity: { name: 'duya-agent-server', version: RUNTIME_VERSION },
      protocol: { major: 1, minor: 0 },
      contextFor: (manifest) => this.#contextFor(manifest.runId, manifest.permissionPolicy.defaultTimeoutMs),
      // The run id is read from the manifest INSIDE this closure, not from a
      // field on the orchestrator. A field would be a single slot shared by
      // every concurrent session, so two interleaved runs would append their
      // events to each other's rows — the exact failure a per-run closure
      // makes unrepresentable.
      persistenceFor: (manifest) => {
        const runId = manifest.runId;
        return {
          append: async (envelopes) => {
            // Both Control Plane failure shapes are reported HERE rather than
            // left to the settle path, because a run that loses a batch
            // mid-stream and is then hard-killed never reaches a settle that
            // could report it. A thrown channel is re-thrown so the caller still
            // learns the batch is gone.
            const reply = await request('run:append', runId, { runId, events: envelopes });
            // The Control Plane never throws for a failed write — it answers
            // `{ ok: false, written: 0, error }` and moves on, because losing
            // one batch of a user's transcript is a degradation. That answer is
            // only useful if somebody reads it, and discarding it is what turned
            // a refused write into a silent one.
            const failure = readAck(reply, 'run:append');
            if (failure !== null) {
              reportAckLoss('run:append', runId, failure);
              throw new Error(`run:append was not acknowledged: ${failure.reason}`);
            }
          },
          complete: async (terminal, metrics) => {
            const reply = await request('run:complete', runId, { runId, terminal, metrics });
            // `{ ok: true, applied: false }` is the honest shape of a LOST CAS:
            // the write did not fail, it did not land, because another writer
            // already decided this run's history. Treating it as this call's
            // success leaves the runtime believing its terminal is the durable
            // one when it is not.
            const failure = readAck(reply, 'run:complete');
            if (failure !== null) {
              reportAckLoss('run:complete', runId, failure);
              throw new Error(`run:complete was not acknowledged: ${failure.reason}`);
            }
          },
        };
      },
    });
  }

  /**
   * Open a run for a chat turn and return its id.
   *
   * Never throws. The chat proceeds either way; the run layer is additive, and
   * a product that refuses to answer because a bookkeeping row could not be
   * written is worse than one that answers without the record.
   */
  async openRun(
    sessionId: string,
    intent: Omit<RunIntent, 'sessionId'> & { readonly apiFormat?: 'anthropic' | 'openai' },
  ): Promise<string | null> {
    const runId = randomUUID();
    try {
      if (typeof intent.model === 'string' && intent.model !== '') {
        this.#modelByRun.set(runId, {
          model: intent.model,
          providerId: intent.providerId ?? 'env',
          apiFormat: intent.apiFormat ?? 'anthropic',
        });
      }
      const built = buildRunManifest({ ...intent, sessionId, runId });
      const created = (await this.#options.dbRequest('run:create', {
        runId,
        sessionId,
        manifest: built.manifest,
        manifestHash: built.manifestHash,
        ...(intent.parentRunId === undefined ? {} : { parentRunId: intent.parentRunId }),
      })) as { ok?: boolean; error?: string } | undefined;

      if (created?.ok !== true) {
        logger.warn('Control Plane refused the run — chat proceeds without a durable record', {
          sessionId,
          runId,
          reason: created?.error ?? 'unknown',
        });
        return null;
      }

      this.#bySession.set(sessionId, runId);
      // Start the run so `run.started` is recorded with its manifest hash
      // BEFORE the worker produces anything. This is what makes a run that
      // crashes on its first frame still answerable.
      await this.#controller.start(built.manifest, {
        prompt: '',
        sessionId,
        options: {},
      });
      return runId;
    } catch (error) {
      logger.warn('openRun failed — chat proceeds without a durable record', {
        sessionId,
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  }

  /**
   * Tee one normalised worker frame.
   *
   * The router KEEPS WRITING THE FRAME IT PASSED IN. It does not write the
   * `legacy` field this returns. That is the whole mechanism behind "the UI
   * does not change": the live path forwards the exact object the renderer
   * parsed before the run layer existed, and the run layer only takes a copy.
   *
   * Writing the projected frame instead would be a subtle regression rather
   * than a no-op — the projection is lossy by construction (it is many-to-one
   * and drops fields the legacy union never declared), so routing the live
   * stream through it would quietly truncate `goal_updated`, `mode_changed`
   * and `tool_result` payloads. The projector exists for the REPLAY path, not
   * for the live one.
   *
   * @returns The projected frame and a flag, for diagnostics and for a future
   *   replay reader. The live SSE writer ignores both.
   */
  observe(sessionId: string, frame: Record<string, unknown>): ObservedFrame {
    const runId = this.#bySession.get(sessionId);
    if (runId === undefined) return { legacy: null, forwardOnly: false };

    const outcome = this.#controller.observeFrame(runId, frame);
    if (outcome.envelope !== null && (outcome.envelope.payload.type === 'run.completed' || outcome.envelope.payload.type === 'run.failed')) {
      // The run has decided. Settle asynchronously: the terminal write is a
      // round trip to the main process and the router's caller is still inside
      // a synchronous frame handler.
      void this.#controller.settle(runId).catch((error) => {
        logger.error('Run settle failed', error instanceof Error ? error : new Error(String(error)), { sessionId, runId });
      });
    }
    return { legacy: outcome.legacy, forwardOnly: outcome.forwardOnly };
  }

  /**
   * Settle a session's run on a path that produced no terminal frame.
   *
   * A response that closes with the worker still alive is not a completed run —
   * but a response that closes with the worker GONE and no terminal frame is a
   * run that ended without saying why, and `resolveRunOutcome` records that as
   * `runtime_crash`. Silence is not consent.
   */
  async settleSession(sessionId: string, opts?: { cancelRequested?: boolean }): Promise<void> {
    const runId = this.#bySession.get(sessionId);
    if (runId === undefined) return;
    this.#bySession.delete(sessionId);
    try {
      await this.#controller.settle(runId, opts);
    } catch (error) {
      logger.error('Run settle failed', error instanceof Error ? error : new Error(String(error)), { sessionId, runId });
    }
  }

  /** The live run for a session, for the cancel path. */
  runForSession(sessionId: string): string | null {
    return this.#bySession.get(sessionId) ?? null;
  }

  /**
   * The translation context for one run.
   *
   * `classify` returns `generic` on purpose. The protocol's G-2 is explicit
   * that a runtime must not infer `kind` from `toolName` and emit the result
   * as if it were classified: a derived kind is a guess that then reads as a
   * fact in a durable audit chain. There is no permission coordinator in the
   * agent today, so the honest value is the one that means "not classified".
   *
   * The model identity falls back to the manifest's own `agent` selection when
   * the router supplied none, so a run opened by a caller that only persisted a
   * manifest still emits `turn.started` events that name a real model rather
   * than an empty string.
   */
  #contextFor(runId: string, permissionTimeoutMs: number): TranslateContext {
    const resolved = this.#modelByRun.get(runId);
    return {
      messageId: `m-${runId}`,
      permission: {
        classify: () => 'generic',
        mode: 'generic',
        expiresInMs: permissionTimeoutMs,
        now: () => Date.now(),
      },
      nextTurn: (() => {
        let index = 0;
        return () => {
          index += 1;
          return { turnId: `turn-${index}`, index };
        };
      })(),
      model: resolved ?? { model: 'unknown', providerId: 'unknown', apiFormat: 'anthropic' },
    };
  }
}

/** Why a durability reply is not a success, or `null` when it is one. */
interface AckFailure {
  /** True for a write that did not fail but did not land — a lost CAS. */
  readonly lostCas: boolean;
  readonly reason: string;
}

/**
 * Read one Control Plane durability reply.
 *
 * Three outcomes mean very different things: a success, a refusal
 * (`{ ok: false, error }`), and a success that did not apply
 * (`{ ok: true, applied: false }`). Only the first is a durable write, and a
 * reply this adapter cannot read is a refusal rather than an optimistic default:
 * an unrecognised shape is not evidence that anything was written.
 */
function readAck(reply: unknown, action: string): AckFailure | null {
  if (typeof reply !== 'object' || reply === null) {
    return { lostCas: false, reason: `unrecognised ${action} reply` };
  }
  const record = reply as { ok?: unknown; error?: unknown; applied?: unknown };
  if (record.ok !== true) {
    const reason =
      typeof record.error === 'string' ? record.error : `${action} reported ok=${String(record.ok)}`;
    return { lostCas: false, reason };
  }
  // `run:append` has no CAS and reports `written` rather than `applied`; only
  // `run:complete` is a one-shot write that can be won or lost.
  if (action === 'run:complete' && record.applied !== true) {
    return { lostCas: true, reason: 'another writer already settled this run' };
  }
  return null;
}

/**
 * Log a durability reply that was not a success.
 *
 * Warned here rather than left to the settle path, because this is the only
 * place that still knows which action and which run id were refused — and a run
 * that loses a batch mid-stream and is then hard-killed never reaches a settle
 * that could report it.
 */
function reportAckLoss(action: string, runId: string, failure: AckFailure): void {
  logger.warn(
    failure.lostCas
      ? `${action} CAS lost — the durable terminal is another writer's, not this one`
      : `${action} refused — the durable transcript is degraded`,
    { runId, reason: failure.reason },
  );
}

/**
 * An execution channel that hands the run layer the worker's frames.
 *
 * The router already owns the child's stdout and already normalises every
 * frame, so this channel does not read a stream — it is told when to dispatch
 * and it forwards what the router hands it. That keeps the run layer from
 * becoming a second consumer of worker stdout, which would mean two parsers of
 * one format.
 */
export function createWorkerExecutionChannel(dispatch: (runId: string) => void): ExecutionChannel {
  return {
    async start(runId: string): Promise<ExecutionHandle> {
      // Dispatch is the router's: it owns the WorkerManager and the `chat:start`
      // command shape. The run layer only says "a run is ready to execute".
      dispatch(runId);
      return {
        stop: async () => {
          // A cooperative stop is the router's DELETE /sessions/:id/chat path.
          // The runtime never hard-kills on its own: only the host knows
          // whether a hard kill is acceptable.
        },
      };
    },
  };
}

const RUNTIME_VERSION = '0.1.0';
