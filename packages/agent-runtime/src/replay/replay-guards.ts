/**
 * Compile-time guards for the replay contract.
 *
 * ## Why these live in `src/` and not in a test
 *
 * T3.2 recorded the reason and it applies unchanged: all three packages'
 * `tsconfig` exclude `test/`, and esbuild strips types. A type-level assertion
 * in a test file therefore enforces nothing - the file is not compiled by the
 * gate and its types are erased before anything runs. So the guards are here,
 * in a source file that `npm run typecheck:all` actually compiles, and the
 * tests are the runtime half.
 *
 * Each guard below protects a claim a consumer is entitled to make. If the
 * claim stops being true, this file must fail to compile rather than the replay
 * path failing quietly at runtime.
 */

import type { ReplayCursor, ReplayRefusal, ReplayWindow } from '@duya/agent-protocol';
import type { EventType } from '@duya/agent-protocol';
import type { ReplayOutcome } from './replay-repository.js';

/**
 * `ReplayOutcome` has exactly these three kinds.
 *
 * Not documentation: a new kind added to the union makes this an error, so the
 * exhaustive `switch` in `replay-subscription.ts` and any future consumer must
 * state what they do with it. The failure this prevents is concrete - a
 * `snapshot_resync` handled as if it were a `replay` would hand a consumer a
 * rebuilt transcript while it believed it had received the run's events.
 */
export type ReplayOutcomeKindsAreExhaustive = Exactly<
  ReplayOutcome['kind'],
  'replay' | 'snapshot_resync' | 'refused'
>;

/**
 * Every refusal is one of the three codes, and the two scope codes stay
 * distinct from `replay_unavailable`.
 *
 * `resume.ts` already makes that distinction a promise to hosts - one is
 * retryable, the other is not - so collapsing them here would break a promise
 * made in a different file.
 */
export type ReplayRefusalIsComplete = Exactly<
  ReplayRefusal,
  'replay_unavailable' | 'cursor_run_mismatch' | 'cursor_epoch_mismatch'
>;

/**
 * A window reports BOTH durable bounds and the run's minted latest.
 *
 * This is the "some events are missing" guard, in type form. If `mintedLatest`
 * is dropped from `ReplayWindow`, every consumer's "am I current?" silently
 * becomes "am I past the last DURABLE event", which is a different question, and
 * the run's non-durable tail becomes unreportable. A field that must not go
 * missing is a field a mapped type can police.
 */
export type ReplayWindowCarriesMintedLatest = 'mintedLatest' extends keyof ReplayWindow
  ? true
  : { readonly error: 'ReplayWindow must report mintedLatest as well as the durable bounds' };

/**
 * A cursor cannot be built without a run and an epoch.
 *
 * `ReplayCursor`'s fields are all `readonly` and all required, which is the
 * whole enforcement - there is no overload or constructor that produces a
 * partial cursor. This alias is the compile-time statement of it: a change that
 * made either field optional, or added a second cursor shape, breaks here.
 */
export type ReplayCursorIsScoped = Exactly<keyof ReplayCursor, 'runId' | 'epoch' | 'afterSeq'>;

/**
 * The three types the text rebuild reads really exist in the registry.
 *
 * Item 4 of T3.3 is the claim that a consumer can rebuild text and thinking
 * after a dropped delta, and it rests entirely on this set. So the compile-time
 * half is "these three names are real `EventType`s": rename or drop one in the
 * registry and this fails, which is the half TypeScript CAN check.
 *
 * The half it cannot check is durability - whether each is `durable`, and
 * whether no FOURTH durable assistant text event exists - because that is a
 * value in a table, not a type. That is `replay-guards.test.ts`, and the two
 * halves are documented as a pair rather than each claiming the whole property.
 *
 * An earlier draft tried to derive this set from `EventType` and got
 * `Extract<EventType, `assistant.${string}`> & 'assistant.text_block'`, which
 * intersects a union with a literal and is therefore always exactly that one
 * literal. It "passed" for the wrong reason; `replay-guards.test.ts` now closes
 * the set from the other direction instead.
 */
export type GuardedTextTypesExistInRegistry = [
  Assert<'assistant.text_block' extends EventType ? true : false>,
  Assert<'assistant.thinking_block' extends EventType ? true : false>,
  Assert<'assistant.message_finalized' extends EventType ? true : false>,
];

/**
 * The three kinds, matched by the runtime.
 *
 * `handleReplayOutcome` is real code rather than a type-only assertion: it is
 * the single place that turns an outcome into something a transport can send, so
 * a new kind has to be given a transport meaning here instead of defaulting to
 * one. It returns the status the caller should report, which is why the mapping
 * lives here and not in `replay-repository.ts` - storage decides WHAT is
 * replayable, and this decides how it is said.
 */
export type ReplayOutcomeStatus = 'ok' | 'resync_required' | 'error';

export function handleReplayOutcome(outcome: ReplayOutcome): ReplayOutcomeStatus {
  switch (outcome.kind) {
    case 'replay':
      return 'ok';
    case 'snapshot_resync':
      // Not `ok` and not `error`. The consumer must REPLACE its state, and a
      // status that cannot be distinguished from a plain success is how a
      // consumer keeps a transcript it never received.
      return 'resync_required';
    case 'refused':
      return 'error';
  }
}

/**
 * Exact-type equality. Not assignability: this must catch BOTH directions.
 *
 * Mirrors `packages/agent-protocol/src/transcript/content.ts:205`, and the
 * stronger form is load-bearing rather than stylistic. The obvious spelling -
 * `[A] extends [B] ? ([B] extends [A] ? true : never) : never` - evaluates to
 * `never` when the types disagree, and `never extends true` is TRUE. So that
 * version passes silently on exactly the mismatch it exists to catch, which is
 * how this file's guard was first written and then MEASURED as never firing.
 * This form returns `false`, which fails the `Assert` below.
 */
type Exactly<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;

type Assert<T extends true> = T;

/**
 * Every guard above, as one value.
 *
 * Each alias is instantiated here, because an unparameterised type alias is
 * never evaluated: nothing checks a generic-looking alias that is only ever
 * named in an export list.
 */
export type ReplayGuards = [
  Assert<ReplayOutcomeKindsAreExhaustive>,
  Assert<ReplayRefusalIsComplete>,
  Assert<ReplayWindowCarriesMintedLatest>,
  Assert<ReplayCursorIsScoped>,
  GuardedTextTypesExistInRegistry,
];
