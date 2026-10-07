/**
 * The headless run host: one `RunController`, one in-process transport, and the
 * real `duyaAgent` behind them.
 *
 * ## The problem this exists to solve
 *
 * `packages/agent/src/cli/index.ts` built a `duyaAgent` and called
 * `agent.streamChat(prompt)` directly. That is not "the CLI consuming the Run
 * API" — it is the CLI bypassing it entirely, which is what R2.1's census
 * recorded as a DIVERGENCE. The moment the CLI owns its own run loop it gets
 * its own answers to every question the run layer already answers: what is the
 * run's identity, when is it over, what happens on cancel, what does a budget
 * exhaustion mean, and which events are durable.
 *
 * ## What "one Run API" means here, mechanically
 *
 * The chain below is the SAME chain the Desktop host builds, with one
 * substitution and no additions:
 *
 * ```
 *   HeadlessRunHost.start
 *     -> RunController.start            (agent-runtime, the real one)
 *          -> manifest frozen, run.started durable
 *          -> InProcessTransport.start  (agent-runtime, the real one)
 *               -> agentExecutionChannel.start   <-- THIS module, and only this
 *                    -> duyaAgent.streamChat      (the real executor)
 *                    -> sse-frame-codec            (the WORKER's codec)
 *          -> RunSession.observe -> emitter mints seq -> ledger
 *     -> handle.events() is the run's ONLY event stream
 * ```
 *
 * The one substituted part is the EXECUTOR, not the run layer. The worker
 * subprocess is replaced by an in-process `duyaAgent`, and the frames it
 * produces are turned into legacy `chat:*` frames by the same codec the
 * subprocess uses, so the runtime downstream of the intake cannot tell the
 * difference. That is the whole claim, and it is checkable: see
 * `headless-run-host.test.ts`, which asserts the host's frames are the frames
 * the worker's own codec produces.
 *
 * ## Why this is a host ADAPTER and not a runner
 *
 * A "runner" would own the loop: open a run, pump events, decide when it is
 * over, report a terminal. This module owns none of that. It supplies three
 * things the runtime asks for and gets out of the way:
 *
 *  - an `ExecutionChannel` that starts the real executor and forwards frames;
 *  - a `TranslateContext` per run, because the runtime is the component that
 *    owns permission classification and the turn counter;
 *  - a `RunPersistence`, which a headless host has no Control Plane to ask.
 *
 * The terminal decision, the `seq` sequence, the budget verdict and the cancel
 * escalation all come out of `RunController`. If a future change made this
 * class able to answer "did the run finish?" on its own, that is the second
 * state machine this design exists to prevent.
 *
 * ## What is NOT claimed
 *
 * There is no Control Plane here, so `persistenceFor` is the in-memory store.
 * A headless run's transcript lives for the process, and `RunResult.transcript`
 * reports it as what it is rather than pretending a durable row exists. There is
 * also no permission coordinator: `permissionResponder` is absent, so a
 * `permission.requested` in a headless run has nobody to answer it, which is
 * reported as `permissionExpiryClock: 'absent'` rather than advertised.
 */

import {
  InProcessTransport,
  InMemoryRunEventStore,
  RunController,
  probeRuntimeCapabilities,
  projectToLegacyFrame,
  type ExecutionChannel,
  type ExecutionHandle,
  type ExecutionSink,
  type LegacySseFrame,
  type RunHandle,
  type RunPersistence,
  type RunStartInput,
  type StopReceipt,
  type TranslateContext,
} from '@duya/agent-runtime';
import type {
  CancelOutcome,
  RunEventEnvelope,
  PermissionPolicyMode,
  RunId,
  RunManifest,
  RunResult,
  RunTerminalState,
  RuntimeCapabilities,
} from '@duya/agent-protocol';
import { manifestFingerprint } from '@duya/agent-protocol';
import { convertSSEToAgentMessage } from './sse-frame-codec.js';
import { buildMessageFinalizedEvent } from './worker-protocol.js';

/** The runtime this host reports in `run.started` and in its probe. */
const RUNTIME_IDENTITY = { name: 'duya-headless-run-host', version: '0.1.0' } as const;

/** The protocol this host speaks. Matches the runtime package's own constant. */
const PROTOCOL = { major: 1, minor: 0 } as const;

/** The schema revision the probe reports. Bumped only with the protocol. */
const SCHEMA_REVISION = 1;

/**
 * The assistant message an agent's `streamChat` RETURNS when the turn ends.
 *
 * Structurally the two fields the finalized frame reads, and nothing more: the
 * agent is reached through the `HeadlessAgent` port, so this host depends on
 * "something that ends by handing back its final message", not on the class
 * that produces it.
 */
export type HeadlessFinalMessage = Readonly<{ id?: string; content?: unknown }>;

/** The generator's return value, when it is an object rather than `undefined`. */
function isFinalMessage(value: unknown): HeadlessFinalMessage | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as HeadlessFinalMessage)
    : null;
}

/**
 * The slice of `duyaAgent` this host drives.
 *
 * Declared as a port rather than importing the class, for two reasons. The
 * first is testability without a model: the test supplies an agent that yields
 * a scripted event list, so the run layer is exercised end to end with no
 * provider and no network. The second is the boundary itself — the host depends
 * on "something that streams agent events and can be interrupted", which is
 * what makes the same adapter reusable by a host that has a real model.
 */
export interface HeadlessAgent {
  /**
   * The generator's RETURN value is the authoritative assistant message, and
   * the host reads it to emit `chat:message_finalized`.
   *
   * `| void` is what keeps this an honest port rather than a new requirement:
   * the real `duyaAgent.streamChat` resolves to the `AssistantMessage` it
   * built, while a double — or a host whose agent produces none — may
   * legitimately return nothing, and then the frame is simply absent, which is
   * the correct wire for "there was no message to finalise".
   */
  streamChat(
    prompt: string,
    options?: Readonly<Record<string, unknown>>,
  ): AsyncGenerator<
    { readonly type: string; readonly data?: unknown },
    HeadlessFinalMessage | void,
    unknown
  >;
  /** Stop the in-flight turn. The host maps this onto the run layer's cancel. */
  interrupt(): void;
}

/** What the host needs to build a run's frozen decision. */
export interface HeadlessRunIntent {
  /** The user's prompt. Travels through the run, never beside it. */
  readonly prompt: string;
  /** The session this turn belongs to. */
  readonly sessionId: string;
  /** Absolute working directory for the run. */
  readonly cwd: string;
  /** Extra roots the host has already validated. */
  readonly roots?: readonly string[];
  readonly model: string;
  readonly providerId: string;
  readonly permissionMode?: PermissionPolicyMode;
  /** The run's whole-turn ceiling, forwarded onto the executor's options. */
  readonly maxTurns?: number;
  /**
   * The executor's tool registry, forwarded onto `streamChat`'s options.
   *
   * `unknown` rather than a registry type, and deliberately: this module sits in
   * the same package as `duyaAgent` and importing the registry's interface here
   * would couple the run layer to a tool-system type it has no business knowing.
   * The value is opaque to the host — it is passed through untouched, and the
   * executor is the only thing that reads it.
   */
  readonly toolRegistry?: unknown;
}

export interface HeadlessRunHostOptions {
  readonly agent: HeadlessAgent;
  /**
   * Mint the run id, injected so a test can pin it and a host can prefix it
   * with its own authority. The default is a random UUID, which is the honest
   * default for a host with no id scheme of its own.
   */
  readonly mintRunId?: () => RunId;
  /** Wall clock, injected so a test is not at the mercy of the machine. */
  readonly now?: () => number;
}

/**
 * One headless run, as the host hands it back.
 *
 * Deliberately not the protocol's `RunHandle`: that type carries `pause()` and
 * `respondToPermission()`, and a headless host can do neither. Exposing them
 * would be advertising two capabilities this host has not got — the same
 * dishonesty the capability probe exists to prevent — so the surface here is
 * the honest subset.
 */
export interface HeadlessRun {
  readonly runId: RunId;
  /** The manifest this run was frozen with, and its hash. */
  readonly manifest: RunManifest;
  readonly manifestHash: string;
  /** Resolves exactly once, with the terminal the RUNTIME decided. */
  readonly terminal: Promise<RunTerminalState>;
  /**
   * The run's event stream, in `seq` order.
   *
   * The only channel through which run state reaches the caller, on purpose: a
   * second one would be a place for a consumer to learn something the durable
   * record does not say.
   */
  events(): AsyncGenerator<RunEventEnvelope, void, unknown>;
  /**
   * The run's events projected onto the legacy `{ type, data }` frames.
   *
   * This is the SAME projection the Desktop renderer already reads, from the
   * SAME runtime projector, so a headless consumer and a Desktop consumer are
   * looking at one vocabulary rather than two. Events with no legacy
   * counterpart (`run.started`, `tool.timed_out`, `permission.resolved`) are
   * dropped, which is the projector's contract rather than a loss this host
   * chose: those events live in `transcriptTypes()`, not on a UI frame.
   */
  frames(): AsyncGenerator<LegacySseFrame, void, unknown>;
  /** Ask the run to stop. Reports what the stop turned into. */
  cancel(reason: string): Promise<CancelOutcome>;
  /** The run's measured result. */
  result(): Promise<RunResult>;
  /**
   * The event types the run's DURABLE record holds, in append order.
   *
   * Distinct from `events()` on purpose, and the distinction is not cosmetic:
   * the runtime's own header (`events/event-emitter.ts`) records that
   * `session.observe` does not push to the live stream, so a terminal the
   * runtime SYNTHESISES on settle is durable without ever appearing on the
   * stream a consumer is iterating. A headless caller that only read `events()`
   * would conclude the run produced no terminal at all.
   *
   * Exposed because a headless host's whole job is to hand a caller an honest
   * account of the run, and "the stream ended" is a weaker account than "here is
   * what was written down".
   */
  transcriptTypes(): Promise<readonly string[]>;
  /** Durable-envelope count, for a caller that wants to know what was kept. */
  readonly durableCount: number;
}

/**
 * The `ExecutionChannel` from the run layer to a real `duyaAgent`.
 *
 * This is the ONLY place the headless path touches the executor, and it does
 * three things: start the turn, forward each agent event as the frame the
 * worker would have sent, and report a stop as the interrupt it issued.
 */
export function createAgentExecutionChannel(agent: HeadlessAgent): ExecutionChannel {
  return {
    async start(
      manifest: RunManifest,
      input: RunStartInput,
      sink: ExecutionSink,
    ): Promise<ExecutionHandle> {
      // The budget crosses on the command, for the same reason it does for the
      // worker adapter (`createWorkerExecutionChannel`): the run layer learns a
      // turn started when the frame comes BACK, which is after the model request
      // went out. A ceiling of `0` is treated as absent, matching
      // `isBudgetExhausted`'s own `isPositive` — forwarding `0` would stop a
      // healthy run after one turn.
      const maxTurns = manifest.budget.maxTurns;
      const options: Readonly<Record<string, unknown>> =
        typeof maxTurns === 'number' && Number.isFinite(maxTurns) && maxTurns > 0
          ? { ...input.options, maxTurns }
          : input.options;

      // Pump the generator onto the sink. Deliberately NOT awaited: `start` must
      // return a handle so the caller can cancel, and awaiting the whole turn
      // here would make a cancel impossible to issue for the duration of it.
      void (async (): Promise<void> => {
        try {
          // Driven with an explicit iterator rather than `for await`, for one
          // reason: the agent's `streamChat` RETURNS the authoritative assistant
          // message, and `for await...of` discards a generator's return value.
          // That value is the only place the finalized message exists on this
          // path — the in-process host has no `chat:done` producer upstream of
          // it, and the worker's message log is a different process.
          const iterator = agent.streamChat(input.prompt, options);
          let stopReason: string | undefined;
          // `chat:done` is HELD, not forwarded inline, for the same reason the
          // worker subprocess holds it: the authoritative assistant message is
          // only known when the generator finishes, which is AFTER the `done`
          // event has already been seen. Forwarding `done` first would put
          // `run.completed` into the ledger ahead of the message it finalises,
          // and the run would already have terminated by the time the finalized
          // frame arrived — the run layer would drop it as a late frame and the
          // message would never reach the ledger at all.
          let heldDone: Record<string, unknown> | null = null;
          for (;;) {
            const next = await iterator.next();
            if (next.done === true) {
              // The producer's own stop reason, read off the frame the codec
              // built rather than off the raw event, so the reason that travels
              // with the finalized message is the one the terminal frame
              // carries.
              const finalMessage = isFinalMessage(next.value);
              const finalized = buildMessageFinalizedEvent(
                input.sessionId,
                finalMessage,
                stopReason,
              );
              if (finalized !== null) {
                sink.frame(finalized as unknown as Record<string, unknown>);
              }
              if (heldDone !== null) sink.frame(heldDone);
              break;
            }
            // The WORKER's codec, not a second one. See `sse-frame-codec.ts`:
            // two frame producers is the case the transport equivalence test
            // cannot catch, because it compares transports and not producers.
            const frame = convertSSEToAgentMessage(next.value);
            if (frame === null) continue;
            if (frame['type'] === 'chat:done') {
              const reason = frame['reason'];
              if (typeof reason === 'string' && reason !== '') stopReason = reason;
              heldDone = frame;
              continue;
            }
            sink.frame(frame);
          }
        } catch (error) {
          // A turn that threw is a FAILED run, not a silent one. The runtime
          // synthesises the terminal from the frames it received, and without
          // this frame a generator that died mid-turn would leave the run
          // looking live until something else closed it.
          sink.frame({
            type: 'chat:error',
            message: error instanceof Error ? error.message : String(error),
          });
        } finally {
          sink.end();
        }
      })();

      return {
        stop: async (request): Promise<StopReceipt> => {
          // The interrupt is the agent's own, so the stop is genuinely
          // cooperative: the executor is asked to leave and reports that it
          // was asked. `waitedMs: 0` because there is no separate process whose
          // exit could be timed — the agent's generator ends when the abort
          // lands, and the run layer observes that as `sink.end()`.
          agent.interrupt();
          return { requested: true, disposition: 'cooperative', waitedMs: 0, reason: request.reason };
        },
      };
    },
  };
}

/**
 * Build the run's frozen decision.
 *
 * A factory rather than a literal at the call site, for one reason that is
 * load-bearing: `provenance` is a `Record` over a CLOSED field set, so a
 * manifest assembled field-by-field at six call sites is six places to forget
 * an attribution. Here it is stated once, and `synthesised: true` on every
 * value the CLI actually invented says so out loud rather than by omission.
 */
export function buildHeadlessManifest(
  intent: HeadlessRunIntent,
  runId: RunId,
): RunManifest {
  const unsupported = { source: 'unsupported', synthesised: true } as const;
  return {
    version: 1,
    runId,
    projectId: null,
    workspaceId: 'headless',
    roots: intent.roots ?? [intent.cwd],
    cwd: intent.cwd,
    permissionPolicy: {
      mode: intent.permissionMode ?? 'default',
      hostSwitch: 'ask',
      defaultTimeoutMs: 300_000,
    },
    capabilities: { profiles: [], modes: [], tools: [] },
    connectorBindings: [],
    // NO SECRETS. A headless host has no secret resolver, so it names a ref it
    // cannot resolve and a digest of nothing rather than inlining an API key
    // into a value the runtime hashes into every event it emits.
    env: { ref: 'env:headless', hash: 'e3b0c44298fc1c149afbf4c8996fb924' },
    agent: { profileId: null, model: intent.model, providerId: intent.providerId },
    budget: intent.maxTurns === undefined ? {} : { maxTurns: intent.maxTurns },
    deterministic: false,
    provenance: {
      roots: unsupported,
      cwd: unsupported,
      permissionPolicy: unsupported,
      capabilities: unsupported,
      connectorBindings: unsupported,
      env: unsupported,
      agent: unsupported,
      budget: unsupported,
      workspaceId: unsupported,
      deterministic: unsupported,
    },
  };
}

/**
 * The headless run host.
 *
 * One instance per process is the intended shape, and it is not enforced,
 * because nothing about the composition requires it: the controller is
 * stateless between runs, so a second host is a second controller rather than a
 * second state machine.
 */
export class HeadlessRunHost {
  readonly #controller: RunController;
  readonly #store: InMemoryRunEventStore;
  readonly #transport: InProcessTransport;
  readonly #agent: HeadlessAgent;
  readonly #mintRunId: () => RunId;
  readonly #now: () => number;

  constructor(options: HeadlessRunHostOptions) {
    this.#agent = options.agent;
    this.#store = new InMemoryRunEventStore();
    this.#mintRunId = options.mintRunId ?? (() => crypto.randomUUID());
    this.#now = options.now ?? Date.now;

    this.#transport = new InProcessTransport({
      channel: createAgentExecutionChannel(options.agent),
      // The probe is the runtime's OWN, asked of a host that supplies the facts
      // it cannot measure for itself. It reports `NO_RESUME` and
      // `deterministic: false` because that is what the runtime supports today,
      // and a headless host that advertised otherwise would be claiming D7.1's
      // state machine is a shipping capability.
      capabilities: () => this.probe(),
    });

    this.#controller = new RunController({
      channel: {
        start: async (manifest, input, sink): Promise<ExecutionHandle> => {
          // The run layer's REAL input crosses here, whole. This bridge used to
          // accept `input` and drop it on the floor, forwarding only the sink;
          // the transport then had nothing to dispatch and fabricated an empty
          // one, so the executor's `streamChat` was called with `''` no matter
          // what the caller passed to `HeadlessRunHost.start`. `require` is
          // position three on the port and this adapter ignores it, so it is
          // passed through as `undefined` rather than reordered away.
          const run = await this.#transport.start(
            manifest,
            {
              frame: (raw) => sink.frame(raw),
              end: () => sink.end(),
            },
            undefined,
            input,
          );
          return run.handle;
        },
      },
      identity: RUNTIME_IDENTITY,
      protocol: PROTOCOL,
      contextFor: (manifest) => this.#contextFor(manifest),
      persistenceFor: () => this.#persistence(),
      now: this.#now,
      clock: this.#now,
    });
  }

  /**
   * The translation context for one run.
   *
   * `classify` returns `'generic'` on purpose, for the reason the Desktop
   * orchestrator's does: protocol G-2 forbids inferring a permission's `kind`
   * from the tool name. A headless host has no permission coordinator, so it
   * has nothing better to say than "not classified", and saying that is what
   * keeps `permission.requested` honest rather than confidently wrong.
   */
  #contextFor(manifest: RunManifest): TranslateContext {
    const startedAt = this.#now();
    return {
      messageId: `m-${manifest.runId}`,
      permission: {
        classify: () => 'generic',
        mode: 'generic',
        expiresInMs: startedAt + manifest.permissionPolicy.defaultTimeoutMs,
        now: this.#now,
      },
      nextTurn: (() => {
        let index = 0;
        return () => {
          index += 1;
          return { turnId: `turn-${index}`, index };
        };
      })(),
      model: {
        model: manifest.agent?.model ?? 'unknown',
        providerId: manifest.agent?.providerId ?? 'unknown',
        apiFormat: 'anthropic',
      },
    };
  }

  #persistence(): RunPersistence {
    return {
      append: async (envelopes) => {
        await this.#store.append(envelopes);
      },
      complete: async () => undefined,
    };
  }

  /** What this host can honestly do. Asked, never restated. */
  async probe(): Promise<RuntimeCapabilities> {
    return probeRuntimeCapabilities({
      transport: 'in-process',
      protocol: PROTOCOL,
      schemaRevision: SCHEMA_REVISION,
      identity: RUNTIME_IDENTITY,
      // `provides` is the runtime's declaration of what it can actually
      // produce, and it is the field `assertCapabilityConsistency` checks the
      // whole advertised event set against. `tool_preview` is required and not
      // optional: the probe advertises the WHOLE registry, so a runtime that
      // emits `tool.call_preview` has to declare it. Understating it does not
      // make this host more honest — it makes the probe REFUSE, which is the
      // guard working rather than a value to be trimmed to fit.
      provides: ['tool_preview'],
      // A headless host has no permission coordinator, so it can adjudicate
      // nothing. The empty list is the honest answer, and it is why the probe
      // reports `permissionExpiryClock: 'absent'`: nobody is shown a deadline
      // this host would not enforce.
      permissionActions: [],
      permissionDefaultTimeoutMs: 300_000,
      permissionMaxTimeoutMs: 300_000,
      // A headless host holds no replay window: the in-memory store is what it
      // has, and it is the same store the run just wrote. `0` is the honest
      // answer rather than a bound this host does not enforce.
      oldestAvailableSeq: 0,
      latestSeq: 0,
      catalog: { profiles: [], modes: [], tools: [], connectorProviders: [] },
    });
  }

  /**
   * Start one run and hand back the handle.
   *
   * The run id is minted HERE, by the host, and travels on the manifest — which
   * is what makes it the canonical id. An adapter that minted its own id beside
   * the dispatch would be a second run-identity source, and the thing R2.1
   * unified.
   */
  async start(intent: HeadlessRunIntent): Promise<HeadlessRun> {
    const runId = this.#mintRunId();
    const manifest = buildHeadlessManifest(intent, runId);
    const handle: RunHandle = await this.#controller.start(manifest, {
      prompt: intent.prompt,
      sessionId: intent.sessionId,
      options: intent.toolRegistry === undefined ? {} : { toolRegistry: intent.toolRegistry },
    });
    return this.#wrap(handle, manifest);
  }

  #wrap(handle: RunHandle, manifest: RunManifest): HeadlessRun {
    // Captured, not reached for through `this`, because these closures outlive
    // the method call and `this` inside them would be the `HeadlessRun` object
    // rather than the host.
    const store = this.#store;
    return {
      runId: handle.runId,
      manifest,
      manifestHash: manifestFingerprint(manifest),
      terminal: handle.terminal,
      events: async function* (): AsyncGenerator<RunEventEnvelope, void, unknown> {
        for await (const envelope of handle.events()) {
          yield envelope as unknown as RunEventEnvelope;
        }
      },
      cancel: (reason: string) => handle.cancel('user', { reason }),
      result: () => handle.result(),
      frames: async function* (): AsyncGenerator<LegacySseFrame, void, unknown> {
        for await (const envelope of handle.events()) {
          // The runtime's OWN projector, not a second mapping. A headless host
          // that projected events itself would be the second frame vocabulary
          // this whole design exists to avoid, one layer further out.
          const frame = projectToLegacyFrame(envelope as unknown as RunEventEnvelope);
          if (frame !== null) yield frame;
        }
      },
      transcriptTypes: async () => {
        // `readSince` rather than a whole-transcript read, because the reader's
        // window is the durable one and `mintedLatest` is an INPUT only the live
        // runtime knows. `Number.MAX_SAFE_INTEGER` is the honest "everything up
        // to now" for a run that has already settled, and it is passed as the
        // minted ceiling rather than inferred from the store.
        const envelopes = await store.readSince({
          runId: handle.runId,
          afterSeq: 0,
          limit: Number.MAX_SAFE_INTEGER,
        });
        return envelopes.map((envelope) => envelope.payload.type);
      },
      get durableCount(): number {
        return store.lastReceipt.accepted.length;
      },
    };
  }

  /** The agent this host drives, for a caller that needs its post-run state. */
  get agent(): HeadlessAgent {
    return this.#agent;
  }
}

/** Build a host. A function so the composition is visible at the call site. */
export function createHeadlessRunHost(options: HeadlessRunHostOptions): HeadlessRunHost {
  return new HeadlessRunHost(options);
}
