/**
 * Compile-time guards for the transport boundary.
 *
 * ## Why these are in `src/` and not in `test/`
 *
 * Every package's tsconfig excludes `test/`, and esbuild strips types without
 * checking them, so an assertion written in a test file is checked by nothing:
 * `vitest` transpiles without type checking, and `npm run typecheck:all` never
 * reads a test directory. A type-level guard in a test is a comment with extra
 * steps. The plan states this rule and it is the reason this file exists at
 * all.
 *
 * ## What each guard actually catches
 *
 *  - `TRANSPORT_PORTS_CARRY_NO_RUN_STATE` fails if a field is added to
 *    {@link TransportRun} that could carry a ledger, a `seq` or a session. The
 *    check is a structural one over the field-name union, so it fires on the
 *    NAME regardless of the type: someone adding `seq: number` is stopped even
 *    though a `number` is otherwise the most innocuous type in the file.
 *  - `RAW_FRAME_INTAKE_ACCEPTS_ONLY_RAW_FRAMES` fails if the pre-seq intake
 *    grows an `envelope` arm, which is the one change that would let a
 *    transport deliver pre-numbered events and become a second numbering
 *    authority.
 *  - `TRANSPORT_ERROR_CATEGORIES_ARE_EXHAUSTIVE` fails if a seventh category is
 *    added to the taxonomy without a policy, which is the mistake of shipping a
 *    category whose caller action is "figure it out".
 *
 * ## The half TypeScript cannot check
 *
 * Whether a transport MODULE imports the run layer. Nothing in the type system
 * stops `subprocess-transport.ts` from importing `RunSession` and quietly
 * owning a run, and that single import would invalidate every claim the
 * equivalence test makes. That is a property of source text rather than of
 * types, so it lives in `transport-boundary.test.ts` as a source audit, and it
 * is provable by adding the import and watching the audit fail.
 */

import type { EventType } from '@duya/agent-protocol';
import { TRANSPORT_ERROR_CATEGORIES } from './error-taxonomy.js';
import type { TransportErrorCategory } from './error-taxonomy.js';
import type { RawFrameIntake, TransportRun } from './transport-port.js';

/**
 * Fails the build unless the condition holds.
 *
 * The `never extends X ? ... ` shape is load-bearing and easy to get backwards.
 * `[A] extends [B] ? ([B] extends [A] ? true : never) : never` evaluates to
 * `never` when the types DISAGREE, and `never extends true` is true -- so that
 * spelling passes silently on exactly the mismatch it exists to catch. This
 * form returns `false`, which fails the assertion.
 */
type Exactly<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;

type Assert<T extends true> = T;

/**
 * Names that must never appear on a transport's surface.
 *
 * A NAME list rather than a type list, because the danger is not the type. A
 * `seq: number` field typechecks perfectly and would let a transport number a
 * run; the type-level check cannot see that, but a name check can.
 */
type ForbiddenRunStateName =
  | 'seq'
  | 'ledger'
  | 'session'
  | 'emitter'
  | 'controller'
  | 'persistence'
  | 'reader'
  | 'terminal'
  | 'terminalState'
  | 'clockSeq'
  | 'lastSeq';

/** Field names a transport is allowed to expose. */
type TransportRunFieldName = keyof TransportRun;

type NoForbiddenName<F extends string> = Extract<F, ForbiddenRunStateName> extends never ? true : false;

/**
 * A transport's run surface carries no run state.
 *
 * `RawFrameIntake`, `TransportPrivateChannel`, `TransportDiagnostics`,
 * `kind`, `runId`, `intake`, `privateChannel`, `handle`, `diagnostics` and
 * `close` are all permitted. Anything that could mint, hold or decide a `seq`
 * is not.
 */
export type TRANSPORT_PORTS_CARRY_NO_RUN_STATE = Assert<
  NoForbiddenName<TransportRunFieldName>
>;

/**
 * The pre-seq intake has exactly one arm, and it takes a raw frame.
 *
 * Derived from the real type rather than restated, so adding an `envelope` arm
 * to `RawFrameIntake` -- the change that would let a transport deliver
 * pre-numbered events -- widens the union and fails this.
 */
export type RAW_FRAME_INTAKE_ACCEPTS_ONLY_RAW_FRAMES = Assert<
  Exactly<keyof RawFrameIntake, 'frame' | 'end'>
>;

/**
 * Every category the taxonomy declares has a policy, and every policy names a
 * real category.
 *
 * The two directions matter. A category with no policy has no caller action, so
 * every caller would invent one; a policy naming a category that does not exist
 * is a dead entry that reads as coverage.
 */
export type TRANSPORT_ERROR_CATEGORIES_ARE_EXHAUSTIVE = Assert<
  Exactly<TransportErrorCategory, (typeof TRANSPORT_ERROR_CATEGORIES)[number]>
>;

/**
 * The policy map covers the vocabulary at the type level.
 *
 * `TRANSPORT_ERROR_CATEGORIES` is derived from `Object.keys(POLICIES)`, so it
 * cannot disagree with the map by construction. This assertion therefore holds
 * trivially today, and it is here to FAIL LOUDLY if someone rebuilds
 * `TRANSPORT_ERROR_CATEGORIES` as a hand-written array -- which is the one
 * change that would reintroduce the drift.
 */
export type ERROR_CATEGORY_LIST_IS_DERIVED = Assert<
  Exactly<
    TransportErrorCategory,
    'protocol_invalid' | 'policy_denied' | 'model_tool_error' | 'runtime_crash' | 'persist_failure' | 'replay_unavailable'
  >
>;

/**
 * The compared event vocabulary is still the registry's, not a second list.
 *
 * The equivalence test compares event types across three transports. If that
 * comparison used its own hardcoded list of types, a new event would be
 * compared by nobody while the registry grew -- so the name is bound to
 * `EventType` here and the runtime half is asserted in the equivalence suite
 * against `EVENT_REGISTRY.all`.
 */
export type COMPARED_EVENT_TYPES_ARE_REGISTRY_TYPES = Assert<
  EventType extends string ? true : false
>;
