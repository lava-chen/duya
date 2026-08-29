/**
 * payload.ts — Parse + validate + prune ContextPayload into OSContext.
 *
 * The daemon (`packages/computer-use/`) writes one
 * `~/.duya/context/<sessionId>.json` per session. Each file is a
 * full `ContextPayload` (rich; includes windowList, uia tree, msaa
 * tree, etc.). This module:
 *
 *   1. Parses the JSON safely (corrupt file → WARN + return null,
 *      never throws).
 *   2. Validates `schemaVersion` against `ACCEPTED_SCHEMA_VERSIONS`
 *      (unknown → WARN + drop).
 *   3. Prunes to the `OSContext` envelope (drops windowList / uia /
 *      msaa — not needed for grounding the first LLM turn).
 *   4. Caps `interactionTrail` at `MAX_TRAIL_EVENTS` (sliding window
 *      — daemon writes up to 50, we keep the most recent 30).
 *
 * Plan 453 Task B.
 */

import type { RedactionReason } from '@duya/computer-use-demo';
import { logger } from '../../utils/logger.js';
import {
  ACCEPTED_SCHEMA_VERSIONS,
  type AcceptedSchemaVersion,
  MAX_TRAIL_EVENTS,
  type OSContext,
} from './types.js';

/** Component tag for structured logs. */
const COMPONENT = 'OSContextBridge';

/** Allowed redaction reasons. Anything else passes through as null. */
const REDACTION_REASONS: ReadonlySet<RedactionReason> = new Set([
  'password-manager-foreground',
  'password-input-focused',
  'private-browsing',
  'user-disabled',
  'user-bypass',
]);

/**
 * Outcome of a parse attempt. `null` is a sentinel — callers should
 * treat both `{ ok: false }` and `null` OSContext as "no usable data
 * this tick".
 */
export type ParseOutcome =
  | { ok: true; context: OSContext }
  | { ok: false; reason: ParseFailureReason; detail: string };

export type ParseFailureReason =
  | 'invalid-json'
  | 'unsupported-schema-version'
  | 'missing-capturedAt'
  | 'missing-focus';

export interface ParseOptions {
  /** Logger override (defaults to module logger). Useful in tests. */
  logger?: Pick<typeof logger, 'warn' | 'debug'>;
  /** Override the schema whitelist (defaults to ACCEPTED_SCHEMA_VERSIONS). */
  acceptedVersions?: readonly string[];
}

/**
 * Parse a raw ContextPayload JSON string into a narrowed OSContext.
 * Never throws — corrupt input always returns `{ ok: false }`.
 */
export function parseOSContext(
  raw: string,
  opts: ParseOptions = {},
): ParseOutcome {
  const log = opts.logger ?? logger;
  const accepted = opts.acceptedVersions ?? ACCEPTED_SCHEMA_VERSIONS;

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    log.warn(
      'parseOSContext: invalid JSON dropped',
      { error: err instanceof Error ? err.message : String(err) },
      COMPONENT,
    );
    return { ok: false, reason: 'invalid-json', detail: String(err) };
  }

  if (!isObject(parsed)) {
    log.warn('parseOSContext: top-level not an object', undefined, COMPONENT);
    return {
      ok: false,
      reason: 'invalid-json',
      detail: 'top-level not an object',
    };
  }

  const schemaVersion = (parsed as { schemaVersion?: unknown }).schemaVersion;
  if (typeof schemaVersion !== 'string') {
    log.warn(
      'parseOSContext: missing schemaVersion',
      undefined,
      COMPONENT,
    );
    return {
      ok: false,
      reason: 'unsupported-schema-version',
      detail: 'missing schemaVersion',
    };
  }
  if (!(accepted as readonly string[]).includes(schemaVersion)) {
    log.warn(
      'parseOSContext: unsupported schemaVersion dropped',
      { schemaVersion, accepted: [...accepted] },
      COMPONENT,
    );
    return {
      ok: false,
      reason: 'unsupported-schema-version',
      detail: `unsupported schemaVersion=${schemaVersion}`,
    };
  }

  const capturedAt = (parsed as { capturedAt?: unknown }).capturedAt;
  if (typeof capturedAt !== 'string' || capturedAt.length === 0) {
    log.warn(
      'parseOSContext: missing or invalid capturedAt',
      undefined,
      COMPONENT,
    );
    return {
      ok: false,
      reason: 'missing-capturedAt',
      detail: 'capturedAt must be a non-empty ISO8601 string',
    };
  }

  const focus = (parsed as { focus?: unknown }).focus;
  if (!isObject(focus)) {
    log.warn('parseOSContext: missing focus', undefined, COMPONENT);
    return {
      ok: false,
      reason: 'missing-focus',
      detail: 'focus object required',
    };
  }

  const focusPid = (focus as { foregroundPid?: unknown }).foregroundPid;
  const focusExe = (focus as { foregroundProcessName?: unknown })
    .foregroundProcessName;
  const focusTitle = (focus as { focusControlClassName?: unknown })
    .focusControlClassName;
  if (
    typeof focusPid !== 'number' ||
    typeof focusExe !== 'string' ||
    (typeof focusTitle !== 'string' && focusTitle !== null)
  ) {
    log.warn(
      'parseOSContext: focus fields have wrong type',
      { focusPid: typeof focusPid, focusExe: typeof focusExe },
      COMPONENT,
    );
    return {
      ok: false,
      reason: 'missing-focus',
      detail: 'foregroundPid must be number; foregroundProcessName / focusControlClassName must be string',
    };
  }

  const redaction = (parsed as { redaction?: unknown }).redaction;
  const redactedInfo = isObject(redaction)
    ? {
        redacted: ((redaction as { redacted?: unknown }).redacted ?? false) as boolean,
        reason: normalizeRedactionReason(
          (redaction as { reason?: unknown }).reason,
        ),
      }
    : { redacted: false, reason: null };

  const focusedEntityRaw = (parsed as { focusedEntity?: unknown }).focusedEntity;
  const focusedEntity =
    focusedEntityRaw === null || focusedEntityRaw === undefined
      ? null
      : isObject(focusedEntityRaw)
        ? (focusedEntityRaw as unknown as OSContext['focusedEntity'])
        : null;

  const intentCandidateRaw = (parsed as { intentCandidate?: unknown })
    .intentCandidate;
  const intentCandidate =
    intentCandidateRaw === null || intentCandidateRaw === undefined
      ? null
      : isObject(intentCandidateRaw)
        ? (intentCandidateRaw as unknown as OSContext['intentCandidate'])
        : null;

  const trailRaw = (parsed as { interactionTrail?: unknown }).interactionTrail;
  const interactionTrail = Array.isArray(trailRaw)
    ? (trailRaw
        .filter(isObject)
        .slice(-MAX_TRAIL_EVENTS)
        .map((e) => e as unknown as OSContext['interactionTrail'][number]))
    : [];

  const ctx: OSContext = {
    schemaVersion: schemaVersion as AcceptedSchemaVersion,
    capturedAt,
    focusedEntity,
    interactionTrail,
    intentCandidate,
    foreground: {
      pid: focusPid,
      exeName: focusExe,
      title: typeof focusTitle === 'string' ? focusTitle : '',
    },
    redacted: redactedInfo.redacted,
    redactionReason: redactedInfo.reason,
  };

  log.debug(
    'parseOSContext: ok',
    {
      schemaVersion,
      trailEvents: interactionTrail.length,
      hasFocusedEntity: focusedEntity !== null,
      hasIntent: intentCandidate !== null,
      redacted: redactedInfo.redacted,
    },
    COMPONENT,
  );

  return { ok: true, context: ctx };
}

/**
 * Drop the most-recent-N-extras when a payload has more trail events
 * than the cap. Exported separately so tests can verify the cap is
 * applied even when the daemon reports a wildly different size.
 */
export function capTrail<T>(events: readonly T[], cap: number = MAX_TRAIL_EVENTS): T[] {
  if (events.length <= cap) return [...events];
  return events.slice(-cap);
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function normalizeRedactionReason(reason: unknown): RedactionReason | null {
  if (typeof reason !== 'string') return null;
  return (REDACTION_REASONS as Set<string>).has(reason)
    ? (reason as RedactionReason)
    : null;
}