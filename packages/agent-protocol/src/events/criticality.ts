/**
 * Where "critical" sits, and how the decision is recorded.
 *
 * ## The sentence this file implements
 *
 * Contract §F: `structuraldecode严格；未知合法extension支持前向兼容，无法识别的
 * 关键控制/terminal不能偷偷变成成功。` — strict structural decode; unknown
 * legal extensions are supported for forward compatibility; an unrecognised
 * critical control/terminal must not quietly become success.
 *
 * That sentence is only load-bearing if "critical" has a definition. This is it.
 *
 * ## Why a NAMESPACE and not a per-event judgement
 *
 * The tempting version is a `Set<EventType>` listing the events whose loss
 * would be dangerous. That is a second list beside `EVENT_META`, and it drifts
 * the moment someone adds an event: the new event is not in the set, so the set
 * is stale, and the failure is silent because nothing compares the two.
 *
 * The rule used instead is a property of the NAME. The protocol mints the
 * `run.`, `permission.` and `checkpoint.` namespaces itself, so an event in
 * one of them is a claim about run authority — and a consumer that cannot read
 * such a claim holds a false belief, not a missing pixel. Everything else is
 * observable content, where ignorance costs display fidelity and nothing else.
 *
 * The consequence for a peer that sends something we do not know: the VERDICT
 * falls out of the name. `run.something_new` is rejected, because a peer
 * inventing a `run.` event is claiming to speak the run protocol and we cannot
 * verify the claim. `acme.something_new` is a legal extension: ignored, with a
 * diagnostic, and the run keeps whatever terminal it already has.
 *
 * ## Why the flag is still declared per event
 *
 * The namespace rule is the authority, but a reader of `EVENT_META` should not
 * have to know it to see whether an event is critical. So the flag is written
 * out, and `CRITICALITY_MATCHES_RESERVED_NAMESPACES` below fails the build if
 * the two ever disagree — in either direction. The declaration is documentation
 * the compiler holds to the rule.
 */

import { EVENT_META, type EventType } from './registry.js';

/**
 * Namespaces the protocol reserves for itself.
 *
 * Closed, and deliberately short. Every entry has to survive the question "if a
 * peer sent this and we could not read it, would we be holding a false belief?"
 *  - `run.`     — an unread terminal is a run whose end is unknown.
 *  - `permission.` — an unread request is a blocked tool with nobody answering.
 *  - `checkpoint.` — an unread boundary is a resume point we cannot honour.
 *
 * `extension.` is NOT here, and that is not an oversight: the contract names it
 * as the forward-compatibility escape hatch, so a consumer ignoring an
 * `extension.` event is doing exactly what it is for.
 */
export const CRITICAL_NAMESPACES = ['run', 'permission', 'checkpoint'] as const;

export type CriticalNamespace = (typeof CRITICAL_NAMESPACES)[number];

/** The namespace part of an event type, or `''` when the name has no dot. */
export type NamespaceOf<T extends string> = T extends `${infer N}.${string}` ? N : never;

/** True when a type name claims a reserved namespace. */
export type IsReservedType<T extends string> = T extends `${CriticalNamespace}.${string}` ? true : false;

/**
 * What to do with an event type this build does not know.
 *
 *  - `critical`  — it claims a reserved namespace. Refuse it. See
 *    {@link verdictForUnknownType}.
 *  - `extension` — a legal unknown extension. Ignore it, say so, and keep the
 *    run's existing terminal.
 */
export type UnknownEventVerdict = 'critical' | 'extension';

/** The runtime namespace prefix of an event type, or `null` if it has none. */
export function namespaceOf(type: string): string | null {
  const dot = type.indexOf('.');
  return dot <= 0 ? null : type.slice(0, dot);
}

/**
 * Classify a type the registry does not know.
 *
 * The single place the "critical event" boundary is applied to an unknown peer
 * message. It is deliberately a decision about the NAME and not about the
 * payload: a peer that invents `run.terminal_ok` has asserted run authority, and
 * honouring it by ignoring it is how a run ends up reported as successful
 * because the thing that would have said otherwise was in a language we do not
 * speak.
 *
 * A caller that gets `critical` MUST NOT drop the message. It must either
 * refuse the peer or synthesise an explicit terminal that says the message
 * could not be interpreted. Both are terminal decisions, and neither is
 * available from inside a decode function — so this function only classifies,
 * and the caller records the consequence. That split is the reason the verdict
 * carries no run status: deciding how a run ends is the runtime's job
 * (contract §C), not the decoder's.
 */
export function verdictForUnknownType(type: string): UnknownEventVerdict {
  const namespace = namespaceOf(type);
  if (namespace === null) return 'extension';
  return (CRITICAL_NAMESPACES as readonly string[]).includes(namespace) ? 'critical' : 'extension';
}

/** The declared criticality of a KNOWN event type. */
export function isCriticalEventType(type: EventType): boolean {
  return EVENT_META[type].critical;
}

// ── the compile-time guard ────────────────────────────────────────────────

/** What the namespace rule says each event's criticality must be. */
type ExpectedCriticality = {
  readonly [K in EventType]: IsReservedType<K>;
};

/** What `EVENT_META` actually declares. */
type DeclaredCriticality = {
  readonly [K in EventType]: (typeof EVENT_META)[K]['critical'];
};

/**
 * The event types where the declared flag and the namespace rule DISAGREE.
 *
 * `never` when they agree everywhere, which is the only case the constant below
 * can be assigned. Naming the offending key rather than collapsing the whole
 * type to `false` is so the compiler's error points at the event that drifted
 * rather than at this file.
 */
type CriticalityDisagreements = {
  readonly [K in EventType]: [ExpectedCriticality[K], DeclaredCriticality[K]] extends [true, true]
    ? never
    : ([ExpectedCriticality[K], DeclaredCriticality[K]] extends [false, false] ? never : K);
}[EventType];

/**
 * Fails to COMPILE if any event's declared `critical` disagrees with the
 * reserved-namespace rule — in either direction.
 *
 * Marking `run.completed` non-critical fails here. So does marking
 * `assistant.text_delta` critical. So does adding `run.epoch_advanced` and
 * forgetting the flag, because the mapped type covers every `EventType` and a
 * new one without the flag is a missing key rather than a missing check.
 *
 * It lives in `src/`, not in `test/`, for the reason T3.1's two guards do:
 * `tsconfig.json` excludes `test`, so nothing in CI would ever typecheck a
 * guard written there, and esbuild strips types before vitest runs. A guard in
 * a directory nobody compiles is not a guard.
 */
export type CriticalityMatchesReservedNamespaces = [CriticalityDisagreements] extends [never] ? true : false;

export const CRITICALITY_MATCHES_RESERVED_NAMESPACES: CriticalityMatchesReservedNamespaces = true;
