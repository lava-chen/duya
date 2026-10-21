import {
  RunEngineImpl,
  type RunEnginePorts,
  type RunInputSnapshot,
  type TerminalCandidate,
} from '@duya/agent-runtime';
import type { RunEvent, RunEventEnvelope, RunManifest, RunTerminalState } from '@duya/agent-protocol';
import type { RunEventSpine } from './run-event-spine.js';

export interface ExecuteRunEngineOptions {
  readonly spine: RunEventSpine;
  readonly manifest: RunManifest;
  readonly input: RunInputSnapshot;
  readonly signal: AbortSignal;
  readonly ports: RunEnginePorts;
  readonly maxTurns?: number;
  readonly onEnvelope: (envelope: RunEventEnvelope) => void | Promise<void>;
}

export interface RunEngineExecutionResult {
  readonly proposed: TerminalCandidate | null;
  readonly terminal: RunTerminalState;
}

/** Execute one already-assembled run and own its event drain and settlement. */
export async function executeRunEngine(
  options: ExecuteRunEngineOptions,
): Promise<RunEngineExecutionResult> {
  const engine = new RunEngineImpl({
    now: () => Date.now(),
    ...(options.maxTurns === undefined ? {} : { defaultMaxTurns: options.maxTurns }),
  });
  const execution = engine.execute({
    manifest: options.manifest,
    input: options.input,
    signal: options.signal,
    ports: options.ports,
  });

  // Drain beside execution. Awaiting execution first can overflow the bounded
  // stream before the consumer sees the run's first events.
  const drained = drainSpine(options.spine, options.onEnvelope);
  let terminal: RunTerminalState;
  try {
    await execution.completed();
  } finally {
    terminal = await settleAndCloseSpine(options.spine, options.spine.proposedTerminal());
  }
  await drained;

  return {
    proposed: options.spine.proposedTerminal(),
    terminal,
  };
}

async function drainSpine(
  spine: RunEventSpine,
  onEnvelope: (envelope: RunEventEnvelope) => void | Promise<void>,
): Promise<void> {
  for await (const envelope of spine.stream) {
    // The production spine only publishes envelopes minted by RunEventEmitter.
    // Its shared EventSource type also permits UnknownEnvelope for decoded
    // remote streams, which this local producer cannot emit.
    await onEnvelope(envelope as unknown as RunEventEnvelope);
  }
}

/**
 * Commit the proposed terminal, release its held event, then close the stream.
 *
 * RunSession.settle is the single terminal writer and derives its decision from
 * observed events. The engine only records a candidate, so publish the matching
 * terminal event through the emitter first. The emitter holds that event until
 * settle returns; publishCommittedTerminal then releases it only if the durable
 * terminal agrees. Closing last lets the drain observe the committed terminal,
 * while the finally block guarantees a failed settle cannot leave it parked.
 */
async function settleAndCloseSpine(
  spine: RunEventSpine,
  candidate: TerminalCandidate | null,
): Promise<RunTerminalState> {
  try {
    if (candidate !== null) {
      const state = candidate.state;
      const event: RunEvent = state.status === 'failed'
        ? { type: 'run.failed', error: state.error }
        : {
            type: 'run.completed',
            status: state.status,
            ...(state.stopReason === undefined ? {} : { stopReason: state.stopReason }),
          };
      spine.emitter.emit(event);
    }
    const terminal = await spine.session.settle(
      candidate === null
        ? undefined
        : candidate.state.status === 'cancelled'
          ? { cancelRequested: true, requestedReason: candidate.reason }
          : {},
    );
    await spine.emitter.publishCommittedTerminal(terminal);
    return terminal;
  } finally {
    // Closing last releases the drain only after the committed terminal is sent.
    spine.stream.close();
  }
}
