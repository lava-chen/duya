/**
 * Plan 610 D1 -- the run's EVENT SPINE, supplied for real.
 *
 * ## What was missing, and what this file is
 *
 * `composeLegacyRunPorts` has bound `emitter`, `proposeTerminal` and
 * `seqIndex` since it existed (`run-composition.ts:618-619,624`), so the
 * composition was never the gap. The gap was on the HOST side of those three
 * members: `LegacyRunHost` declares them, and every caller in the tree builds
 * the object by hand -- fourteen tests, each with its own `new RunSession` and
 * its own `new RunEventEmitter` (`engine-before-commit-phase.test.ts:327-341`
 * is the shape). Nothing in production produced them, which is why a probe
 * found the emitter, the terminal proposer and the session wiring all at zero
 * outside tests, and why the engine could be driven by a test but not by a run.
 *
 * So this file is a PRODUCER of host facts, not a second composition. It builds
 * the three objects the spine is made of and hands back exactly the
 * `LegacyRunHost` members the existing assembly already reads. Assembly stays
 * in `composeLegacyRunPorts`; if this file started building ports it would be a
 * second answer to "which turn owns this pipeline", which is the failure this
 * plan has already had to undo once.
 *
 * ## `proposeTerminal` RECORDS, and why that is not a watered-down port
 *
 * `RunEventStorePort.proposeTerminal` is documented as advisory and names
 * `RunSession.settle` the single writer of the terminal
 * (`packages/agent-runtime/src/engine/ports.ts:1028-1035`). This file
 * therefore records the candidate and settles nothing. A binding that settled
 * here would be a second terminal authority, and the run's last recorded
 * candidate is exactly the input `settle` needs to merge -- so recording is
 * the whole job, not a stub.
 *
 * ## What this file deliberately does NOT do
 *
 * It does not flip the driver. `agent-process-entry.ts` still calls
 * `streamChat`, and nothing here is reached from the live path yet, so the
 * legacy still drives every real turn. It decides nothing about a turn: no
 * prompt, no tool, no stop reason, no usage. It opens a ledger and mints a
 * sequence number, which is what "the run's event spine" means.
 */

import {
  RunEventEmitter,
  RunEventStream,
  RunSession,
} from '@duya/agent-runtime';
import type { RunPersistence, TerminalCandidate } from '@duya/agent-runtime';

/** The persistence a spine writes its durable events through. */
export type SpinePersistence = RunPersistence;

/**
 * Everything a run needs to open its spine.
 *
 * `runId` and `sessionId` are required because a durable event stamped with the
 * wrong run is a row no reader can find. `seqIndex` is required for the reason
 * `LegacyRunHost.seqIndex` gives (`run-composition.ts:388-395`): a default
 * would stamp rows with a constant that silently mis-orders them against real
 * transcript rows.
 */
export interface RunEventSpineOptions {
  readonly runId: string;
  readonly sessionId: string;
  /**
   * `Date.now()` taken once per run, exactly as the legacy takes it once per
   * `streamChat` and threads through every row it writes.
   */
  readonly seqIndex: number;
  readonly now?: () => number;
  readonly clock?: () => number;
  /** Durable sink. Defaults to a no-op, which is a run with no Control Plane. */
  readonly persistence?: SpinePersistence;
  /**
   * Where a minted envelope is announced.
   *
   * Optional because a run with no observer is legitimate (the CLI, a test).
   * When it IS supplied every durable event goes through it, because
   * `RunEventEmitter` already pushed the envelope to the run's own stream --
   * a second `stream.push` here is the duplicate the emitter's own header
   * (`event-emitter.ts:293`) exists to prevent.
   */
  readonly onAnnounce?: (envelope: unknown) => void;
}

/** The spine's parts, plus the host members the existing assembly consumes. */
export interface RunEventSpine {
  /** The run's ledger-backed session. Mints `seq`, counts, buffers, persists. */
  readonly session: RunSession;
  /** The run's live stream, for observers. */
  readonly stream: RunEventStream;
  /** The one emit entry point. Passed to the composition as `host.emitter`. */
  readonly emitter: Pick<RunEventEmitter, 'emit' | 'publish' | 'publishCommittedTerminal'>;
  /** Passed to the composition as `host.proposeTerminal`. Records; never settles. */
  readonly proposeTerminal: (candidate: TerminalCandidate) => void;
  /** Passed to the composition as `host.seqIndex`. */
  readonly seqIndex: number;
  /**
   * The last candidate the engine proposed, or `null`.
   *
   * Exposed so whoever settles the run reads the engine's own record rather
   * than re-deriving it. A run that never proposed anything is `null`, which
   * is a different fact from "proposed an empty candidate".
   */
  readonly proposedTerminal: () => TerminalCandidate | null;
}

/**
 * Open a run's event spine.
 *
 * Builds the three objects in the order the run needs them: the session first
 * (it is the ledger), then the stream, then the emitter over both. That order
 * is the controller's (`controller.ts:497,536,537`) and it is not incidental --
 * the emitter's terminal hold is keyed on the EVENT by `#mint`, so a run whose
 * emitter was assembled over anything but its own session would announce a
 * terminal before its durable barrier answered.
 */
export function createRunEventSpine(options: RunEventSpineOptions): RunEventSpine {
  const { runId, sessionId, seqIndex } = options;
  const now = options.now ?? Date.now;
  const clock = options.clock ?? Date.now;

  const session = new RunSession({
    runId,
    sessionId,
    now,
    startedAt: clock(),
    clock,
    persistence: options.persistence ?? {
      append: async () => undefined,
      complete: async () => undefined,
    },
  });

  const stream = new RunEventStream();
  // One PUBLICATION, two consumers. `RunEventStream` is a push queue with no
  // `subscribe` (`run-session.ts:1126-1132`), so the observer is a second arm on
  // the publisher the emitter already writes to rather than a second write --
  // an event announced twice is the duplicate the emitter's own header
  // (`event-emitter.ts:293`) exists to prevent.
  const publisher = options.onAnnounce === undefined
    ? stream
    : {
        push(envelope: Parameters<RunEventStream['push']>[0]): void {
          stream.push(envelope);
          (options.onAnnounce as (value: unknown) => void)(envelope);
        },
      };
  const emitter = new RunEventEmitter({ session, stream: publisher, runId });

  // Advisory. Recorded, never settled -- `ports.ts:1028-1035` names
  // `RunSession.settle` the single writer of the terminal.
  let proposed: TerminalCandidate | null = null;
  const proposeTerminal = (candidate: TerminalCandidate): void => {
    proposed = candidate;
  };

  return {
    session,
    stream,
    emitter,
    proposeTerminal,
    seqIndex,
    proposedTerminal: () => proposed,
  };
}
