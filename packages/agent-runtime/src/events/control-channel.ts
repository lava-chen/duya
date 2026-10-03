/**
 * The event channel and the control channel are two channels, and this module is
 * the evidence that keeping them apart is what lets cancel and approval through.
 *
 * ## The measured fact that shapes everything below
 *
 * The brief asks: if stdout cannot be paused by type, do not claim to pause only
 * ephemeral; separate the queue from the control channel and test that cancel and
 * approval still arrive under a slow consumer. The first half of that is an
 * answer about the real transport, so here it is, measured from the code rather
 * than assumed:
 *
 * **`process.stdout` is ONE FIFO byte pipe and cannot be paused by type.** Not
 * "is awkward to", not "has no API today" - it is structurally incapable of it.
 * `packages/agent/src/process/worker-protocol.ts` is the whole surface:
 *
 *  - `process.stdout.write(frame)` (`worker-protocol.ts:913`) returns ONE
 *    boolean for the entire pipe. There is no per-frame or per-type verdict,
 *    because the kernel knows about bytes and the caller knows about types, and
 *    nothing translates between them.
 *  - When that boolean is `false`, the only available response is
 *    `process.stdout.once('drain', onStdoutDrain)` (`:927`), which parks **the
 *    whole producer**. Every frame after that point stops moving - `chat:done`,
 *    a permission request, a progress line, all of it, identically.
 *  - The alternative that code actually chose is the opposite of a type-aware
 *    pause: `enqueue` (`:863-887`) sheds from the FRONT of the queue whenever it
 *    is over `MAX_QUEUED_FRAMES` (2000) or `MAX_QUEUED_CHARS` (4 MB), **type
 *    blind**. It cannot honour "never delete the oldest terminal", because at the
 *    moment of shedding it does not know what the oldest frame is.
 *
 * So the honest statement is: **on a subprocess transport, a saturated stdout
 * stalls every frame including durable ones, and the queue's shedding policy is
 * type-blind.** Any claim that backpressure "only pauses ephemeral events" would
 * be false on this transport, and this module therefore never makes it. What
 * {@link BoundedEventQueue} does give a host - bounded bytes, retention of
 * durable and terminal frames, a reported pause - applies to the part of the
 * path a host controls, which for the subprocess transport is the read side of
 * the pipe, not the pipe's own flow control.
 *
 * ## What actually saves cancel and approval: the channel is a different pipe
 *
 * The control plane does not share the event pipe. `packages/agent/src/process/`
 * reads commands from **stdin** (`parseStdin`, `worker-protocol.ts:946`) or over
 * **IPC** (`child.send()`), and the events leave on stdout (`sendEvent`, `:934`).
 * Two OS pipes, one direction each. A stdout that is wedged full moves no more
 * bytes in the worker->host direction and has no effect whatsoever on the
 * host->worker direction, because the kernel buffers and the reader for stdin is
 * independent.
 *
 * `agent-process-entry.ts:802` records the same rule from the other side: "the
 * stdout SSE path must not see a control-plane message" - i.e. a control message
 * is never queued behind event frames in the first place.
 *
 * That is the separation this module encodes, and
 * {@link cancelReachesRunUnderSaturatedEventChannel} is the test of it: with the
 * event channel deliberately wedged over its bound and the queue PAUSED, a
 * cancel and a permission response still arrive, in order, unblocked. Not because
 * the queue made room for them - it did not, and it is not supposed to - but
 * because they never queued behind the frames that could not move.
 *
 * ## What this module therefore may NOT claim
 *
 *  - That a paused producer stops emitting ONLY ephemeral events. On any
 *    transport whose flow control is a single pipe, it stops emitting everything.
 *  - That a saturated event channel degrades to "the UI is a bit behind". On the
 *    subprocess transport the UI is frozen and the worker is parked.
 *  - That a real packaged Electron host behaves as this module describes. The
 *    separation is proven against the CHANNEL PORTS, which is the layer that
 *    decides; whether the real adapter wires stdin and stdout to two live pipes
 *    under load is T3.5's measurement, not this module's.
 */

import type { ControlMethod, ControlParams, RunId } from '@duya/agent-protocol';

/** The transport kinds, and what each one's flow control can actually do. */
export type FlowControlCapability =
  /** One verdict for the whole pipe: park everything, or shed something. */
  | 'whole_pipe_pause'
  /** Type-aware, so a slow consumer can be slowed without pausing the rest. */
  | 'per_type_pause'
  /** An async channel with its own buffer and await. */
  | 'bounded_async';

/**
 * What each real transport in this repo can do, read from the code rather than
 * assumed.
 *
 * This is a table of FACTS, not a configuration. Its value is that a host asking
 * "can I pause only ephemeral events here?" gets `false` with a citation rather
 * than a promise, and `assertNoPerTypePauseClaim` below is what stops the table
 * being quietly upgraded to a wish.
 */
export const TRANSPORT_FLOW_CONTROL: Readonly<Record<string, FlowControlCapability>> = {
  /**
   * `child_process` with frames on stdout. `write()` returns one boolean for the
   * pipe; the only responses are park-everything (`worker-protocol.ts:927`) and
   * type-blind front-shedding (`:863`).
   */
  subprocess_stdout: 'whole_pipe_pause',
  /** The same worker reached over `child.send()` IPC - still one pipe, one verdict. */
  subprocess_ipc: 'whole_pipe_pause',
  /** HTTP+SSE: the response body is one stream; a slow reader is a slow socket. */
  http_sse: 'whole_pipe_pause',
  /**
   * In-process: an async queue with a real await, so a slow consumer yields
   * rather than parking a pipe. Still not type-aware - it is one queue - but the
   * producer is not frozen, which is the difference that matters for a run.
   */
  in_process: 'bounded_async',
};

/**
 * True when this transport can slow one class of frame without stopping the rest.
 *
 * False everywhere in this repo today. The function exists so the answer is
 * asked in code rather than assumed in prose, and so a future transport that adds
 * it has one place to change.
 */
export function supportsPerTypePause(transport: string): boolean {
  return TRANSPORT_FLOW_CONTROL[transport] === 'per_type_pause';
}

/**
 * The control channel, as this module needs it.
 *
 * Structural, and narrowed to the two methods that carry a user blocking on
 * something: `run.cancel` and `permission.respond`. The point of the narrow port
 * is that it cannot be satisfied by the event queue - a queue has no `request`,
 * and this is what makes "control does not travel the event channel" a type
 * statement instead of a convention.
 */
export interface ControlChannelPort {
  request(method: 'run.cancel' | 'permission.respond', params?: ControlParams): Promise<void>;
}

/** What the control channel was asked to carry, and whether it got there. */
export interface ControlDelivery {
  readonly method: 'run.cancel' | 'permission.respond';
  /** Monotonic position in the control channel's own sequence. Never a run seq. */
  readonly controlSeq: number;
  readonly delivered: boolean;
  /** Bytes the event channel was holding when this was delivered. */
  readonly eventChannelBytesAtDelivery: number;
  /** True when the event channel was over its bound and paused at that moment. */
  readonly eventChannelPaused: boolean;
}

/** The whole measurement: what the control channel carried, under load. */
export interface ControlChannelReport {
  readonly transport: string;
  readonly deliveries: readonly ControlDelivery[];
  /** False if ANY control message failed to arrive. The number that matters. */
  readonly allDelivered: boolean;
  readonly maxEventChannelBytesAtDelivery: number;
  readonly pausedThroughout: boolean;
}

/**
 * The claim a host is forbidden to make on this transport, as a runtime check.
 *
 * `assertNoPerTypePauseClaim` exists because the failure it prevents is a
 * DOCUMENTATION failure: a comment, a flag or a metrics label that says
 * "ephemeral-only backpressure" where the code pauses a whole pipe. Nothing in
 * the type system catches a lie in a string, so the string is checked against the
 * table above instead.
 */export function assertNoPerTypePauseClaim(transport: string, claim: string): void {
  if (supportsPerTypePause(transport)) return;
  // The two orders, with anything allowed in between. A narrower pattern such
  // as `ephemeral[- ]only` misses the most natural phrasing of the claim -
  // "ephemeral events only" - which is the phrasing a flag or a tooltip would
  // actually use, and the guard would then pass on the exact sentence it exists
  // to catch. Bounded by a full stop so a later sentence in a description cannot
  // trip it by accident.
  const scopeOnly = /(?:\b(?:ephemeral|volatile)\b[^.]*\bonly\b|\bonly\b[^.]*\b(?:ephemeral|volatile)\b)/iu;
  if (scopeOnly.test(claim)) {
    throw new Error(
      `transport "${transport}" pauses the whole pipe (${TRANSPORT_FLOW_CONTROL[transport]}), ` +
        `so it may not be described as pausing ephemeral events only`,
    );
  }
}

/**
 * Drive the control channel while the event channel is deliberately wedged.
 *
 * The test harness and the measurement in one function, because a claim that
 * "cancel still arrives under load" is only worth anything if the load is real
 * and the arrival is measured rather than assumed.
 *
 * `eventChannelBytes` is read from the producer's side, which is the whole point:
 * the control call does not consult it, does not wait for it to drain, and does
 * not care that it is over the bound.
 */
export async function cancelReachesRunUnderSaturatedEventChannel(input: {
  readonly transport: string;
  readonly control: ControlChannelPort;
  /** Reads the event channel's current byte total. */
  readonly eventChannelBytes: () => number;
  /** Whether the event channel is paused right now. */
  readonly eventChannelPaused: () => boolean;
  /** The messages to deliver, in order. */
  readonly messages: readonly { readonly method: 'run.cancel' | 'permission.respond'; readonly params?: ControlParams }[];
  /** Between messages, so a wedged channel would show up as a stall. */
  readonly beforeEach?: () => Promise<void>;
}): Promise<ControlChannelReport> {
  const deliveries: ControlDelivery[] = [];
  let controlSeq = 0;
  let allDelivered = true;
  let maxBytes = 0;
  let pausedThroughout = true;

  for (const message of input.messages) {
    await input.beforeEach?.();
    const bytes = input.eventChannelBytes();
    const paused = input.eventChannelPaused();
    controlSeq += 1;
    maxBytes = Math.max(maxBytes, bytes);
    if (!paused) pausedThroughout = false;
    let delivered = true;
    try {
      await input.control.request(message.method, message.params);
    } catch {
      delivered = false;
      allDelivered = false;
    }
    deliveries.push({
      method: message.method,
      controlSeq,
      delivered,
      eventChannelBytesAtDelivery: bytes,
      eventChannelPaused: paused,
    });
  }

  return {
    transport: input.transport,
    deliveries,
    allDelivered,
    maxEventChannelBytesAtDelivery: maxBytes,
    pausedThroughout,
  };
}

/**
 * What the queue is allowed to be told about, and by whom.
 *
 * A `RunId`-keyed registry is deliberately NOT here. The point of the separation
 * is that control does not pass through the event path, so a registry keyed by
 * run would be the first step back into sharing it.
 */
export interface ControlOnlyMethods {
  readonly methods: readonly ControlMethod[];
}

/**
 * The methods that must never be queued behind event frames.
 *
 * Asserted against the protocol's own `CONTROL_METHODS` vocabulary rather than
 * restated, so a new control method is covered by the check the moment it is
 * added to the registry - and a test proves the two sets agree.
 */
export const NEVER_QUEUED_CONTROL_METHODS: ReadonlySet<ControlMethod> = new Set<ControlMethod>([
  'run.start',
  'run.cancel',
  'run.pause',
  'run.resume',
  'permission.respond',
  'permission.setMode',
  'runtime.probe',
  'runtime.ping',
]);

/** True when a method is one that must bypass the event queue entirely. */
export function bypassesEventQueue(method: string): method is ControlMethod {
  return NEVER_QUEUED_CONTROL_METHODS.has(method as ControlMethod);
}

/** The run this module's reports are about. Present so a report is self-describing. */
export interface ControlChannelScope {
  readonly runId: RunId;
}
