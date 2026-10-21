/**
 * Normalisation: the rules under which two transports' output may be compared
 * for EQUALITY, and the rules that would make the comparison vacuous.
 *
 * ## What "normalised" excludes, and why each exclusion is safe
 *
 * The claim being tested is "the same offline execution through three adapters
 * produces the same semantic sequence and result". So the comparison must drop
 * exactly the things that are allowed to differ, and must NOT drop anything that
 * describes behaviour. Concretely, four classes are dropped and each is
 * dropped because it is a fact about the CONNECTION or the CLOCK, never about
 * the run:
 *
 *  1. **Wall-clock time.** `durationMs`, a spawn latency, a socket's timing.
 *    The subprocess adapter really is slower than the in-process one, and that
 *    is not a semantic difference. A run's semantics are its ordered events and
 *    its terminal.
 *  2. **Transport-local diagnostics.** Bytes, chunk counts, refusal counts,
 *    whether the connection dropped. These are SUPPOSED to differ -- it is the
 *    whole point of {@link TransportDiagnostics} being a separate type. Folding
 *    them into the compared shape is how a comparison quietly stops comparing
 *    the thing it was written to compare.
 *  3. **Provenance of an id that the protocol does not define.** Not `runId`
 *    and not `seq`: those are load-bearing and are KEPT. Only ids the protocol
 *    never mentions -- a socket id, a request id, a connection label.
 *  4. **The `seq` NUMBERS themselves, but never their ORDER or their SPANS.**
 *    This is the subtle one, so it is stated carefully: each adapter is given
 *    a FRESH run, so its absolute `seq` values start at 1 independently. What
 *    must be identical is the count of events, the order of event types, and
 *    the arithmetic shape of the sequence -- dense (no holes) from 1, because
 *    contract section F allows holes in the DURABLE store and nowhere else.
 *    Comparing raw `seq` across runs would be comparing two different runs'
 *    numbering; comparing the SEQUENCE SHAPE compares the minting rule.
 *
 * ## What normalisation may never do
 *
 * It may not drop a payload field, reorder events, coalesce two events into
 * one, or normalise a value away. Every one of those would let a real
 * behavioural difference pass, and each is the difference a transport is most
 * likely to introduce: a coalescer that merges across a content block, a
 * renumbering, a dropped terminal. {@link assertNormalisationIsHonest} states
 * that as a checkable rule rather than as a promise, and the equivalence suite
 * proves each rule fires by breaking it on purpose.
 *
 * ## Why the payload is compared STRUCTURALLY and not as a string
 *
 * Comparing `JSON.stringify` of two envelopes would make key ORDER
 * significant, and key order is a property of the object literal that happened
 * to build it. A subprocess adapter that decodes and re-encodes a frame
 * reorders keys; that is not a semantic difference. So the payload is walked
 * into a canonical form with sorted keys, and the leaf VALUES are compared
 * exactly. A changed value fails; a reordered key does not.
 */

import type { EventType, RunEventEnvelope } from '@duya/agent-protocol';
import { EVENT_REGISTRY } from '@duya/agent-protocol';
import type { TransportDiagnostics } from './transport-port.js';

/** One event, reduced to what a consumer can observe about the RUN. */
export interface NormalisedEvent {
  /** Position in the run's own order. 1-based, and must be dense. */
  readonly position: number;
  readonly type: EventType;
  /** The payload, with object keys sorted and no transport-local fields. */
  readonly payload: NormalisedPayload;
}

export type NormalisedValue =
  | string
  | number
  | boolean
  | null
  | readonly NormalisedValue[]
  | { readonly [key: string]: NormalisedValue };

export type NormalisedPayload = { readonly [key: string]: NormalisedValue };

/** The result of a run, reduced the same way. */
export interface NormalisedResult {
  readonly status: string;
  /** The terminal's protocol code, when the run failed. */
  readonly code?: string;
  /** The terminal's `cause.code`, preserved verbatim but never branched on. */
  readonly causeCode?: string;
}

/**
 * Payload fields that describe the transport rather than the run.
 *
 * An empty list today, and that is the point worth stating: the real worker
 * injects `_logger: 'worker'` into every frame it emits, and that field reaches
 * the runtime inside the RAW frame -- where it is translated away by
 * `mapWorkerEvent`, which is why it is not here. The list exists so that IF a
 * transport-local field ever does survive translation, dropping it is a
 * declared decision in one place rather than a `delete` in a comparator.
 */
export const TRANSPORT_LOCAL_PAYLOAD_FIELDS: ReadonlySet<string> = new Set<string>();

/** Top-level envelope fields that are not part of the run's semantics. */
const ENVELOPE_FIELDS_KEPT: readonly string[] = ['runId', 'seq', 'payload'];

/**
 * Canonicalise a JSON-ish value: sort object keys, keep leaf values exact.
 *
 * Arrays keep their order, because order IS semantic for a content block's
 * deltas. Only object KEY order is normalised, and only because a decode/encode
 * round trip legitimately reorders it.
 */
export function canonicalise(value: unknown): NormalisedValue {
  if (value === null) return null;
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return value;
  if (Array.isArray(value)) return value.map((item) => canonicalise(item));
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>;
    const out: Record<string, NormalisedValue> = {};
    for (const key of Object.keys(record).sort()) {
      if (TRANSPORT_LOCAL_PAYLOAD_FIELDS.has(key)) continue;
      const entry = record[key];
      if (entry === undefined) continue;
      out[key] = canonicalise(entry);
    }
    return out;
  }
  // A value JSON cannot carry (undefined, a function, a symbol) has no semantic
  // presence on the wire at all, so it normalises to null rather than to a
  // string that would differ between adapters.
  return null;
}

/**
 * Reduce one envelope to its comparable form.
 *
 * `position` is derived from the envelope's own `seq` rather than from the
 * array index, so a transport that delivered events OUT OF ORDER is caught
 * rather than laundered: if the array is not ascending by `seq`, the positions
 * will not be 1..n and {@link assertDenseSequence} fails.
 */
export function normaliseEnvelope(envelope: RunEventEnvelope): NormalisedEvent {
  // Through `unknown` on purpose: `RunEvent` is a closed union of object types
  // with no index signature, so a direct `Record` assertion is a type error --
  // and silencing it with a double cast would hide exactly the thing this
  // function exists to notice, which is a payload carrying a field nobody
  // declared.
  const source = envelope.payload as unknown as Record<string, unknown>;
  const payload: Record<string, NormalisedValue> = {};
  for (const key of Object.keys(source).sort()) {
    if (TRANSPORT_LOCAL_PAYLOAD_FIELDS.has(key)) continue;
    const value = source[key];
    if (value === undefined) continue;
    payload[key] = canonicalise(value);
  }
  return {
    position: envelope.seq,
    type: envelope.payload.type,
    payload: payload as NormalisedPayload,
  };
}

/** Reduce a terminal receipt to its comparable form. */
export function normaliseResult(terminal: {
  readonly status: string;
  readonly error?: { readonly code: string; readonly cause?: { readonly code: string } };
}): NormalisedResult {
  return {
    status: terminal.status,
    ...(terminal.error !== undefined ? { code: terminal.error.code } : {}),
    ...(terminal.error?.cause !== undefined ? { causeCode: terminal.error.cause.code } : {}),
  };
}

/** The three rules the comparison is allowed to rely on. */
export interface NormalisationViolation {
  readonly rule: 'field_dropped' | 'event_reordered' | 'sequence_not_dense' | 'count_differs';
  readonly detail: string;
}

/**
 * The rules, as a checkable function rather than as a paragraph.
 *
 * This is what stops "normalised" from becoming a word that means "whatever
 * differed, we normalised". Each rule corresponds to a real transport bug:
 *
 *  - `sequence_not_dense` catches a renumbering or a gap left by a coalescer
 *    that ran after seq assignment -- contract section F allows holes in the
 *    durable store and nowhere else, so a hole in the LIVE stream is a defect.
 *  - `event_reordered` catches out-of-order delivery, which the replay/live
 *    handoff is specifically built to prevent.
 *  - `count_differs` catches a dropped or duplicated event, which is what a
 *    type-blind shed or a double-attached tap produces.
 *  - `field_dropped` catches an event that arrived with a field the registry
 *    requires, which T3.2's field manifest already defines.
 */
export function assertNormalisationIsHonest(
  envelopes: readonly RunEventEnvelope[],
): readonly NormalisationViolation[] {
  const violations: NormalisationViolation[] = [];

  for (let i = 0; i < envelopes.length; i++) {
    const envelope = envelopes[i]!;
    if (envelope.seq !== i + 1) {
      violations.push({
        rule: 'sequence_not_dense',
        detail: `event ${i} carries seq ${envelope.seq}; the live stream must be dense from 1`,
      });
      break;
    }
  }

  for (let i = 1; i < envelopes.length; i++) {
    if (envelopes[i]!.seq <= envelopes[i - 1]!.seq) {
      violations.push({
        rule: 'event_reordered',
        detail: `seq went ${envelopes[i - 1]!.seq} -> ${envelopes[i]!.seq}`,
      });
      break;
    }
  }

  for (const envelope of envelopes) {
    if (!EVENT_REGISTRY.isKnown(envelope.payload.type)) {
      violations.push({
        rule: 'field_dropped',
        detail: `unknown type ${envelope.payload.type} reached the compared sequence`,
      });
      break;
    }
  }

  return violations;
}

/**
 * The comparison itself.
 *
 * `events` are compared in full -- type, position and payload -- because every
 * one of those is a fact about the run. `diagnostics` are compared only for
 * PRESENCE, because they are the part that is allowed to differ, and a
 * comparison that demanded equal byte counts would be asserting that the pipes
 * behave alike rather than that the runs do.
 */
export function compareRuns(
  left: {
    readonly transport: string;
    readonly events: readonly RunEventEnvelope[];
    readonly result: NormalisedResult;
    readonly diagnostics: TransportDiagnostics;
  },
  right: {
    readonly transport: string;
    readonly events: readonly RunEventEnvelope[];
    readonly result: NormalisedResult;
    readonly diagnostics: TransportDiagnostics;
  },
): readonly string[] {
  const differences: string[] = [];

  const l = left.events.map((e) => JSON.stringify(normaliseEnvelope(e)));
  const r = right.events.map((e) => JSON.stringify(normaliseEnvelope(e)));

  if (l.length !== r.length) {
    differences.push(`${left.transport} produced ${l.length} events, ${right.transport} produced ${r.length}`);
  }
  const shared = Math.min(l.length, r.length);
  for (let i = 0; i < shared; i++) {
    if (l[i] !== r[i]) {
      differences.push(
        `${left.transport} vs ${right.transport} differ at position ${i + 1}: ` +
          `${l[i]} !== ${r[i]}`,
      );
      // One difference is enough to fail; the rest would only bury it.
      break;
    }
  }

  const lr = JSON.stringify(left.result);
  const rr = JSON.stringify(right.result);
  if (lr !== rr) {
    differences.push(`${left.transport} result ${lr} !== ${right.transport} result ${rr}`);
  }

  // Deliberately NOT compared: the diagnostics' own `transport` label, and
  // every other diagnostic field. An earlier draft reported a label mismatch as
  // a difference, which made the comparison impossible to pass for its actual
  // subject -- two runs from two DIFFERENT transports. Comparing the label
  // would assert that the pipes behave alike rather than that the runs do, and
  // requiring equal byte counts would do the same. The diagnostics are
  // permitted to differ; that is what the separate type is for.
  return differences;
}

export { ENVELOPE_FIELDS_KEPT };
