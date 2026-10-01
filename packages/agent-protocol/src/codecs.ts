/**
 * Codecs: JSON in, envelope out. LENIENT decode, STRICT validate.
 *
 * ## The one place this file deliberately diverges from pi-protocol
 *
 * pi-protocol's `StrictObject` helper forces `additionalProperties: false` on
 * every object, and its README states "All schemas reject unknown object
 * properties." The decode path here must do the OPPOSITE: ignore unknown
 * fields, and leave strictness to a separate `validate` call.
 *
 * This is not a style difference. pi can afford strict decode because its README
 * ends with "The protocol is experimental and has no compatibility guarantees."
 * Duya has four independently deployed hosts plus a subprocess runtime, and
 * their versions skew independently. An old host that throws on a field a new
 * runtime added is a crashed client, not a caught error.
 *
 * What is borrowed from pi is the SHAPE of the guarantee: a single chokepoint
 * that makes the default hard to bypass. Here the chokepoint makes leniency the
 * default; there it made strictness the default.
 */

import type { JsonValue } from './hash.js';
import type { RunEventEnvelope, UnknownEnvelope, WireEnvelope } from './envelope.js';
import { isValidSeq } from './envelope.js';
import {
  EVENT_REGISTRY,
  isEventType,
  type EventType,
  type RunEvent,
} from './events/registry.js';
import { checkRequiredFields } from './events/required.js';
import { ProtocolError, isKnownCode, type ErrorCode } from './errors.js';
import { assertWithinStructuralLimits, byteLength, type ProtocolLimits } from './framing.js';
import { LIMITS } from './framing.js';
import { isPermissionAction } from './permission.js';

export interface DecodeOptions {
  readonly limits?: ProtocolLimits;
  /** Reject instead of returning `UnknownRunEvent`. Only for the strict path. */
  readonly strict?: boolean;
}

const asRecord = (value: unknown): Record<string, unknown> | null =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;

function isPositiveInt(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0;
}

/**
 * LENIENT decode. Never throws on an unknown event TYPE — returns an
 * `UnknownEnvelope` instead.
 *
 * An unknown event is never durable and must never be persisted. The host's
 * default branch renders nothing and records a `diagnostic` at debug level.
 */
export function fromEnvelope(raw: unknown, options: DecodeOptions = {}): WireEnvelope {
  const limits = options.limits ?? LIMITS;
  const record = asRecord(raw);
  if (!record) throw new ProtocolError({ code: 'invalid_event_frame', message: 'frame is not an object' });

  const payload = asRecord(record['payload']);
  if (!payload) {
    throw new ProtocolError({ code: 'invalid_event_frame', message: 'frame has no payload object' });
  }

  const type = payload['type'];
  if (typeof type !== 'string') {
    throw new ProtocolError({ code: 'invalid_event_frame', message: 'payload.type is not a string' });
  }

  if (!isValidSeq(record['seq'])) {
    throw new ProtocolError({
      code: 'invalid_event_frame',
      message: `seq must be an integer >= 1, got ${String(record['seq'])}`,
    });
  }
  assertWithinStructuralLimits(raw as JsonValue, limits);

  const common = {
    runId: String(record['runId']),
    sessionId: String(record['sessionId']),
    seq: record['seq'],
    timestamp: Number(record['timestamp'] ?? 0),
    traceId: String(record['traceId'] ?? ''),
  };

  if (!isEventType(type)) {
    if (options.strict) {
      throw new ProtocolError({
        code: 'unknown_event_type',
        message: `unknown event type "${type}"`,
        // Diagnostic facts only. The raw payload is deliberately NOT echoed:
        // it may contain content or credentials.
        details: { observedType: type },
      });
    }
    const unknown: UnknownEnvelope = {
      ...common,
      payload: { kind: 'unknown', type, raw: payload },
    };
    return unknown;
  }

  // Unknown FIELDS inside a known payload are IGNORED here. Strictness is
  // `validate`'s job, kept separate on purpose.
  return { ...common, payload: payload as unknown as RunEvent } as RunEventEnvelope;
}

export function isUnknownEnvelope(value: WireEnvelope): value is UnknownEnvelope {
  return (value.payload as { kind?: string }).kind === 'unknown';
}

/** Build an envelope. The runtime mints `seq`; nothing else may. */
export function toEnvelope<T extends RunEvent>(
  payload: T,
  meta: {
    runId: string;
    sessionId: string;
    seq: number;
    timestamp: number;
    traceId: string;
    spanId?: string;
    parentRunId?: string;
  },
): RunEventEnvelope<T> {
  return { ...meta, payload };
}

// ── strict validation ─────────────────────────────────────────────────────

export interface ValidationIssue {
  readonly path: string;
  readonly message: string;
}

/**
 * STRICT path. This is where `additionalProperties: false` lives, and where a
 * version-skewed host learns that a field it does not understand is present.
 * Decode stays lenient; this is opt-in.
 */
export function validate(raw: unknown, options: DecodeOptions = {}): ValidationIssue[] {
  const limits = options.limits ?? LIMITS;
  const issues: ValidationIssue[] = [];
  const record = asRecord(raw);

  if (!record) return [{ path: '$', message: 'envelope is not an object' }];

  for (const key of ['runId', 'sessionId', 'seq', 'timestamp', 'traceId', 'payload'] as const) {
    if (!(key in record)) issues.push({ path: `$.${key}`, message: 'missing required field' });
  }
  if (!isValidSeq(record['seq'])) {
    issues.push({ path: '$.seq', message: 'must be an integer >= 1' });
  }

  const payload = asRecord(record['payload']);
  if (!payload) {
    // The strict path must say so. Returning the issues collected so far would
    // report success for an envelope whose payload is a string, a number or
    // null — every required envelope key present, and the one field that makes
    // it an event carrying nothing. Found by the malformed-input suite.
    issues.push({ path: '$.payload', message: 'payload is not an object' });
    return issues;
  }

  const type = payload['type'];
  if (typeof type !== 'string') {
    issues.push({ path: '$.payload.type', message: 'must be a string' });
    return issues;
  }
  if (!isEventType(type)) {
    issues.push({ path: '$.payload.type', message: `unknown event type "${type}"` });
    return issues;
  }

  // Per-payload field manifest. Runs for EVERY event, not just durable ones: a
  // volatile `tool.progress` missing its `elapsedMs` is exactly as malformed as
  // a durable one, and gating this on durability would exempt the two event
  // families that arrive at the highest rate.
  for (const issue of checkRequiredFields(type, payload)) {
    issues.push({ path: `$.payload.${issue.field}`, message: issue.message });
  }

  const spec = EVENT_REGISTRY.specOf(type);
  if (spec && spec.durability === 'durable') {
    // A durable event must be persistable: no functions, no undefined, no
    // Map/Set. Those are the categories that cannot cross a JSON boundary.
    issues.push(...checkSerializable(payload, '$.payload', 0, limits));
  }

  if (type === 'permission.resolved' && !isPermissionAction(String(payload['action']))) {
    issues.push({ path: '$.payload.action', message: 'not a protocol permission action' });
  }

  return issues;
}

const NON_SERIALIZABLE = new Set(['function', 'symbol', 'bigint', 'undefined']);

function checkSerializable(
  value: unknown,
  path: string,
  depth: number,
  limits: ProtocolLimits,
): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  if (depth > limits.maxNestingDepth) {
    return [{ path, message: `nesting depth exceeds ${limits.maxNestingDepth}` }];
  }
  if (value === null) return issues;
  if (typeof value === 'string' || typeof value === 'boolean') return issues;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) issues.push({ path, message: 'non-finite number is not JSON' });
    return issues;
  }
  if (NON_SERIALIZABLE.has(typeof value)) {
    issues.push({ path, message: `a ${typeof value} cannot cross the protocol boundary` });
    return issues;
  }
  if (value instanceof Map || value instanceof Set) {
    issues.push({ path, message: 'Map/Set cannot cross the protocol boundary; flatten to Record' });
    return issues;
  }
  if (Array.isArray(value)) {
    if (value.length > limits.maxSequenceLength) {
      issues.push({ path, message: `length ${value.length} exceeds ${limits.maxSequenceLength}` });
    }
    value.forEach((item, i) => issues.push(...checkSerializable(item, `${path}[${i}]`, depth + 1, limits)));
    return issues;
  }
  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>);
    if (entries.length > limits.maxSequenceLength) {
      issues.push({ path, message: `entries ${entries.length} exceed ${limits.maxSequenceLength}` });
    }
    for (const [key, item] of entries) {
      issues.push(...checkSerializable(item, `${path}.${key}`, depth + 1, limits));
    }
  }
  return issues;
}

/** Reject a decoded payload whose size exceeds the negotiated budget. */
export function assertEventBudget(raw: unknown, limits: ProtocolLimits = LIMITS): void {
  const bytes = byteLength(JSON.stringify(raw));
  if (bytes > limits.maxEventBytes) {
    throw new ProtocolError({
      code: 'invalid_event_frame',
      message: `event is ${bytes} bytes, maxEventBytes is ${limits.maxEventBytes}`,
    });
  }
}

export type { EventType };
export { isKnownCode };
export type { ErrorCode };
