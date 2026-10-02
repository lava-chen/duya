/**
 * `RunController` — the `AgentRuntimeApi` implementation, and the tee the
 * agent-server's chat path hangs its run on.
 *
 * ## What this class is responsible for
 *
 * Run identity and nothing else. Given a manifest the Control Plane has already
 * frozen, it opens exactly one `RunSession`, drives an execution through the
 * `ExecutionChannel`, translates every frame into a protocol event, mints the
 * run-scoped `seq`, and settles the run once.
 *
 * Deliberately NOT responsible for:
 *
 *  - **Building the manifest.** That is the Control Plane's. A runtime that
 *    assembled its own manifest could not be checked against one, and the
 *    fingerprint that makes resume verifiable would be self-certified.
 *  - **Deciding how a run ends.** `resolveRunOutcome` in `@duya/agent-core`
 *    owns that, so the rules cannot drift between the layer that executes and
 *    the layer that records.
 *  - **Storing anything.** `RunPersistence` is supplied by the Control Plane.
 *
 * ## Why `observeFrame` is public
 *
 * The agent-server already normalises every worker frame
 * (`normalizeWorkerEvent`, router.ts:450) and already writes it to the SSE
 * response. Rather than re-plumb that path, the router TEES it: the frame goes
 * to `observeFrame`, which returns the protocol envelope AND the legacy frame
 * the renderer expects. One source, two consumers.
 *
 * That is also why `observeFrame` returns the legacy frame instead of the
 * controller writing to the response. The router keeps ownership of the HTTP
 * response — a run layer that wrote to `http.ServerResponse` would be a run
 * layer that could only ever be used by HTTP.
 */

import type {
  AgentRuntimeApi,
  CancelOutcome,
  EventSource,
  EventType,
  ProtocolVersion,
  RunEvent,
  RunEventEnvelope,
  RunHandle,
  RunManifest,
  RunResult,
  RunTerminalState,
  RuntimeCapabilities,
  StartOptions,
} from '@duya/agent-protocol';
import { DEFAULT_LIMITS, EVENT_REGISTRY, manifestFingerprint } from '@duya/agent-protocol';
import { LifecycleViolation } from '@duya/agent-protocol/testing';
import { RunEventStream, RunSession, type RunPersistence } from './run-session.js';
import { projectToLegacyFrame } from './project/legacy-sse-projector.js';
import type { LegacySseFrame } from './legacy-sse-contract.js';
import { translateFrame, type RawFrame, type TranslateContext } from './translate/chat-event-translator.js';
import type { ExecutionChannel, ExecutionHandle } from './transport/execution-channel.js';

/** The runtime's own identity, as advertised in its `ready` frame. */
export interface RuntimeIdentity {
  readonly name: string;
  readonly version: string;
  readonly pid?: number;
}

export interface RunControllerOptions {
  readonly channel: ExecutionChannel;
  readonly identity: RuntimeIdentity;
  readonly protocol: ProtocolVersion;
  /**
   * Build the translation context for a run.
   *
   * A callback rather than a value because the context carries a clock, a turn
   * counter and a permission classifier, and the Control Plane is the component
   * that knows all three. Passing it per run also keeps the controller
   * stateless between runs, which is what makes concurrent sessions in one
   * process safe.
   */
  readonly contextFor: (manifest: RunManifest) => TranslateContext;
  readonly persistenceFor: (manifest: RunManifest) => RunPersistence;
  readonly now?: () => number;
  readonly clock?: () => number;
  /** Grace window handed to a cooperative stop, in ms. */
  readonly cancelGraceMs?: number;
}

/** What the caller learns about one observed frame. */
export interface FrameOutcome {
  /** The legacy frame to forward, or `null` when the event has no legacy form. */
  readonly legacy: LegacySseFrame | null;
  /** The protocol envelope, when the frame produced one. */
  readonly envelope: RunEventEnvelope | null;
  /** True when the frame had no protocol counterpart and is forward-only. */
  readonly forwardOnly: boolean;
  /** True when the frame was an internal control-plane frame and was dropped. */
  readonly internal: boolean;
  /** Present when the frame broke a run invariant. */
  readonly violation?: string;
}

interface ActiveRun {
  readonly manifest: RunManifest;
  readonly session: RunSession;
  readonly stream: RunEventStream;
  readonly translateCtx: TranslateContext;
  handle: ExecutionHandle | null;
  cancelRequested: boolean;
  settling: Promise<void> | null;
}

export class RunController implements AgentRuntimeApi {
  readonly capabilities: RuntimeCapabilities;

  readonly #options: RunControllerOptions;
  readonly #runs = new Map<string, ActiveRun>();

  constructor(options: RunControllerOptions) {
    this.#options = options;
    const { identity, protocol } = options;
    this.capabilities = {
      protocol,
      runtime: { name: identity.name, version: identity.version },
      run: {
        resume: { turnBoundary: false, eventSeq: false, messageIndex: false, checkpointGeneration: false, oldestAvailableSeq: 0, latestSeq: 0, rejectsMidToolResume: true },
        cancel: 'cooperative',
        graceMs: options.cancelGraceMs ?? 5000,
        pause: false,
        deterministic: false,
        // The honest advertisement: this runtime has no permission timer.
        // Claiming one would be lying, and `permission_expiry` is gated on a
        // host capability precisely so a host is never told about a deadline
        // nobody enforces.
        permissionExpiryClock: 'absent',
      },
      events: {
        oldestAvailableSeq: 0,
        latestSeq: 0,
        durable: [...EVENT_REGISTRY.durable],
        volatile: [...EVENT_REGISTRY.volatile],
        ephemeral: [...EVENT_REGISTRY.ephemeral],
      },
      permissions: {
        actions: ['allow', 'allow_always', 'deny', 'defer'],
        defaultTimeoutMs: 300_000,
        maxTimeoutMs: 600_000,
      },
      catalog: { profiles: [], modes: [], tools: [], connectorProviders: [] },
      transports: ['in-process', 'subprocess'],
      limits: DEFAULT_LIMITS,
      eventTypes: [...EVENT_REGISTRY.all],
    };
  }

  /**
   * The manifest fingerprint a host should record.
   *
   * Exposed statically so the Control Plane can compute and store the hash
   * BEFORE the run exists, and compare it when the run settles. A hash only
   * proves anything if it was pinned before the fact.
   */
  static fingerprint(manifest: RunManifest): string {
    return manifestFingerprint(manifest);
  }

  async start(
    manifest: RunManifest,
    input: { readonly prompt: string; readonly sessionId: string; readonly options?: Readonly<Record<string, unknown>> },
    _opts?: StartOptions,
  ): Promise<RunHandle> {
    const now = this.#options.now ?? Date.now;
    const clock = this.#options.clock ?? Date.now;
    const runId = manifest.runId;

    const session = new RunSession({
      runId,
      sessionId: input.sessionId,
      now,
      startedAt: clock(),
      clock,
      persistence: this.#options.persistenceFor(manifest),
    });

    // `run.started` is emitted BEFORE the execution is dispatched, not after.
    // The event carries the manifest hash, and its whole purpose is to make
    // "what was this run given?" answerable for a run that crashed one
    // millisecond later. A run whose first event is a consequence of its
    // second cannot answer that.
    const startedEnvelope = session.observe({
      type: 'run.started',
      manifestHash: manifestFingerprint(manifest),
      protocol: this.#options.protocol,
      runtime: this.#options.identity,
    });

    const active: ActiveRun = {
      manifest,
      session,
      stream: new RunEventStream(),
      translateCtx: this.#options.contextFor(manifest),
      handle: null,
      cancelRequested: false,
      settling: null,
    };
    this.#runs.set(runId, active);
    active.stream.push(startedEnvelope);

    // AWAIT the first flush before returning. `observe` records
    // `run.started` immediately rather than behind the batch — and that flush
    // is a floating promise by design, because observing a frame must never
    // block on a cross-process write. But `start` is the one place where the
    // caller is explicitly asking "is this run open yet?", and the host
    // dispatches the execution the moment it returns. Without this await,
    // "recorded before the first frame" would be a race the run layer lost
    // about half the time.
    await session.flush();

    const handle = await this.#options.channel.start(
      runId,
      input.sessionId,
      { prompt: input.prompt, options: input.options ?? {} },
      {
        frame: (raw) => {
          this.observeFrame(runId, raw);
        },
        envelope: (envelope) => {
          active.stream.push(envelope);
        },
        end: () => {
          void this.settle(runId);
        },
      },
    );
    active.handle = handle;

    return this.#handleFor(active);
  }

  /**
   * Not implemented in this slice, and it says so.
   *
   * `resume` needs a replay window and a verifiable manifest match, and the
   * Reference Run establishes the durable log that both read from. A resume
   * that accepted a manifest without comparing fingerprints would be the
   * "silently different run" failure the protocol was written to prevent, so
   * the honest state is "not yet" rather than a resume that does not check.
   */
  async resume(): Promise<RunHandle> {
    throw new Error(
      'run.resume is not implemented: the Reference Run establishes the durable run log; ' +
        'resume lands once a replay window and a manifest fingerprint check are in place.',
    );
  }

  async probe(): Promise<RuntimeCapabilities> {
    return this.capabilities;
  }

  /** The live run for an id, if any. The router resolves a session to its run
   *  through this while a chat turn is in flight. */
  activeRun(runId: string): RunSession | undefined {
    return this.#runs.get(runId)?.session;
  }

  /**
   * Observe one raw frame from the executor.
   *
   * Returns what the caller should forward and what the run recorded. Never
   * throws for a malformed frame: a bad frame is a fact about the stream, and
   * a run that dies because one frame was malformed would be a run that never
   * records what actually went wrong.
   */
  observeFrame(runId: string, raw: RawFrame): FrameOutcome {
    const active = this.#runs.get(runId);
    if (active === undefined) {
      return { legacy: null, envelope: null, forwardOnly: false, internal: false };
    }

    const translated = translateFrame(raw, active.translateCtx);
    if (!translated.ok) {
      const internal = translated.reason === 'internal';
      return { legacy: null, envelope: null, forwardOnly: !internal, internal };
    }

    try {
      const envelope = active.session.observe(translated.event);
      active.stream.push(envelope);
      return { legacy: projectToLegacyFrame(envelope), envelope, forwardOnly: false, internal: false };
    } catch (error) {
      if (!(error instanceof LifecycleViolation)) throw error;
      return this.#onLifecycleViolation(active, error);
    }
  }

  /**
   * Settle a run.
   *
   * Idempotent: a second call returns the first decision. A caller that
   * settles twice has a bug, and the correct behaviour is to leave the recorded
   * history alone.
   */
  async settle(
    runId: string,
    intent?: { cancelRequested?: boolean; escalated?: boolean },
  ): Promise<RunTerminalState> {
    const active = this.#runs.get(runId);
    if (active === undefined) {
      return { status: 'completed' };
    }
    if (active.settling !== null) {
      await active.settling;
      return active.session.terminal ?? { status: 'completed' };
    }

    active.settling = (async () => {
      const merged =
        intent === undefined
          ? active.cancelRequested
            ? { cancelRequested: true }
            : undefined
          : { ...intent, ...(active.cancelRequested ? { cancelRequested: true } : {}) };
      await active.session.settle(merged);
      active.stream.close();
    })();

    await active.settling;
    this.#runs.delete(runId);
    return active.session.terminal ?? { status: 'completed' };
  }

  /**
   * Cancel a run.
   *
   * Returns `{ applied: false }` when the run was already terminal, and does
   * nothing in that case. That is the improvement over `handleDeleteChat`
   * (router.ts:1670), which hard-migrates `STREAMING -> COMPLETED` in the DB
   * BEFORE the worker acks and returns `{ ok: true, interrupted }` — so a host
   * today cannot distinguish "I cancelled this" from "it had already ended".
   */
  async cancel(runId: string): Promise<CancelOutcome> {
    const active = this.#runs.get(runId);
    if (active === undefined || active.session.isClosed) {
      return { applied: false, terminal: { status: 'completed' } };
    }
    active.cancelRequested = true;
    await active.handle?.stop(this.#options.cancelGraceMs ?? 5000);
    const terminal = await this.settle(runId, { cancelRequested: true });
    return { applied: true, terminal };
  }

  /**
   * Turn a lifecycle violation into the run's terminal state.
   *
   * Deliberately not re-thrown. The ledger throws because continuing to
   * interpret a broken stream produces confidently wrong derived state — and
   * the right response is to STOP interpreting it, which settling does. The
   * violation is preserved as the failure's `cause`, so the durable log says
   * exactly which rule broke.
   */
  #onLifecycleViolation(active: ActiveRun, violation: LifecycleViolation): FrameOutcome {
    if (active.session.isClosed) {
      return { legacy: null, envelope: null, forwardOnly: false, internal: false, violation: violation.code };
    }
    let envelope: RunEventEnvelope;
    try {
      envelope = active.session.observe({
        type: 'run.failed',
        error: {
          code: 'internal',
          message: `run lifecycle violated: ${violation.detail}`,
          cause: { system: 'runtime', code: violation.code },
        },
      });
    } catch {
      // The ledger refused the failure event too — which means a terminal
      // event was already recorded. Nothing further can be appended.
      return { legacy: null, envelope: null, forwardOnly: false, internal: false, violation: violation.code };
    }
    active.stream.push(envelope);
    void this.settle(active.session.runId);
    const legacy = projectToLegacyFrame(envelope);
    return { legacy, envelope, forwardOnly: false, internal: false, violation: violation.code };
  }

  #handleFor(active: ActiveRun): RunHandle {
    const controller = this;
    const session = active.session;
    const manifest = active.manifest;
    return {
      runId: session.runId,
      sessionId: session.sessionId,
      manifest,
      terminal: session.terminal$,
      events(): EventSource {
        return active.stream;
      },
      async respondToPermission(): Promise<never> {
        // A permission request is answered through the Control Plane's decision
        // bus, not by pushing a response back through the handle. The protocol
        // models `permission.respond` as a CONTROL METHOD for exactly that
        // reason: the Reference Run records the request durably and leaves the
        // decision to the Control Plane that owns the policy.
        throw new Error(
          'permission responses are a Control Plane decision: the request is recorded, the decision is not this layer',
        );
      },
      async cancel(): Promise<CancelOutcome> {
        return controller.cancel(session.runId);
      },
      async pause(): Promise<void> {
        throw new Error('run.pause is gated on replay, which this runtime does not advertise');
      },
      async result(): Promise<RunResult> {
        return session.result();
      },
    };
  }
}

/** Every event type the runtime can emit. Closed set, by construction. */
export function runtimeEventTypes(): readonly EventType[] {
  return EVENT_REGISTRY.all;
}
