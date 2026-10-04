/**
 * Branching: a user forking off an old message.
 *
 * ## Why a branch is a NEW RUN and not a resume
 *
 * Contract §G: `用户从旧消息分支形成新run+parentRunId`, against
 * `execution resume形成新attempt/epoch与fence` for the other case. The
 * distinction is the whole point and conflating them is the mistake:
 *
 *  - a RESUME continues one logical run. Same `runId`, new attempt, same
 *    history, and a fence so the old attempt cannot keep writing.
 *  - a BRANCH starts a different conversation. New `runId`, new history, and
 *    `parentRunId` recording where it came from.
 *
 * Reusing the parent's `runId` for a branch would be the worst of both: the
 * parent's terminal would be the branch's, the branch's events would append to
 * the parent's `seq` space, and the fork would be unrepresentable in the log
 * because the log keys on `(runId, seq)`.
 *
 * ## What the parent keeps
 *
 * Everything, byte for byte. A branch is a read of the parent plus a write of
 * the child, and the read half must not be able to modify what it read. The
 * copy below is therefore built from the parent's stored events and nothing
 * else, and the parent is never passed to a function that could write it.
 */

import type { RunEventEnvelope, RunId, SessionId } from '@duya/agent-protocol';

/**
 * The transcript prefix a branch inherits.
 *
 * Copied as ENVELOPES, renumbered into the child's own `seq` space, and
 * marked. The renumbering is not cosmetic: the child's ledger mints its own
 * gapless `seq` from 1, so reusing the parent's absolute numbers would put the
 * child's first real event at whatever number the parent had reached, and the
 * gap between the two would read as lost events.
 *
 * The `inheritedFromSeq` field is what keeps the provenance honest after
 * renumbering — without it, a reader of the child's log could not tell an
 * inherited message from one this run produced.
 */
export interface InheritedEvent {
  readonly seq: number;
  readonly inheritedFromSeq: number;
  readonly envelope: RunEventEnvelope;
}

export interface BranchPlan {
  /** Minted by the caller or the store. Never the parent's id. */
  readonly runId: RunId;
  readonly sessionId: SessionId;
  readonly parentRunId: RunId;
  /** The parent's last seq, recorded so the fork point is legible later. */
  readonly forkedFromSeq: number;
  readonly events: readonly InheritedEvent[];
}

export type BranchResult =
  | { readonly kind: 'branched'; readonly plan: BranchPlan }
  | {
      readonly kind: 'refused';
      readonly code: 'fork_after_terminal' | 'empty_parent' | 'seq_gap';
      readonly detail: string;
    };

/**
 * Build the child's opening history from the parent's.
 *
 * `atSeq` is the fork point: events with `seq <= atSeq` are inherited. It is
 * REQUIRED rather than defaulted, because "branch from the latest message" is
 * a UI affordance and the value it passes is a decision about which history the
 * user is keeping — defaulting it would make a wrong fork look deliberate.
 */
export function planBranch(input: {
  readonly parentRunId: RunId;
  readonly sessionId: SessionId;
  readonly newRunId: RunId;
  /** The parent's events, in ascending `seq`. */
  readonly parentEvents: readonly RunEventEnvelope[];
  readonly atSeq: number;
  /** Did the parent reach a terminal event? Read from the parent, not guessed. */
  readonly parentTerminated: boolean;
}): BranchResult {
  if (input.parentEvents.length === 0) {
    return {
      kind: 'refused',
      code: 'empty_parent',
      detail: `run ${input.parentRunId} holds no events, so there is no history to branch from`,
    };
  }

  if (input.newRunId === input.parentRunId) {
    return {
      kind: 'refused',
      code: 'seq_gap',
      detail: 'the branch must be a NEW run; reusing the parent id would merge two histories',
    };
  }

  // Branching off a TERMINAL run is legitimate — it is what "edit and resend"
  // does — but only up to the terminal. A fork point past the end would inherit
  // nothing after a seq that does not exist, and would silently branch from
  // the whole conversation instead.
  const highest = input.parentEvents[input.parentEvents.length - 1]?.seq ?? 0;
  if (input.atSeq > highest) {
    return {
      kind: 'refused',
      code: 'fork_after_terminal',
      detail:
        input.parentTerminated
          ? `seq ${input.atSeq} is past the end of the terminated run ${input.parentRunId} (highest seq ${highest})`
          : `seq ${input.atSeq} is past the end of run ${input.parentRunId} (highest seq ${highest})`,
    };
  }

  const inherited = input.parentEvents.filter((e) => e.seq <= input.atSeq);
  const events: InheritedEvent[] = [];
  for (const envelope of inherited) {
    const seq = events.length + 1;
    events.push({
      seq,
      inheritedFromSeq: envelope.seq,
      envelope: {
        ...envelope,
        runId: input.newRunId,
        sessionId: input.sessionId,
        seq,
      },
    });
  }

  return {
    kind: 'branched',
    plan: {
      runId: input.newRunId,
      sessionId: input.sessionId,
      parentRunId: input.parentRunId,
      forkedFromSeq: input.atSeq,
      events,
    },
  };
}
