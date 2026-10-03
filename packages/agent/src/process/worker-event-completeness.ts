/**
 * The compile-time half of the `WorkerEvent` completeness guard.
 *
 * ## What it catches
 *
 * `WorkerEvent` in `./worker-protocol.ts` is the union a consumer narrows on to
 * decide what a worker frame is. T3.1 measured it at 27 members against 33
 * exported `*Event` interfaces and recorded the gap without fixing it. T3.2
 * closes the union, and this file is what stops it reopening: remove any
 * interface from the union and this stops compiling.
 *
 * ## Why it lists the interfaces by hand, and why that is still a real guard
 *
 * TypeScript has no way to say "every exported interface in that file", so the
 * list here is written out. That is a second list, and a second list is exactly
 * what this guard exists to prevent — so it is only half the answer, and the
 * honest half is in `test/worker-event-completeness.test.ts`, which parses the
 * source and fails when an interface appears that this file does not list.
 *
 * The division of labour is by what each mechanism can actually do:
 *
 *  - this file is a COMPILE error, so a gap cannot be merged. It covers the
 *    interfaces someone already knows about, which is the whole of the gap
 *    T3.1 found.
 *  - the test is a RUN error, so a newly-declared interface is caught too, but
 *    only when the suite runs.
 *
 * Neither alone is sufficient; together the known gap cannot merge and a new
 * one cannot merge silently either.
 *
 * ## Why it is in `src/` at all
 *
 * `packages/agent/tsconfig.json` excludes the test globs, and vitest runs
 * TypeScript through esbuild, which strips types
 * without checking them. A guard written in a test directory would therefore
 * enforce nothing — T3.1 measured exactly that: deleting a union member left the
 * drift test green while `typecheck` failed. The same lesson is why the two
 * protocol guards and `CRITICALITY_MATCHES_RESERVED_NAMESPACES` live in `src/`.
 */

import type {
  AgentAgentProgressEvent,
  AgentDbPersistedEvent,
  AgentDebugEvent,
  AgentDoneEvent,
  AgentErrorEvent,
  AgentModeChangedEvent,
  AgentPermissionEvent,
  AgentRetryEvent,
  AgentStatusEvent,
  AgentTextEvent,
  AgentThinkingEvent,
  AgentTitleGeneratedEvent,
  CheckpointEvent,
  ClipboardWriteEvent,
  CompactDoneEvent,
  CompactErrorEvent,
  CompactOverThresholdEvent,
  CompactStepEvent,
  CompactSummaryOutcomeEvent,
  DbRequestEvent,
  GoalUpdatedEvent,
  MemoryWakeupEvent,
  MemoryWarningEvent,
  PongEvent,
  ReadyEvent,
  ResearchUpdatedEvent,
  SkillsStatusEvent,
  SubagentToolProgressEvent,
  SubagentToolResultEvent,
  SubagentToolUseDeltaEvent,
  SubagentToolUseEvent,
  SubagentToolUseStartedEvent,
  WorkerEvent,
  WorkflowRunEvent,
} from './worker-protocol.js';

/**
 * Every `*Event` interface the worker protocol module exports.
 *
 * The 27 that were always here plus the 6 T3.1 found missing. If one is ever
 * dropped from the union, it survives `Exclude` and the constant below cannot
 * be assigned.
 */
type EveryWorkerEventInterface =
  | AgentAgentProgressEvent
  | AgentDbPersistedEvent
  | AgentDebugEvent
  | AgentDoneEvent
  | AgentErrorEvent
  | AgentModeChangedEvent
  | AgentPermissionEvent
  | AgentRetryEvent
  | AgentStatusEvent
  | AgentTextEvent
  | AgentThinkingEvent
  | AgentTitleGeneratedEvent
  | CheckpointEvent
  | ClipboardWriteEvent
  | CompactDoneEvent
  | CompactErrorEvent
  | CompactOverThresholdEvent
  | CompactStepEvent
  | CompactSummaryOutcomeEvent
  | DbRequestEvent
  | GoalUpdatedEvent
  | MemoryWakeupEvent
  | MemoryWarningEvent
  | PongEvent
  | ReadyEvent
  | ResearchUpdatedEvent
  | SkillsStatusEvent
  | SubagentToolProgressEvent
  | SubagentToolResultEvent
  | SubagentToolUseDeltaEvent
  | SubagentToolUseEvent
  | SubagentToolUseStartedEvent
  | WorkflowRunEvent;

/** Whatever is in the interface list but NOT in the union. `never` when complete. */
type MissingFromUnion = Exclude<EveryWorkerEventInterface, WorkerEvent>;

/** Fails to COMPILE while any exported event interface is absent from the union. */
export type WorkerEventUnionIsComplete = [MissingFromUnion] extends [never] ? true : false;

export const WORKER_EVENT_UNION_IS_COMPLETE: WorkerEventUnionIsComplete = true;
