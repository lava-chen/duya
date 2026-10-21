/**
 * Resume boundaries.
 *
 * The load-bearing rule is the refusal: **a resume whose `seq` falls strictly
 * between a `tool.call_started` and its terminal event is REJECTED.** Tool side
 * effects are not transactional, so mid-tool recovery silently re-executes
 * them. Today's 500-event replay ring is lossy and untyped
 * (`SessionEventRecord.data: unknown`, server/types.ts:32-37) and nothing
 * prevents it. The protocol has to.
 */

import type { EventType } from './events/registry.js';

export type ResumeBoundary =
  /** Cleanest: the transcript is consistent and no tool is in flight. */
  | { readonly kind: 'turn_boundary'; readonly turnIndex: number }
  /** Needs a replay window of at least `seq` events. */
  | { readonly kind: 'event_seq'; readonly seq: number }
  /** A FORK, not a continuation: new runId, new parentRunId, reused prefix. */
  | { readonly kind: 'message_index'; readonly atMessageIndex: number }
  /**
   * The only boundary that survives runtime process death — a storage read.
   *
   * Gated on the `checkpoint_resume` host capability: a host that cannot
   * consume `checkpoint.saved` must not be offered this boundary, and a runtime
   * with no checkpoint repository must advertise `false` here rather than
   * discover the gap when a host asks.
   */
  | { readonly kind: 'checkpoint_generation'; readonly generation: number; readonly checkpointRef?: string };

export type ResumeBoundaryKind = ResumeBoundary['kind'];

export interface ResumeRequest {
  readonly from: ResumeBoundary;
  readonly additionalInput?: unknown;
}

export interface ResumeSupport {
  readonly turnBoundary: boolean;
  readonly eventSeq: boolean;
  readonly messageIndex: boolean;
  readonly checkpointGeneration: boolean;
  /**
   * The replay range this runtime can still serve, as SEQUENCE NUMBERS.
   *
   * Not a count. An earlier draft advertised `replayWindow: number` and tested
   * `from.seq <= replayWindow`, which compares an absolute sequence number
   * against a buffer size and is wrong the moment a run is longer than the
   * buffer. With a 500-entry ring and a run currently at `seq = 1200`, the ring
   * holds 701–1200, so resuming from 1000 is perfectly served while
   * `1000 <= 500` is false — a legal resume refused, with no way for a host to
   * tell the difference between "too old" and "not supported".
   *
   * `oldestAvailableSeq > latestSeq` means nothing is replayable.
   */
  readonly oldestAvailableSeq: number;
  readonly latestSeq: number;
  /**
   * Always true. Mid-tool resume is not merely unsupported, it is refused, and
   * the refusal is part of the advertised contract so a host can plan a run
   * that is safe to resume.
   */
  readonly rejectsMidToolResume: true;
}

export const NO_RESUME: ResumeSupport = {
  turnBoundary: false,
  eventSeq: false,
  messageIndex: false,
  checkpointGeneration: false,
  oldestAvailableSeq: 1,
  latestSeq: 0,
  rejectsMidToolResume: true,
};

/** Is `seq` still inside the replay range? */
export function isReplayable(support: ResumeSupport, seq: number): boolean {
  return support.oldestAvailableSeq <= seq && seq <= support.latestSeq;
}

/** Does this support profile cover the requested boundary? */
export function supportsBoundary(support: ResumeSupport, from: ResumeBoundary): boolean {
  switch (from.kind) {
    case 'turn_boundary':
      return support.turnBoundary;
    case 'event_seq':
      return support.eventSeq && isReplayable(support, from.seq);
    case 'message_index':
      return support.messageIndex;
    case 'checkpoint_generation':
      return support.checkpointGeneration;
  }
}

/** `message_index` produces a NEW run; the others continue the same one. */
export function isFork(from: ResumeBoundary): boolean {
  return from.kind === 'message_index';
}

/**
 * The refusal reason when a boundary is not covered.
 *
 * `replay_unavailable` when the shape is supported but the requested `seq` has
 * already fallen out of the replay range; `invalid_resume_point` for mid-tool
 * resumes and for shapes the runtime does not support at all. A host that gets
 * `replay_unavailable` can retry from an older checkpoint; one that gets
 * `invalid_resume_point` cannot, so conflating the two strands it.
 */
export function resumeRefusalCode(
  support: ResumeSupport,
  from: ResumeBoundary,
  midTool = false,
): 'replay_unavailable' | 'invalid_resume_point' {
  if (midTool) return 'invalid_resume_point';
  if (from.kind === 'event_seq' && support.eventSeq && !isReplayable(support, from.seq)) {
    return 'replay_unavailable';
  }
  return 'invalid_resume_point';
}

/**
 * Events whose arrival means "a tool is in flight". Used by runtimes to
 * decide whether a boundary is mid-tool.
 *
 * `tool.call_preview` is deliberately ABSENT. A preview says a call is coming;
 * it is volatile, and no side effect has been attempted. A resume boundary that
 * lands between a preview and the authoritative `tool.call_started` is a clean
 * boundary — the tool never ran. Including it here would refuse a large number
 * of perfectly safe resumes.
 */
export const TOOL_LIFECYCLE_EVENTS: ReadonlySet<EventType> = new Set<EventType>([
  'tool.call_started',
  'tool.call_completed',
  'tool.timed_out',
]);
