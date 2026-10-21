/**
 * The in-process transport: the same Run API over no transport at all.
 *
 * ## Why this exists rather than a test double
 *
 * The CLI and the evals need to drive a run without a child process and without
 * a socket. The tempting answer is a fake transport, and a fake transport is
 * where a second state machine comes from: it has to decide what a run does,
 * and the moment it decides anything the equivalence claim is testing the fake
 * against itself.
 *
 * So this is not a fake. It is the SAME {@link ExecutionChannel} port with an
 * in-process executor behind it, and the four lines of difference from the
 * subprocess adapter are all of them plumbing:
 *
 *   subprocess  raw frame -> encode -> OS pipe -> decode -> intake.frame
 *   http-sse    raw frame -> SSE frame -> socket -> parse -> intake.frame
 *   in-process  raw frame ----------------------------------> intake.frame
 *
 * The runtime side of the arrow is IDENTICAL in all three, including the minting
 * of `seq`. That is the whole design: the transport moves a raw frame, and the
 * runtime turns it into a numbered event. An in-process adapter that skipped
 * the arrow's left half would be correct about itself and useless as a
 * comparison, because the comparison is of the RIGHT half.
 *
 * ## What it deliberately cannot do
 *
 * It holds no ledger, no session, no emitter and no persistence. It cannot mint
 * a `seq` and it has nothing to mint one with. If it appears to need run state
 * to work, the need is a sign the port is in the wrong place -- not a reason to
 * give this class a `seq` field, which `transport-guards.ts` fails the build on.
 *
 * The executor it wraps is injected, so the CLI and the eval harness supply
 * their OWN and this class stays a transport rather than becoming a runner.
 */

import { ProtocolError } from '@duya/agent-protocol';
import type {
  CapabilityRequirement,
  RunId,
  RunManifest,
  RuntimeCapabilities,
  TransportKind,
} from '@duya/agent-protocol';
import type {
  ExecutionChannel,
  ExecutionHandle,
  RunStartInput,
  StopReceipt,
} from './execution-channel.js';
import type { StopRequest } from './execution-channel.js';
import type {
  RawFrameIntake,
  RuntimeTransport,
  TransportDiagnostics,
  TransportPrivateChannel,
  TransportRun,
} from './transport-port.js';

/** A private payload, and whether it arrived. Never an event. */
interface DeliveredPrivate {
  readonly payload: unknown;
  readonly seq: number;
}

/**
 * What the executor is handed when the caller supplied no input.
 *
 * ## Why this default exists rather than being required
 *
 * {@link RuntimeTransport.start} carries no prompt, and that is structural
 * rather than an oversight: the subprocess and http-sse adapters send the
 * prompt ACROSS THE WIRE as part of dispatching, so their `start` needs no
 * input parameter. This adapter has no wire, so the transport call is the only
 * place an in-process prompt can enter — which is why `input` is accepted below
 * rather than folded into the port.
 *
 * Keeping the empty input as the default means an existing caller that passes
 * none (the equivalence harness scripts its own channel and never reads the
 * input) keeps working untouched. It is also the honest record of what this
 * adapter had before it forwarded anything: a host that forgets to pass its
 * input gets an empty prompt, visibly, rather than a silent substitution.
 */
const EMPTY_RUN_START_INPUT: RunStartInput = Object.freeze({
  sessionId: '',
  prompt: '',
  options: Object.freeze({}),
  revision: '',
});

export interface InProcessTransportOptions {
  /**
   * The executor. Injected, so the CLI and the evals bring their own and this
   * class never becomes the thing that runs a model.
   */
  readonly channel: ExecutionChannel;
  readonly capabilities: () => Promise<RuntimeCapabilities>;
  /**
   * Private config, handed to the executor at dispatch.
   *
   * A separate channel in the only sense that matters for an in-process
   * transport: it is not an event, it is not sequenced, it is not persisted, and
   * it is delivered by a method that cannot be confused with `frame`. A
   * transport with no process to put a credential on still has to keep it off
   * the event path, because the event path is what gets logged and replayed.
   */
  readonly private?: () => Promise<void> | void;
}

export class InProcessTransport implements RuntimeTransport {
  readonly kind: TransportKind = 'in-process';
  readonly #options: InProcessTransportOptions;
  readonly #private: DeliveredPrivate[] = [];
  #closed = false;

  constructor(options: InProcessTransportOptions) {
    this.#options = options;
  }

  probe(): Promise<RuntimeCapabilities> {
    return this.#options.capabilities();
  }

  async start(
    manifest: RunManifest,
    intake: RawFrameIntake,
    _require?: readonly CapabilityRequirement[],
    input?: RunStartInput,
  ): Promise<TransportRun> {
    if (this.#closed) {
      throw new ProtocolError({ code: 'transport_closed', message: 'the transport is closed' });
    }

    const privateChannel: TransportPrivateChannel = {
      deliver: async (payload: unknown): Promise<void> => {
        this.#private.push({ payload, seq: this.#private.length + 1 });
      },
    };

    // The ONE line the three adapters share: the runtime's own intake, given to
    // the executor. Not a wrapper, not a tee -- the same object, so the frames
    // arrive by the same path they would over a pipe.
    //
    // The INPUT is the caller's, passed through whole: the prompt, the session,
    // the options and the revision the run layer already decided. This adapter
    // used to invent an empty input here, which meant an in-process run's
    // prompt was discarded between the dispatch and the executor.
    const handle: ExecutionHandle = await this.#options.channel.start(
      manifest,
      input ?? EMPTY_RUN_START_INPUT,
      {
        frame: (raw) => intake.frame(raw),
        end: () => intake.end(),
      },
    );

    return {
      kind: this.kind,
      runId: manifest.runId as RunId,
      intake,
      privateChannel,
      handle: {
        stop: async (request: StopRequest): Promise<StopReceipt> => handle.stop(request),
      },
      diagnostics: (): TransportDiagnostics => ({
        transport: this.kind,
        // No pipe, so no bytes and no chunks. Reported as zero rather than
        // omitted, because a diagnostics record that leaves a field out is a
        // diagnostics record two adapters cannot be compared on.
        bytesRead: 0,
        bytesWritten: 0,
        chunksRead: 0,
        framesRefused: 0,
        disconnected: false,
        detail: { privateDeliveries: this.#private.length },
      }),
      close: async (): Promise<void> => {
        this.#closed = true;
      },
    };
  }

  /** What the private channel carried, for a test that asserts it stayed private. */
  get privateDeliveries(): readonly DeliveredPrivate[] {
    return this.#private;
  }

  async close(): Promise<void> {
    this.#closed = true;
  }
}
