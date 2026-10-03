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
 * ## ONE entry, not two (plan 587 R2.1)
 *
 * ```ts
 * const start = await orchestrator.openRun(sessionId, turn);   // opens AND dispatches
 * const legacy = orchestrator.observe(sessionId, frame);        // per frame
 * ```
 *
 * The dispatch is inside that single entry. `openRun` hands the channel the
 * manifest, the resolved prompt and the input revision, and the channel's
 * adapter puts the canonical `runId`, the manifest hash and the revision on the
 * one `chat:start` command that begins the work. Before this, the router sent
 * `chat:start` itself with a SECOND freshly minted id on it, and nothing
 * connected the two — so a run could exist with an executor that had never been
 * told it was executing anything.
 *
 * `openRun` still never blocks the chat: a Control Plane that refuses is a
 * degradation, and a product that refuses to answer because a bookkeeping row
 * could not be written is a worse regression. What changed is that "chat
 * proceeded" comes back as an explicit `{ accepted: false, stage }` rather than
 * a bare `null` the caller could only guess about — and, crucially, a run that
 * was not accepted has NO executor behind it, because the dispatch never
 * happened.
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
import { manifestFingerprint, type RunResult, type RunTerminalState } from '@duya/agent-protocol';
import {
  ExecutionDispatchError,
  RunController,
  RunStartError,
  type ExecutionChannel,
  type ExecutionHandle,
  type FrameOutcome,
  type RunHandle,
  type RunStartAcceptance,
  type RunStartStage,
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

/**
 * Ended runs whose `RunResult` is still readable, plus every turn in flight.
 *
 * A host that wants a real `RunResult` — the non-SSE response, which has no
 * stream to read a terminal off — needs the handle the controller returned, and
 * that handle deliberately outlives the live run: `result()` is a READ that
 * never settles (contract §C). Discarding it at settle time would force the
 * host to rebuild the receipt from the terminal alone, which is a second
 * derivation of a value the runtime already decided once.
 *
 * Bounded for the same reason the controller's receipts are: remembering every
 * run forever is the leak this replaces, with more useful-looking data in it.
 */
const RETAINED_HANDLES = 64;

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

/**
 * Everything one chat turn needs to become a run.
 *
 * The prompt and the options are HERE rather than sent by the router alongside
 * the run, because they used to be a second parallel description of the same
 * turn — the double source of truth §R2.2 names. Passing them in means the
 * command that starts the work is DERIVED FROM the run, so the two cannot
 * drift apart.
 *
 * `sessionId` and `runId` are deliberately absent: the run id is minted here,
 * by the Control Plane's start entry, and the session id is the map key. A
 * caller that could supply its own run id would be a second run-identity
 * source, which is the thing R2.1 exists to remove.
 */
export type RunTurnIntent = Omit<RunIntent, 'sessionId' | 'runId'> & {
  readonly apiFormat?: 'anthropic' | 'openai';
  readonly prompt: string;
  readonly options: Readonly<Record<string, unknown>>;
};

/** Everything the router needs back from `observe`. */
export interface ObservedFrame {
  /** What to write to the SSE stream, or `null` to write nothing. */
  readonly legacy: FrameOutcome['legacy'];
  /** True when the frame had no protocol counterpart and is forward-only. */
  readonly forwardOnly: boolean;
  /**
   * True when this frame arrived for a run that has already ended.
   *
   * The router writes the frame regardless — that is the live path and it does
   * not change — so this is the only signal the host gets that the run layer
   * had already decided. A frame for a session that never opened a run is a
   * different fact and reports `false`.
   */
  readonly late: boolean;
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
  /**
   * sessionId -> the run that last ended for it.
   *
   * Only used to tell a late frame apart from a frame for a session that never
   * opened a run, which the router cannot see any other way once `#bySession`
   * has been released. One entry per SESSION, overwritten by the next run for
   * that session — so it is bounded by the conversation list rather than by
   * the number of turns, which is the distinction that matters.
   */
  readonly #endedBySession = new Map<string, string>();
  /**
   * sessionId -> the settlement currently in flight for it.
   *
   * Exists so the router's close-event backstop can WAIT for a run the `done`
   * frame already began closing, rather than returning while the terminal write
   * is still crossing the process boundary. One entry per live session, removed
   * when the settlement lands.
   */
  readonly #finishing = new Map<string, Promise<void>>();
  /**
   * runId -> the handle the controller handed back, kept so an ENDED run is
   * still answerable.
   *
   * `result()` is a read that never settles (contract §C), so the handle is the
   * only source of a real `RunResult`. The non-SSE response has no event stream
   * to read a terminal off and needs one. Bounded by `RETAINED_HANDLES`, and
   * inserted in run order so eviction drops the oldest.
   */
  readonly #handleByRun = new Map<string, RunHandle>();
  /**
   * runId -> the session that asked for it, for the window inside `openRun`.
   *
   * Exists only so `onDispatchReady` — which receives a run id, because that is
   * all the controller knows — can bind the right session before the dispatch.
   * Deleted as soon as the start resolves, so it can never hold a binding for a
   * run that ended.
   */
  readonly #pendingSessionByRun = new Map<string, string>();

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
      // Bind the session BEFORE the dispatch, which now happens inside
      // `controller.start` (plan 587 R2.1). The first frame the worker produces
      // comes back through the router's tee, which resolves a session to its run
      // through this very binding — so binding afterwards would make the first
      // frame of every turn race the map it is looked up in.
      //
      // It is NOT bound before `run.started` is durable: that was R1.2's fix for
      // a start that failed leaving the session pointing at a run with no record
      // and no place in the Control Plane. The hook is after that barrier, so
      // both properties hold.
      onDispatchReady: (runId) => {
        const sessionId = this.#pendingSessionByRun.get(runId);
        if (sessionId === undefined) return;
        this.#bySession.set(sessionId, runId);
        this.#endedBySession.delete(sessionId);
      },
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
   * Open a run for a chat turn AND dispatch it. One call, one dispatch.
   *
   * Never throws. The chat proceeds either way; the run layer is additive, and
   * a product that refuses to answer because a bookkeeping row could not be
   * written is worse than one that answers without the record.
   *
   * What it returns is the acknowledgement the contract asks for (§R2.1): an
   * explicit `accepted` flag plus, when false, WHICH of the three distinct
   * situations happened. Before this, the answer was `string | null` and the
   * caller could only learn "no run", which is precisely the ambiguity that let
   * a refused start and a started run look alike.
   *
   * One consequence is worth stating plainly: `accepted: false` now also means
   * **nothing was dispatched**. The `chat:start` command is issued from inside
   * the start, so there is no path where the executor was told to work while the
   * run layer reported that the run did not open.
   */
  async openRun(sessionId: string, intent: RunTurnIntent): Promise<RunStartAcceptance> {
    const runId = randomUUID();
    // The pending-session entry lives only for the duration of this call, and a
    // `finally` is the only thing that guarantees that: there are three exits
    // from the body below (refused row, failed start, success) and the one that
    // returns EARLY is the `run_not_created` path, which a trailing cleanup
    // after the try block would never reach. One entry per refused run, for the
    // life of the agent-server process, is the leak this map could have become.
    this.#pendingSessionByRun.set(runId, sessionId);
    try {
      if (typeof intent.model === 'string' && intent.model !== '') {
        this.#modelByRun.set(runId, {
          model: intent.model,
          providerId: intent.providerId ?? 'env',
          apiFormat: intent.apiFormat ?? 'anthropic',
        });
      }
      // `prompt` and `options` are stripped before the manifest is built: they
      // are run INPUT, not configuration. Leaving them in would mean the
      // manifest fingerprint changes whenever the user rewords a message, which
      // is the opposite of what a manifest is for.
      const { prompt: turnPrompt, options: turnOptions, ...manifestIntent } = intent;
      const built = buildRunManifest({ ...manifestIntent, sessionId, runId });
      const created = (await this.#options.dbRequest('run:create', {
        runId,
        sessionId,
        manifest: built.manifest,
        manifestHash: built.manifestHash,
        ...(intent.parentRunId === undefined ? {} : { parentRunId: intent.parentRunId }),
      })) as { ok?: boolean; error?: string } | undefined;

      if (created?.ok !== true) {
        this.#forgetRun(runId);
        const reason = created?.error ?? 'unknown';
        logger.warn('Control Plane refused the run — chat proceeds without a durable record', {
          sessionId,
          runId,
          reason,
        });
        return { accepted: false, runId: null, stage: 'run_not_created', reason };
      }

      // Start the run so `run.started` is recorded with its manifest hash
      // BEFORE the worker produces anything. This is what makes a run that
      // crashes on its first frame still answerable.
      //
      // The session is bound by `onDispatchReady`, after `run.started` is
      // durable and before the executor is told to begin. It used to be bound
      // FIRST, which meant a start that failed left the session pointing at a
      // run with no `run.started` and no place in the Control Plane — and the
      // worker's very next frame was then teed into it. Binding first is also
      // what R2.1 requires now, since the dispatch happens inside this call and
      // its first frame can arrive before `openRun` returns.
      const handle = await this.#controller.start(built.manifest, {
        prompt: turnPrompt,
        sessionId,
        options: turnOptions,
      });
      this.#retain(runId, handle);
      return { accepted: true, runId };
    } catch (error) {
      this.#forgetRun(runId);
      // The binding is released here rather than left to survive a refused
      // start: a session pointing at a run that was never dispatched is exactly
      // what R1.2 fixed, and `dispatch_refused` reaches this path now that a
      // missing worker is a refusal instead of a silently dropped command.
      if (this.#bySession.get(sessionId) === runId) {
        this.#bySession.delete(sessionId);
      }
      if (error instanceof RunStartError) {
        // `start_failed` is the code, and it is not the same incident as a
        // refused row: the row exists, the run did not open, and the executor
        // was never dispatched. Saying so is the whole value of the code.
        logger.warn(`${error.code}: the run was not dispatched — chat proceeds without a durable record`, {
          sessionId,
          runId,
          stage: error.stage,
        });
        return {
          accepted: false,
          runId,
          stage: error.stage,
          reason: describeCause(error.cause) || error.message,
        };
      }
      const reason = describeCause(error);
      logger.warn('openRun failed — chat proceeds without a durable record', {
        sessionId,
        error: reason,
      });
      return { accepted: false, runId, stage: 'unknown', reason };
    } finally {
      // The one cleanup that has to cover every exit, including the early
      // `run_not_created` return above. See the note at the top of this method.
      this.#pendingSessionByRun.delete(runId);
    }
  }

  /**
   * Keep a handle answerable after its run ends, up to the retention limit.
   *
   * `Map` preserves insertion order, so the first key is the oldest and
   * evicting it evicts the right one without a second structure.
   */
  #retain(runId: string, handle: RunHandle): void {
    this.#handleByRun.delete(runId);
    this.#handleByRun.set(runId, handle);
    while (this.#handleByRun.size > RETAINED_HANDLES) {
      const oldest = this.#handleByRun.keys().next();
      if (oldest.done === true) return;
      this.#handleByRun.delete(oldest.value);
    }
  }

  /**
   * The run's `RunResult` once it has ended, or `null` for a session that never
   * had one.
   *
   * A READ. It waits on the runtime's completion promise and never settles the
   * run, so a host can ask for the receipt after the fact without becoming
   * another thing that can end a turn.
   */
  async resultFor(sessionId: string): Promise<RunResult | null> {
    const runId = this.#bySession.get(sessionId) ?? this.#endedBySession.get(sessionId);
    if (runId === undefined) return null;
    const handle = this.#handleByRun.get(runId);
    if (handle === undefined) return null;
    return handle.result();
  }

  /**
   * Drop every trace of a run that is not going to happen.
   *
   * Called on both failure paths out of `openRun`. Leaving the model binding
   * behind would make it one more entry in a map with no delete.
   */
  #forgetRun(runId: string): void {
    this.#modelByRun.delete(runId);
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
    if (runId === undefined) {
      // No live run. Whether one ENDED here or never existed is the difference
      // between a worker that kept producing and a routing mistake, and the
      // router cannot tell them apart without asking. A settlement still in
      // flight counts as ended: the run has decided, and the receipt simply has
      // not been written yet.
      const ended = this.#endedBySession.get(sessionId);
      const late =
        this.#finishing.has(sessionId) ||
        (ended !== undefined && this.#controller.receiptFor(ended) !== null);
      if (late) {
        logger.warn('a worker frame arrived after its run had already ended', { sessionId, runId: ended });
      }
      return { legacy: null, forwardOnly: false, late };
    }

    const outcome = this.#controller.observeFrame(runId, frame);
    if (outcome.envelope !== null && (outcome.envelope.payload.type === 'run.completed' || outcome.envelope.payload.type === 'run.failed')) {
      // The run has decided. Settle asynchronously: the terminal write is a
      // round trip to the main process and the router's caller is still inside
      // a synchronous frame handler.
      void this.#finish(sessionId, runId);
    }
    return { legacy: outcome.legacy, forwardOnly: outcome.forwardOnly, late: outcome.late ?? false };
  }

  /**
   * Settle a session's run on a path that produced no terminal frame.
   *
   * A response that closes with the worker still alive is not a completed run —
   * but a response that closes with the worker GONE and no terminal frame is a
   * run that ended without saying why, and `resolveRunOutcome` records that as
   * `runtime_crash`. Silence is not consent.
   *
   * This is also the router's BACKSTOP (`res.on('close')`), and its whole job
   * is to be certain the run reached a terminal. When a `done` frame has
   * already started that work, this waits for it rather than returning while
   * the terminal write is still crossing the process boundary — which is what
   * made the close event unable to vouch for the run it was closing.
   *
   * @returns The terminal the run reached, or `null` when the session had no
   *   live run to settle. The non-SSE response needs it: it has no stream to
   *   read an outcome off, and answering "interrupted" without saying what the
   *   run recorded is the gap R2.1 closes. `null` is deliberately distinct from
   *   a terminal — "there was no run" is not "the run ended".
   */
  async settleSession(
    sessionId: string,
    opts?: { cancelRequested?: boolean },
  ): Promise<RunTerminalState | null> {
    const inFlight = this.#finishing.get(sessionId);
    if (inFlight !== undefined) {
      await inFlight;
      return this.#terminalFor(sessionId);
    }
    const runId = this.#bySession.get(sessionId);
    if (runId === undefined) return null;
    try {
      await this.#finish(sessionId, runId, opts);
    } catch (error) {
      logger.error('Run settle failed', error instanceof Error ? error : new Error(String(error)), { sessionId, runId });
    }
    return this.#terminalFor(sessionId);
  }

  /**
   * The terminal the session's run decided, live or ended.
   *
   * `controller.receiptFor` answers for ENDED runs only, so a live run is asked
   * directly. `null` means this controller has no record of a run for the
   * session at all.
   */
  #terminalFor(sessionId: string): RunTerminalState | null {
    const runId = this.#bySession.get(sessionId) ?? this.#endedBySession.get(sessionId);
    if (runId === undefined) return null;
    return this.#controller.activeRun(runId)?.terminal ?? this.#controller.receiptFor(runId);
  }

  /**
   * The ONE path a run leaves through, whichever producer asked.
   *
   * The `done` frame settles from inside `observe`, and the router's
   * `res.on('close')` backstop settles the rest. Before this, the `done` path
   * never released anything, so the session mapping and the model binding were
   * only cleaned if a close event happened to arrive afterwards — and the model
   * binding was never cleaned at all. One exit means the run layer cannot leak
   * on one path while being tidy on the other.
   */
  #finish(
    sessionId: string,
    runId: string,
    opts?: { cancelRequested?: boolean },
  ): Promise<void> {
    this.#release(sessionId, runId);
    const settling: Promise<void> = this.#controller
      .settle(runId, opts)
      // The terminal this produces is the CONTROLLER's to publish; this path
      // only has to be certain the write was attempted, so the value is dropped
      // explicitly rather than leaking into the promise's type.
      .then(() => undefined)
      .catch((error: unknown) => {
        logger.error('Run settle failed', error instanceof Error ? error : new Error(String(error)), {
          sessionId,
          runId,
        });
      })
      .finally(() => {
        if (this.#finishing.get(sessionId) === settling) this.#finishing.delete(sessionId);
      });
    this.#finishing.set(sessionId, settling);
    return settling;
  }

  #release(sessionId: string, runId: string): void {
    // Only clear the session if it still points at THIS run. A second turn can
    // have opened while the first was still settling, and clearing the newer
    // run's binding would route its frames nowhere.
    if (this.#bySession.get(sessionId) === runId) {
      this.#bySession.delete(sessionId);
      this.#endedBySession.set(sessionId, runId);
    }
    this.#modelByRun.delete(runId);
  }

  /** The live run for a session, for the cancel path. */
  runForSession(sessionId: string): string | null {
    return this.#bySession.get(sessionId) ?? null;
  }

  /**
   * Per-run model bindings still held.
   *
   * A diagnostic, and the one that catches a leak: this map is written once per
   * turn and has to be released when the run ends, so a number that only goes
   * up is a number that is wrong.
   */
  get retainedModelBindings(): number {
    return this.#modelByRun.size;
  }

  /** Sessions with a live run. Should return to zero as sessions finish. */
  get retainedSessionRuns(): number {
    return this.#bySession.size;
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

/**
 * One non-Desktop producer of agent turns, as measured.
 *
 * `ownedBy` names the slice that is expected to take it over. H8 is the
 * migration; R2.1's rule is that this PR moves Desktop chat and no one else,
 * so this list exists to make "no one else" checkable rather than assumed.
 *
 * Every `*Path` is repo-relative and EXISTSENCE-CHECKED by
 * `run-entry-registration.test.ts`. That is the whole point of separating the
 * path from the note: a note can age, but a path that stops resolving fails a
 * build instead of quietly describing a producer that moved.
 */
export interface ConsumerRegistration {
  readonly consumer: string;
  /** Repo-relative path where the turn begins. */
  readonly startPath: string;
  /** Repo-relative path where the turn is stopped, or `null` when there is none. */
  readonly stopPath: string | null;
  /** Repo-relative path where a permission decision is granted or denied. */
  readonly permissionPath: string;
  /** What it mints today, and why that is not a run identity. */
  readonly identityNote: string;
  /** How it is stopped, when `stopPath` is not self-explanatory. */
  readonly stopNote?: string;
  /** The slice that owns taking this over. */
  readonly ownedBy: string;
}

/**
 * Every agent-turn producer that is NOT Desktop chat, with its real paths.
 *
 * ## Why a constant and not a document
 *
 * A list in prose is unfalsifiable — it drifts silently, and nothing notices
 * until someone migrates a path that has since moved. Here, the paths are
 * typechecked data, and a test fails if a registered file disappears. That
 * turns "did we miss a consumer?" from a review question into a test.
 *
 * ## What is deliberately NOT here
 *
 * `packages/cli` starts no agent run at all: it is HTTP CRUD against the
 * agent-server. The plan lists CLI as a consumer, and the real headless entry is
 * `packages/agent/src/cli/index.ts`, which constructs a `DuyaAgent` directly and
 * therefore bypasses `chat:start` entirely. It is recorded below as a
 * DIVERGENCE rather than as a row, because pretending a consumer exists where
 * none does is the failure this list is meant to prevent.
 */
export const NON_DESKTOP_CONSUMERS: readonly ConsumerRegistration[] = Object.freeze([
  Object.freeze({
    consumer: 'automation (scheduler)',
    startPath: 'apps/desktop/src/main/automation/Scheduler.ts',
    stopPath: null,
    permissionPath: 'packages/agent/src/permissions/permissions.ts',
    // A runId that lives only inside a `cron:<job>:<ts>:<runId>` session id
    // string and never reaches the Control Plane's `runs` table.
    identityNote: 'mints a runId that only lives inside a session id string',
    ownedBy: 'H8',
  }),
  Object.freeze({
    // A `workflowRunId` written to a DIFFERENT table. Contract §B: stored
    // alongside run identity, never mixed with it.
    consumer: 'workflow agent runtime',
    startPath: 'apps/desktop/src/main/agents/server/workflow-runtime-manager.ts',
    stopPath: 'apps/desktop/src/main/agents/server/workflow-runtime-manager.ts',
    stopNote: 'workflow:cancel on the child stdin, then SIGTERM',
    permissionPath: 'packages/agent/src/permissions/permissions.ts',
    identityNote: 'mints a workflowRunId into its own table, not `runs`',
    ownedBy: 'H8',
  }),
  Object.freeze({
    // `taskId` / `subAgentSessionId`, not a run id. The child's cancel handle
    // is the only stop, and `subagent:kill` reaches it.
    consumer: 'sub-agent tool',
    startPath: 'packages/agent/src/tool/SubagentTool/SubagentTool.ts',
    stopPath: 'packages/agent/src/process/agent-process-entry.ts',
    stopNote: 'subagent:kill reaches the child lifecycle controller',
    permissionPath: 'packages/agent/src/permissions/permissions.ts',
    identityNote: 'mints taskId / subAgentSessionId, which are not run ids',
    ownedBy: 'H8',
  }),
]);

/**
 * Where the plan and the repository disagree, recorded rather than papered over.
 *
 * `packages/cli` is listed by plan 587 §R2.1 as a consumer of the single run
 * entry. It is not one: it exposes HTTP CRUD and never constructs an agent run.
 * The headless path that DOES construct one is
 * `packages/agent/src/cli/index.ts`, which builds a `DuyaAgent` directly and so
 * never passes through `chat:start` — it cannot be brought under this boundary
 * by the Desktop adapter at all, and needs its own decision.
 *
 * Recorded here so the next slice inherits the finding instead of
 * rediscovering it, and so nobody reports the CLI as migrated on the strength
 * of a Desktop-only change.
 */
export const RUN_ENTRY_DIVERGENCES: readonly { readonly claim: string; readonly reality: string }[] =
  Object.freeze([
    Object.freeze({
      claim: 'plan 587 §R2.1 lists packages/cli as a consumer of the single run entry',
      reality:
        'packages/cli starts no agent run (HTTP CRUD only); the headless entry is ' +
        'packages/agent/src/cli/index.ts, which constructs DuyaAgent directly and ' +
        'never passes through chat:start. It needs its own R2 slice.',
    }),
  ]);

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
 * A cause, as one diagnostic line.
 *
 * The `reason` on a `not accepted` acknowledgement is read by an operator
 * deciding what to do next, so it gets the underlying message rather than the
 * wrapper's — `RunStartError`'s own message is the same sentence for every
 * stage, which is exactly the text that tells you nothing.
 */
function describeCause(cause: unknown): string {
  if (cause === undefined || cause === null) return '';
  if (cause instanceof Error) return cause.message;
  if (typeof cause === 'string') return cause;
  return String(cause);
}


/**
 * The one command that begins a chat turn, as the worker sees it.
 *
 * Everything on this object is derived from the run: the `runId` is the
 * canonical one the Control Plane minted, `manifestHash` is the reference to the
 * frozen configuration, and `inputRevision` identifies the exact prompt and
 * options this run was opened with. The executor therefore cannot end up with a
 * second identity, and a run row that says one thing cannot be contradicted by
 * the command that produced it.
 *
 * `id` stays a TURN id, not a run id. `agent-process-entry` threads it as
 * `ChatOptions.turnId` (journal emits, `message_index.turn_id`, turn review)
 * and a run spans one `chat:start`, but the concepts are different: a run is
 * the unit the Control Plane records a terminal for, a turn is the unit the UI
 * groups messages into. Reusing one id for both is how the two got confused in
 * the first place. It is NOT re-minted per run and NOT the canonical id — it is
 * a third thing, correctly named.
 */
export interface ChatStartCommand {
  readonly type: 'chat:start';
  readonly sessionId: string;
  /** Turn id. See above. */
  readonly id: string;
  /** The canonical run id, minted by the Control Plane's start entry. */
  readonly runId: string;
  /** Reference to the frozen manifest: its sha256 fingerprint. */
  readonly manifestHash: string;
  /** Digest of this turn's prompt and options. */
  readonly inputRevision: string;
  readonly prompt: string;
  readonly options: Readonly<Record<string, unknown>>;
}

/**
 * What the host must be able to do for the adapter to dispatch.
 *
 * `dispatch` REPORTS whether the command reached the worker. That boolean is
 * the whole of R2.1's "no fake running run" guarantee at this seam: a `false`
 * means there is no worker to run this on, and the adapter turns it into a
 * refusal so the run is closed with a terminal instead of left looking live.
 * Ignoring it is exactly what the router used to do.
 *
 * Expressed as an OBJECT rather than a callable with a property, because
 * `interrupt` is not optional and a positional second argument is the kind of
 * thing that silently binds to the wrong function when a call site is edited.
 *
 * `interrupt` is deliberately required rather than optional. The Desktop host
 * already has exactly one stop path (`WorkerManager.interruptWorker`, used by
 * the SSE disconnect handler, the DELETE route, and the agent-process pool), and
 * R2.1's job is to bind the runtime's declared `stop` to it — not to add a
 * second one. An optional `stop` is how the previous empty no-op happened.
 */
export interface WorkerExecutionBinding {
  /** Send one `chat:start`. Returns false when no worker accepted it. */
  readonly dispatch: (command: ChatStartCommand) => boolean;
  /** The host's existing single worker-stop function. */
  readonly interrupt: (sessionId: string, graceMs: number, reason: string) => boolean;
}


/** Why the adapter says the run was not dispatched. */
function refused(reason: string): ExecutionDispatchError {
  return new ExecutionDispatchError(reason);
}

/**
 * The execution channel from the run layer to the legacy worker command.
 *
 * ## It dispatches; it does not stream
 *
 * The router already owns the child's stdout and already normalises every frame,
 * so this adapter does not read a stream — the runtime pushes frames into
 * `observeFrame` through the router's tee. That keeps the run layer from
 * becoming a second consumer of worker stdout, which would mean two parsers of
 * one format.
 *
 * ## `stop` is the host's existing interrupt, not a new one
 *
 * See {@link WorkerDispatch.interrupt}. The runtime never escalates to a hard
 * kill and never clears the worker's command queue: a grace deadline that ends
 * in a platform kill, and a double-press that pops a queued turn, are R2.3's
 * `ExecutionHandle.stop` work. What R2.1 fixes here is the opposite problem —
 * `stop` used to be an empty function, so `RunController.cancel` returned
 * `{ applied: true }` for a stop that had touched nothing at all, which is the
 * one field a host reads to know its stop did something.
 */
export function createWorkerExecutionChannel(binding: WorkerExecutionBinding): ExecutionChannel {
  return {
    async start(manifest, input): Promise<ExecutionHandle> {
      const command: ChatStartCommand = {
        type: 'chat:start',
        sessionId: input.sessionId,
        // A turn id, and a fresh one per turn. Deliberately NOT the run id:
        // see `ChatStartCommand`.
        id: randomUUID(),
        runId: manifest.runId,
        manifestHash: manifestFingerprint(manifest),
        inputRevision: input.revision,
        prompt: input.prompt,
        options: input.options,
      };
      if (!binding.dispatch(command)) {
        throw refused(`no worker accepted chat:start for session ${input.sessionId}`);
      }
      return {
        stop: async (graceMs: number) => {
          // The one existing host interrupt. `applied` is reported by the host
          // itself; the runtime re-reads the run's closed flag afterwards, so a
          // worker that finished inside the window is still reported as
          // `applied: false` rather than as a stop that landed.
          binding.interrupt(input.sessionId, graceMs, 'run-cancel');
        },
      };
    },
  };
}

const RUNTIME_VERSION = '0.1.0';
