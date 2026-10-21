/**
 * The subprocess transport: a real child process, two real pipes, one codec.
 *
 * ## What is real here, and what is not
 *
 * Real: `child_process.spawn`, two OS pipes in opposite directions, the worker's
 * own `sendEvent` producing the bytes, and `process.stdout.write` returning one
 * boolean for the whole pipe. The decoder is fed whatever the pipe actually
 * delivered, in whatever sizes it delivered it.
 *
 * Not real: the worker's MODEL. The scenario frames are supplied on stdin
 * because T3.5 is about the plumbing, and a test that needed an API key would be
 * a test that ran in CI about once a month. Nothing below infers anything from
 * that -- the bytes on stdout are the worker's, and the assertions are on them.
 *
 * ## stdout and stdin are separate channels, and that is the load-bearing fact
 *
 * T3.4 established from the code that `process.stdout.write` cannot be paused by
 * type: one boolean for one pipe, so the only options are park-everything and
 * type-blind shedding, and `assertNoPerTypePauseClaim` throws on any host that
 * claims otherwise. T3.5's remaining job was to show the two live pipes really
 * are wired that way.
 *
 * They are, and the mechanism is the one T3.4 named: a cancel travels on STDIN.
 * A stdout wedged full moves no more bytes in the worker-to-host direction and
 * has no effect on the host-to-worker direction, because each pipe is buffered
 * and drained independently and a full pipe blocks its WRITER, not its reader.
 * So a saturated event channel cannot make a cancel unreachable, and a test
 * wedges the event channel and then delivers one.
 *
 * ## The transport mints nothing
 *
 * `start` is handed the runtime's {@link RawFrameIntake} and writes decoded
 * frames into it. It never constructs a ledger, never assigns a `seq`, and has
 * no way to: the port it implements has no such method. That is why the three
 * adapters can be compared for EQUALITY rather than for similarity.
 */

import { type ChildProcessWithoutNullStreams, spawn } from 'node:child_process';
import { ProtocolError, type ProtocolLimits } from '@duya/agent-protocol';
import type {
  CapabilityRequirement,
  JsonValue,
  RunId,
  RunManifest,
  RuntimeCapabilities,
  TransportKind,
} from '@duya/agent-protocol';
import type { RawFrame } from '../translate/chat-event-translator.js';
import { NdjsonLineDecoder, encodeNdjsonLine, parseNdjsonLine } from './line-codec.js';
import type {
  RawFrameIntake,
  RuntimeTransport,
  StopReceipt,
  TransportDiagnostics,
  TransportPrivateChannel,
  TransportRun,
} from './transport-port.js';
import type { StopRequest } from './execution-channel.js';

/** The scenario the child will execute, staged before `start`. */
export interface SubprocessScenario {
  /** The frames to emit, in order. */
  readonly frames: readonly JsonValue[];
  /**
   * Private config, delivered on STDIN and never framed onto the event channel.
   * A credential that reached stdout would sit in the frame log, in every host
   * that persists frames, and in the very bytes the framing test asserts on.
   */
  readonly private?: JsonValue;
  /** Bytes per write. 1 splits every frame, every newline, every UTF-8 char. */
  readonly fragmentBytes?: number;
}

export interface SubprocessTransportOptions {
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd?: string;
  readonly env?: Readonly<Record<string, string>>;
  readonly limits?: ProtocolLimits;
  /**
   * How long a cooperative stop may take before the child is killed.
   *
   * A number rather than a deadline read from an ambient clock, because a
   * transport that reads the wall clock cannot be tested without waiting, and
   * the receipt has to distinguish "it left cleanly" from "we stopped waiting".
   */
  readonly stopGraceMs?: number;
  readonly now?: () => number;
  /** What this transport may claim it can do. Supplied, never assumed. */
  readonly capabilities: () => Promise<RuntimeCapabilities>;
  /** Capture the child's stderr. On by default: it is a real channel. */
  readonly captureStderr?: boolean;
}

const DEFAULT_STOP_GRACE_MS = 2_000;

export class SubprocessTransport implements RuntimeTransport {
  readonly kind: TransportKind = 'subprocess';
  readonly #options: SubprocessTransportOptions;
  #child: ChildProcessWithoutNullStreams | null = null;
  #scenario: SubprocessScenario | null = null;
  #closed = false;

  constructor(options: SubprocessTransportOptions) {
    this.#options = options;
  }

  probe(): Promise<RuntimeCapabilities> {
    return this.#options.capabilities();
  }

  /** Stage the scenario the next `start` dispatches. */
  stage(scenario: SubprocessScenario): void {
    this.#scenario = scenario;
  }

  async start(
    manifest: RunManifest,
    intake: RawFrameIntake,
    _require?: readonly CapabilityRequirement[],
  ): Promise<TransportRun> {
    if (this.#closed) {
      throw new ProtocolError({ code: 'transport_closed', message: 'the transport is closed' });
    }
    if (this.#child !== null) {
      throw new ProtocolError({
        code: 'transport_closed',
        message: 'a run is already open on this transport',
      });
    }
    const scenario = this.#scenario;
    if (scenario === null) {
      throw new ProtocolError({
        code: 'invalid_request',
        message: 'no scenario was staged before start',
      });
    }

    const child = spawn(this.#options.command, [...this.#options.args], {
      stdio: ['pipe', 'pipe', 'pipe'],
      ...(this.#options.cwd !== undefined ? { cwd: this.#options.cwd } : {}),
      ...(this.#options.env !== undefined ? { env: { ...process.env, ...this.#options.env } } : {}),
    });
    this.#child = child;

    // A holder rather than a `let` narrowed across callbacks: TypeScript does
    // not track assignments made inside a listener, so a plain `let` reads as
    // `null` for the rest of the function and the `!== null` checks silently
    // become `never` comparisons.
    const state: {
      bytesRead: number;
      chunksRead: number;
      framesRefused: number;
      disconnected: boolean;
      stderrBytes: number;
      stopAcknowledged: boolean;
      failure: ProtocolError | null;
    } = {
      bytesRead: 0,
      chunksRead: 0,
      framesRefused: 0,
      disconnected: false,
      stderrBytes: 0,
      stopAcknowledged: false,
      failure: null,
    };

    const decoder = new NdjsonLineDecoder(this.#options.limits);

    /** Refuse the channel: record it, stop trusting bytes, end the intake. */
    const refuse = (error: ProtocolError): void => {
      state.framesRefused += 1;
      state.disconnected = true;
      if (state.failure === null) state.failure = error;
      child.stdout.destroy();
      // Ending the intake is what closes the run. A refused frame must not
      // leave the run waiting for a terminal that can no longer arrive, and it
      // must not be reported as a success either -- the runtime decides that
      // from the absence of a terminal, which is the honest signal here.
      intake.end();
    };

    child.stdout.on('data', (chunk: Buffer) => {
      state.bytesRead += chunk.byteLength;
      state.chunksRead += 1;
      let lines: string[];
      try {
        lines = decoder.push(chunk);
      } catch (error) {
        refuse(
          error instanceof ProtocolError
            ? error
            : new ProtocolError({
                code: 'invalid_event_frame',
                message: 'the event channel produced an undecodable chunk',
              }),
        );
        return;
      }
      for (const line of lines) {
        let frame: RawFrame;
        try {
          frame = parseNdjsonLine(line) as RawFrame;
        } catch (error) {
          refuse(
            error instanceof ProtocolError
              ? error
              : new ProtocolError({
                  code: 'invalid_event_frame',
                  message: 'a line on the event channel was not valid JSON',
                }),
          );
          return;
        }
        intake.frame(frame);
      }
    });

    child.stdout.on('end', () => {
      // Truncation is only visible at the CLOSE, which is the one moment where
      // "the worker finished" and "the worker stopped mid-frame" differ.
      if (state.failure === null) {
        try {
          decoder.end();
        } catch (error) {
          state.framesRefused += 1;
          if (error instanceof ProtocolError) state.failure = error;
        }
      }
      if (state.failure !== null) state.disconnected = true;
      intake.end();
    });

    child.stderr.on('data', (chunk: Buffer) => {
      if (this.#options.captureStderr === false) return;
      state.stderrBytes += chunk.byteLength;
      if (chunk.toString('utf8').includes('stop-acknowledged')) state.stopAcknowledged = true;
    });

    child.on('error', () => {
      state.disconnected = true;
      intake.end();
    });

    const privateChannel: TransportPrivateChannel = {
      deliver: async (payload: JsonValue): Promise<void> => {
        if (child.stdin.destroyed) {
          throw new ProtocolError({ code: 'transport_closed', message: 'the private channel is closed' });
        }
        child.stdin.write(encodeNdjsonLine(payload, this.#options.limits));
      },
    };

    // The start command rides the PRIVATE channel. The event channel therefore
    // carries only what the run produced, never the instruction to produce it.
    await privateChannel.deliver({
      cmd: 'start',
      runId: manifest.runId,
      frames: scenario.frames,
      ...(scenario.fragmentBytes !== undefined ? { fragment: scenario.fragmentBytes } : {}),
      ...(scenario.private !== undefined ? { private: scenario.private } : {}),
    });

    const diagnostics = (): TransportDiagnostics => ({
      transport: this.kind,
      bytesRead: state.bytesRead,
      bytesWritten: state.stderrBytes,
      chunksRead: state.chunksRead,
      framesRefused: state.framesRefused,
      disconnected: state.disconnected,
      ...(state.failure !== null ? { detail: { refusal: state.failure.code } } : {}),
    });

    return {
      kind: this.kind,
      runId: manifest.runId as RunId,
      intake,
      privateChannel,
      handle: {
        stop: async (request: StopRequest): Promise<StopReceipt> =>
          this.#stop(child, privateChannel, request, state),
      },
      diagnostics,
      close: async (): Promise<void> => {
        if (!child.killed) child.kill();
        this.#child = null;
      },
    };
  }

  /**
   * Stop the child, and report which of three different things happened.
   *
   * R2.3's receipt, over a real process. The outcomes are genuinely
   * indistinguishable from the outside -- the child either answered, we killed
   * it, or it was already gone -- and a transport that reported success for all
   * three is how a cancel came to mean "we stopped waiting".
   */
  async #stop(
    child: ChildProcessWithoutNullStreams,
    channel: TransportPrivateChannel,
    request: StopRequest,
    state: { stopAcknowledged: boolean },
  ): Promise<StopReceipt> {
    const now = this.#options.now ?? (() => Date.now());
    const startedAt = now();

    if (child.exitCode !== null || child.killed) {
      return { requested: false, disposition: 'unavailable', waitedMs: 0, reason: request.reason };
    }
    try {
      // STDIN, not stdout. The claim T3.4 could only make at the port layer,
      // measured here: the event channel is wedged in the test that exercises
      // this path, and the stop still lands.
      await channel.deliver({ cmd: 'stop', reason: request.reason });
    } catch {
      return {
        requested: false,
        disposition: 'unavailable',
        waitedMs: now() - startedAt,
        reason: request.reason,
      };
    }

    const graceMs = this.#options.stopGraceMs ?? DEFAULT_STOP_GRACE_MS;
    const deadline = Date.now() + graceMs;
    while (Date.now() < deadline) {
      if (state.stopAcknowledged || child.exitCode !== null) break;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }

    if (state.stopAcknowledged || child.exitCode !== null) {
      return {
        requested: true,
        disposition: 'cooperative',
        waitedMs: now() - startedAt,
        reason: request.reason,
      };
    }
    child.kill();
    return {
      requested: true,
      disposition: 'escalated',
      waitedMs: now() - startedAt,
      reason: request.reason,
    };
  }

  async close(): Promise<void> {
    this.#closed = true;
    const child = this.#child;
    if (child !== null && !child.killed) child.kill();
    this.#child = null;
  }
}
