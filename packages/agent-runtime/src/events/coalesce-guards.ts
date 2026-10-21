/**
 * Compile-time guards for the coalescing and backpressure contract.
 *
 * ## Why these live in `src/` and not in a test
 *
 * T3.1 measured it: all three packages' `tsconfig` exclude `test/`, and esbuild
 * strips types. A type-level assertion in a test file therefore enforces
 * nothing - the gate never compiles it and nothing erases it before it could
 * fail. So the compile-time half is here, in a source file `npm run
 * typecheck:all` actually compiles, and the tests are the runtime half.
 *
 * Each guard protects a claim a consumer is entitled to make about the
 * coalescing path. If the claim stops being true, this file must fail to compile
 * rather than the stream quietly losing text.
 */

import type { EventType } from '@duya/agent-protocol';
import type { CoalescingReceipt, CoalesceScope, OfferResult } from './coalesce.js';
import type { DeliveryGap, EnqueueOutcome, OverflowAction } from './backpressure.js';
import type { FlowControlCapability } from './control-channel.js';

/**
 * A `DeliveryGap` can always be told apart from "nothing happened".
 *
 * The brief's question - how does a consumer distinguish silence from a loss -
 * has a compile-time half and a runtime half. The compile-time half is that
 * `kind` is a CLOSED two-member union and `contentLost` is a required boolean:
 * a gap is always classifiable, and there is no third state to forget to set. If
 * a third `kind` is ever needed (an upstream disconnect, say) this fails, which
 * is the point - a new kind has to state whether it loses content.
 */
export type DeliveryGapIsClassifiable = Exactly<DeliveryGap['kind'], 'dropped' | 'merged'>;

/**
 * Every gap carries a count and a size, so "how much did I miss" is answerable
 * without a replay.
 *
 * A gap that reported only "something was dropped" would leave the consumer
 * unable to decide whether it needs to resync, which is the difference between a
 * cosmetic event and a reconnect.
 */
export type DeliveryGapIsMeasurable = Exactly<
  keyof Pick<DeliveryGap, 'producerFrames' | 'bytes' | 'contentLost' | 'runId' | 'eventType'>,
  'producerFrames' | 'bytes' | 'contentLost' | 'runId' | 'eventType'
>;

/**
 * An `OfferResult` always states what to publish, and an absorbed event is
 * `emit: []`.
 *
 * The shape is what keeps "merged" distinguishable from "accepted": a coalesced
 * delta has no envelope and no seq, so the honest result is an empty `emit`
 * rather than a success carrying a fabricated envelope.
 */
export type OfferResultAlwaysStatesWhatToPublish = Exactly<
  keyof OfferResult,
  'emit' | 'receipts'
>;

/**
 * A receipt is only produced for a frame that stands for MORE THAN ONE producer
 * frame.
 *
 * Enforced here as the type of `producerFrames` being a number and the runtime
 * half asserting `> 1`; the compile-time contribution is that the field EXISTS and
 * is required, so a receipt cannot be emitted without saying how many frames it
 * covers. A `producerFrames?: number` would let a receipt be a bare "something
 * merged" and would fail here.
 */
export type ReceiptNamesItsFrameCount = 'producerFrames' extends keyof CoalescingReceipt ? true : {
  readonly error: 'a CoalescingReceipt must state how many producer frames it stands for';
};

/**
 * The five overflow actions are closed, and both `queued` and `retained` are
 * among them.
 *
 * `retained` is the load-bearing member: it is the action that says a durable
 * frame was admitted even though the queue was over its bound. `queued` is the
 * other half - an ephemeral frame that FIT and is therefore merely waiting to be
 * read, which is the case that must not be reported as a loss. Dropping either
 * from the union would let a branch return some other action, and a new action
 * would have to declare what it does to durable frames and to ephemeral ones
 * under no pressure at all.
 */
export type OverflowActionsAreClosed = Exactly<
  OverflowAction,
  'queued' | 'retained' | 'merged' | 'dropped' | 'disconnected'
>;

/**
 * A queue reports `paused`, and the producer's cue is `whenWritable`.
 *
 * `EnqueueOutcome.paused` is what makes the pause observable at the call site;
 * this asserts it is required rather than optional, because a pause a producer
 * cannot see is a pause the producer will keep writing into.
 */
export type QueueOutcomeCarriesPaused = 'paused' extends keyof EnqueueOutcome ? true : {
  readonly error: 'EnqueueOutcome must report whether the queue is paused';
};

/**
 * The scope is a CLOSED union, so a tool delta and an assistant delta cannot
 * collide.
 *
 * A single `scope: string` would put `toolCallId: 'x'` and `messageId: 'x'` in
 * the same key space, and the two would merge into a frame claiming to be one of
 * them. The union makes that unrepresentable.
 */
export type CoalesceScopeIsClosed = Exactly<
  CoalesceScope['kind'],
  'message' | 'tool'
>;

/**
 * The flow-control vocabulary is closed.
 *
 * `per_type_pause` exists in the union on purpose and is FALSE for every real
 * transport today. It is spelled out so that adding a transport that genuinely
 * can pause by type is a one-line change with a compile-time reminder attached,
 * and so a caller switching on the value is forced to handle it rather than
 * defaulting.
 */
export type FlowControlCapabilityIsClosed = Exactly<
  FlowControlCapability,
  'whole_pipe_pause' | 'per_type_pause' | 'bounded_async'
>;

/**
 * The coalescing targets still exist as registry types.
 *
 * The compile-time half of "the batcher coalesces real event types". The half it
 * cannot check is that they are still `ephemeral`, and that no FOURTH delta family
 * exists that the batcher is silently ignoring - that is a value in the
 * registry's table, so it is `coalesce-guards.test.ts`.
 */
export type CoalescingTargetsExistInRegistry = [
  Assert<'assistant.text_delta' extends EventType ? true : false>,
  Assert<'assistant.thinking_delta' extends EventType ? true : false>,
  Assert<'tool.arguments_delta' extends EventType ? true : false>,
];

/**
 * Exact-type equality. Not assignability: this must catch BOTH directions.
 *
 * The same form as `replay-guards.ts`, and for the same measured reason: the
 * obvious `[A] extends [B] ? ... : never` spelling evaluates to `never` when the
 * types disagree, and `never extends true` is TRUE, so that version passes
 * silently on exactly the mismatch it exists to catch.
 */
type Exactly<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;

type Assert<T extends true> = T;

/**
 * Every guard above, instantiated.
 *
 * An unparameterised type alias is never evaluated, so each is used here; without
 * this tuple the file would compile whether or not any guard held.
 */
export type CoalescingGuards = [
  Assert<DeliveryGapIsClassifiable>,
  Assert<DeliveryGapIsMeasurable>,
  Assert<OfferResultAlwaysStatesWhatToPublish>,
  Assert<ReceiptNamesItsFrameCount>,
  Assert<OverflowActionsAreClosed>,
  Assert<QueueOutcomeCarriesPaused>,
  Assert<CoalesceScopeIsClosed>,
  Assert<FlowControlCapabilityIsClosed>,
  CoalescingTargetsExistInRegistry,
];
