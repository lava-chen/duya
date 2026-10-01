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
  /** The only boundary that survives runtime process death — a storage read. */
  | { readonly kind: 'checkpoint_generation'; readonly generation: number };

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
  /** Envelopes retained for `event_seq` resumption. Honest, not aspirational:
   *  the runtime advertises what it can actually serve. */
  readonly replayWindow: number;
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
  replayWindow: 0,
  rejectsMidToolResume: true,
};

/** Does this support profile cover the requested boundary? */
export function supportsBoundary(support: ResumeSupport, from: ResumeBoundary): boolean {
  switch (from.kind) {
    case 'turn_boundary':
      return support.turnBoundary;
    case 'event_seq':
      return support.eventSeq && from.seq <= support.replayWindow;
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
 * The refusal reason when a boundary is not covered. Mapped to
 * `replay_unavailable` (window too small) or `invalid_resume_point`
 * (mid-tool, or the shape is not supported at all).
 */
export function resumeRefusalCode(
  support: ResumeSupport,
  from: ResumeBoundary,
  midTool = false,
): 'replay_unavailable' | 'invalid_resume_point' {
  if (midTool) return 'invalid_resume_point';
  if (from.kind === 'event_seq' && from.seq > support.replayWindow) {
    return 'replay_unavailable';
  }
  return 'invalid_resume_point';
}

/** Events whose arrival means "a tool is in flight". Used by runtimes to
 *  decide whether a boundary is mid-tool. */
export const TOOL_LIFECYCLE_EVENTS: ReadonlySet<EventType> = new Set<EventType>([
  'tool.call_started',
  'tool.call_completed',
  'tool.timed_out',
]);
