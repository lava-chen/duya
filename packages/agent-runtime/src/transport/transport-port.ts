/**
 * The port all three transports satisfy, and the boundary that stops a shared
 * helper from becoming the second engine.
 *
 * ## The risk this file exists to answer
 *
 * Three adapters over one state machine is the claim. The obvious way to build
 * it is a shared module full of helpers, and the obvious way for that module to
 * rot is for a helper to acquire a little state, then a little more, until it
 * owns the run. At that point there are two engines: the real one in
 * `RunSession`, and the one that two of the three transports actually use -- so
 * the transports agree with each other and disagree with the in-process
 * adapter, which is precisely the failure the equivalence test exists to catch
 * and precisely the failure that would make the test itself misleading.
 *
 * So the boundary is stated as a TYPE, not as a review rule:
 *
 *  1. **A transport never mints a `seq`.** {@link RawFrameIntake} takes a RAW
 *     frame. There is no method anywhere on these ports that accepts an
 *     envelope to be numbered, or a ledger to number it with. A transport
 *     physically cannot renumber a run, which is contract section F's
 *     `runtime mints (runId, seq), the transport does not renumber`.
 *  2. **A transport never holds run state.** The ports below are a sink, a
 *     channel and a capability reader. There is no `seq`, no ledger, no
 *     session, no terminal decision and no persistence handle in any of them.
 *  3. **A transport never decides an event's meaning.** It moves bytes and
 *     reports transport-local facts. Translation, validation and persistence
 *     happen behind {@link RawFrameIntake.frame}, in the runtime, once.
 *
 * `transport-guards.ts` holds the compile-time half of (1) and (2) and a
 * runtime source audit holds the half TypeScript cannot see.
 *
 * ## What the three transports are allowed to differ on
 *
 * Exactly three things, and this is the list the equivalence test turns on:
 * framing, flow control, and error mapping. Everything a consumer can observe
 * about the RUN -- the ordered sequence of events, their payloads, and the
 * terminal -- is identical, because all three hand raw frames to the same
 * runtime through the same intake.
 *
 * ## Diagnostics are separated ON PURPOSE
 *
 * {@link TransportDiagnostics} is the only thing that may differ between
 * adapters, and it is a distinct type rather than a bag of optional fields on
 * the run result. A transport-local byte count that leaked into the run's
 * result would make two adapters' results differ for a reason that is not about
 * the run, and the equivalence comparison would then have to know which fields
 * to ignore -- which is how a comparison quietly stops comparing.
 */

import type {
  CapabilityRequirement,
  HostDeclaration,
  JsonValue,
  ProtocolVersion,
  RunId,
  RunManifest,
  RuntimeCapabilities,
  TransportKind,
} from '@duya/agent-protocol';
import type { RawFrame } from '../translate/chat-event-translator.js';
import type { ExecutionHandle, StopRequest, StopReceipt } from './execution-channel.js';

/**
 * Where a transport hands raw frames to the runtime.
 *
 * ## `frame` takes a RAW frame, deliberately
 *
 * `ExecutionSink` in `execution-channel.ts` has a second arm,
 * `envelope(envelope)`, for an executor that already speaks the protocol. A
 * transport must not use that arm to move a run's events, and this narrower
 * port removes the choice: the only way in is a raw frame, and the runtime's
 * emitter is the only thing that turns one into a numbered envelope.
 *
 * The consequence is worth stating because it is the property the equivalence
 * test rests on. If the subprocess adapter could deliver pre-numbered
 * envelopes, the child would mint `seq` in its own process and the host would
 * have a second numbering authority -- and the three adapters' sequences would
 * agree only by accident. They agree here because none of them can number.
 */
export interface RawFrameIntake {
  /** One raw, untranslated frame. The runtime translates and numbers it. */
  frame(raw: RawFrame): void;
  /** The executor's stream ended. Safe to call more than once. */
  end(): void;
}

/**
 * The private-config channel, kept structurally separate from the event
 * channel.
 *
 * ## Why this is a type and not a flag
 *
 * Contract section E says private config must not ride the public wire, and
 * T3.5 asks for it on a SEPARATE channel. A boolean parameter
 * (`send(payload, {private: true})`) is a convention: every call site has to
 * remember, and the failure is a credential in a frame that a log or a peer
 * will happily echo. Two types means a private payload cannot be passed where
 * a public one is expected.
 *
 * It is also why cancel still arrives when the event channel is wedged. This
 * interface has a `request` and the event path does not, so a full event queue
 * cannot make a cancel unreachable -- which is the property T3.4 proved at the
 * channel-port layer and T3.5 has to prove over real pipes.
 */
export interface TransportPrivateChannel {
  /**
   * Deliver a private payload to the executor. Never framed onto the event
   * channel and never persisted by the runtime.
   */
  deliver(payload: JsonValue): Promise<void>;
}

/** One run, as the transport sees it. No run state crosses this line. */
export interface TransportRun {
  readonly kind: TransportKind;
  readonly runId: RunId;
  /** Where raw frames go. The runtime mints; the transport only moves bytes. */
  readonly intake: RawFrameIntake;
  /** The private-config channel. Structurally not the event channel. */
  readonly privateChannel: TransportPrivateChannel;
  /** Stop the executor and report what actually happened. */
  readonly handle: ExecutionHandle;
  /**
   * This adapter's own facts about the connection, read LIVE.
   *
   * A method rather than a snapshot because the interesting values only exist
   * after the run: a byte count frozen at `start` is always zero, and a
   * disconnect that happened at the end is invisible in a value captured
   * before it. Never part of the run's result -- that is the point of it
   * existing separately.
   */
  diagnostics(): TransportDiagnostics;
  close(): Promise<void>;
}

/**
 * Facts that are true only about the CONNECTION.
 *
 * Every field here is permitted to differ between two transports carrying the
 * same run, and that permission is the point: it is what lets the equivalence
 * comparison ignore diagnostics without ignoring the run.
 */
export interface TransportDiagnostics {
  readonly transport: TransportKind;
  /** Bytes the transport moved. Different pipes, different totals, same run. */
  readonly bytesRead: number;
  readonly bytesWritten: number;
  /** How many `push` calls the pipe actually produced. Chunking is a fact. */
  readonly chunksRead: number;
  /** Lines the decoder refused. Zero for a healthy run. */
  readonly framesRefused: number;
  /** Whether the connection dropped before the executor finished. */
  readonly disconnected: boolean;
  /** Transport-specific extras, kept out of the compared shape. */
  readonly detail?: Readonly<Record<string, string | number | boolean>>;
}

/** The port. Three implementations, one shape, no per-transport special cases. */
export interface RuntimeTransport {
  readonly kind: TransportKind;

  /**
   * What this transport can actually do.
   *
   * Not a static constant: a subprocess transport's answer depends on whether
   * the worker started, and an HTTP transport's depends on whether the listener
   * is bound. A probe that returns a constant is a probe nobody can trust, and
   * the whole point of T3.5 is that an unproven capability reads as
   * unsupported.
   */
  probe(): Promise<RuntimeCapabilities>;

  /**
   * Open a run.
   *
   * `intake` is the RUNTIME's, passed in by the caller, and never created here.
   * That is the mechanical form of "the transport does not decide where a run's
   * events go": an adapter that built its own intake would own the run's
   * event stream, and two adapters would then be two engines. Because the
   * caller supplies it, all three transports necessarily deliver into the same
   * runtime and the equivalence claim is structural rather than a convention.
   *
   * `require` is enforced BEFORE anything is dispatched, so a refusal never
   * leaves a half-started run behind.
   */
  start(
    manifest: RunManifest,
    intake: RawFrameIntake,
    require?: readonly CapabilityRequirement[],
  ): Promise<TransportRun>;

  close(): Promise<void>;
}

/** What a caller must state to open a connection, before any bytes move. */
export interface TransportConnectOptions {
  /** The host's own declaration. Consulted by the capability probe. */
  readonly host: HostDeclaration;
  readonly protocol: ProtocolVersion;
  readonly require?: readonly CapabilityRequirement[];
  /** A clock the transport may use for timeouts. Injected, never ambient. */
  readonly now?: () => number;
}

/** Re-exported so an adapter needs one import for a stop. */
export type { StopRequest, StopReceipt, ExecutionHandle };
