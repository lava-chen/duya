/**
 * OSContextBridge shared types.
 *
 * The v0.4 schema types are vendored in `./daemon-schema.ts` (a local
 * copy of the external `E:\Projects\computer-use-demo` daemon's
 * types.ts; the daemon itself runs out-of-tree and is spawned by the
 * Electron main as a child process).
 *
 * The daemon writes its `ContextPayload` to
 * `~/.duya/context/<sessionId>.json` (one file per session; see plan
 * 453 Task D). The bridge watches that directory, validates
 * schemaVersion, and emits `OSContext` to subscribers.
 *
 * `OSContext` is a narrowed envelope the bridge passes to
 * `ContextualUserFragment` consumers. The bridge drops fields that
 * would inflate tokens or expose unrelated OS telemetry (windowList,
 * full UIA tree, etc.) and caps the interactionTrail sliding window
 * at `MAX_TRAIL_EVENTS` to keep token usage predictable.
 *
 * Plan 519 re-opens three fields — `uiaInputs` / `msaaInputs` /
 * `windowList` — for the computer-use SOM detector only. They are
 * consumed by the selector (`computer-use`) and never enter the LLM
 * prompt: `renderSnapshot` in `fragment.ts` serializes fields
 * explicitly, so these additive fields stay out of the prompt by
 * default.
 *
 * Plan 453 Task A. Plan 519 Phase 1 Task A1.
 */

import type {
  ContextPayload,
  FocusedEntity,
  IntentCandidate,
  InteractionEvent,
  RedactionReason,
  UiaInput,
  WindowInfo,
} from './daemon-schema.js';

/**
 * The schema versions this bridge accepts. The daemon is at v0.4.0
 * (2026-08-26). Bump the array when adding support for a new daemon
 * schema; unknown versions are dropped with a WARN log (see payload.ts).
 */
export const ACCEPTED_SCHEMA_VERSIONS = ['0.4.0'] as const;
export type AcceptedSchemaVersion = (typeof ACCEPTED_SCHEMA_VERSIONS)[number];

/**
 * Maximum events kept from the interaction trail sliding window.
 * Token budget on the fragment side is 1800 (see fragment.ts); this
 * 30-event cap is the upstream gate.
 */
export const MAX_TRAIL_EVENTS = 30;

/**
 * OS-level focus context — which window + element the user is looking at
 * right now. Mirrors the daemon's `FocusedEntity` (null when projection
 * fails or is disabled).
 */
export type OSFocusedEntity = FocusedEntity | null;

/**
 * The narrowed OSContext envelope the bridge passes to consumers. The
 * daemon's `ContextPayload` is much richer (windowList, UIA tree, etc.);
 * we only forward what the LLM needs to ground its first-turn reply.
 */
export interface OSContext {
  /** schema version, post-validation (e.g. "0.4.0"). */
  schemaVersion: AcceptedSchemaVersion;
  /** ISO8601 timestamp from the daemon (`capturedAt`). */
  capturedAt: string;
  /**
   * Foreground window + element the user is looking at.
   * Null if the daemon failed to project or the field is omitted.
   */
  focusedEntity: OSFocusedEntity;
  /**
   * 30-second sliding window of interaction events (window focus,
   * selection change, text change, etc). Capped at MAX_TRAIL_EVENTS.
   */
  interactionTrail: InteractionEvent[];
  /**
   * Best-effort single intent guess (research / edit_code / fill_form
   * …). Null if no rule fired.
   */
  intentCandidate: IntentCandidate | null;
  /**
   * Compact foreground info — what executable / window is currently
   * on top. Used for short preambles like "你在 Chrome 看 GitHub".
   */
  foreground: {
    pid: number;
    exeName: string;
    title: string;
  };
  /**
   * UIA accessibility inputs for the detector's SOM. plan 519 §3.4.
   * Consumed only by the computer-use SOM detector — never the LLM prompt.
   * Absent when the daemon omitted `uia` or `uia.inputs` is malformed.
   */
  uiaInputs?: UiaInput[];
  /**
   * MSAA accessibility inputs (fallback source). Same consumer contract as
   * `uiaInputs`. Absent when `msaa` / `msaa.inputs` is missing or malformed.
   */
  msaaInputs?: Array<{ name: string; value: string }>;
  /**
   * Visible top-level window list (MITM-relevant for the SOM detector).
   * Capped at `MAX_WINDOW_LIST`. Absent when `windowList` is missing.
   */
  windowList?: WindowInfo[];
  /** Whether the daemon has redacted this payload (e.g. password manager). */
  redacted: boolean;
  /** Redaction reason when `redacted=true`, otherwise null. */
  redactionReason: RedactionReason | null;
}

export type {
  ContextPayload,
  FocusedEntity,
  IntentCandidate,
  InteractionEvent,
  RedactionReason,
  UiaInput,
  WindowInfo,
};