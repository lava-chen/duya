/**
 * The down-projection: surface state back out to the legacy frames.
 *
 * ## Direction
 *
 * The protocol is the record; the legacy frame is the view. This module exists so
 * that adding a surface model does not cost the desktop renderer anything: a host
 * can drive the `SurfaceModel` and still hand the product UI the exact frames it
 * has always parsed.
 *
 * Nothing here rewrites `legacy-sse-projector.ts`. The projector's arm set IS the
 * legacy contract, and editing it to "fit" the surface would be the exact failure
 * the legacy contract file warns about — the renderer's behaviour is frozen by
 * having shipped, not by having been designed.
 *
 * ## What is actually proven
 *
 * `LEGACY_UNMAPPED_EVENT_TYPES` is written out by hand, because the fact it
 * records is a DECISION ("this event has no place in the product UI") and a
 * decision that derives itself from the thing it decides cannot be wrong.
 * `LEGACY_MAPPED_EVENT_TYPES` is then derived as the complement, so the two
 * cannot drift apart or double-count, and the conformance suite asserts the
 * arithmetic against `EVENT_TYPES` — the registry, not a copy of it.
 */

import type { EventType, RunEventEnvelope } from '@duya/agent-protocol';
import { EVENT_TYPES } from '@duya/agent-protocol';
import { SurfaceModel, type SurfaceEffect } from './surface-model.js';
import { projectToLegacyFrame } from '../project/legacy-sse-projector.js';
import type { LegacySseFrame } from '../legacy-sse-contract.js';

/**
 * The protocol events `projectToLegacyFrame` sends to `null`.
 *
 * Transcribed from the projector's `return null` arms. Eleven of the 38 protocol
 * events have no legacy counterpart, and the ten the protocol package lists in
 * `NEW_PROTOCOL_EVENTS` are a subset:
 *
 *   - the ten there are events with no legacy SOURCE (nothing on the old wire
 *     ever produced them);
 *   - `tool.timed_out` is the odd one out. It is a projector DECISION, not a
 *     new event — the old wire had no timed-out tool, and inventing a frame for
 *     it would have shown the product UI a row it had never been designed to
 *     interpret.
 *
 * A tool that times out still completes durably via `tool.call_completed`, which
 * does project. So the fact survives; only the intermediate tick does not.
 */
export const LEGACY_UNMAPPED_EVENT_TYPES: readonly EventType[] = [
  'run.started',
  'run.paused',
  'turn.completed',
  'assistant.message_finalized',
  'permission.resolved',
  'permission.expired',
  'checkpoint.saved',
  'tool.timed_out',
  'diagnostic',
  'diagnostic.trace',
  'extension.custom',
];

const UNMAPPED = new Set<EventType>(LEGACY_UNMAPPED_EVENT_TYPES);

/**
 * Every event that still reaches the renderer. Derived, not written.
 *
 * Deriving it is the point: if the projector gains or loses an arm, this set
 * moves with it and the conformance suite's count assertion is what notices.
 */
export const LEGACY_MAPPED_EVENT_TYPES: readonly EventType[] = EVENT_TYPES.filter(
  (type) => !UNMAPPED.has(type),
);

/** True when `type` is expected to reach a legacy client. */
export function isLegacyMapped(type: EventType): boolean {
  return !UNMAPPED.has(type);
}

/**
 * A replay of one run through both consumers at once.
 *
 * The point of returning both is that a host can migrate a screen at a time:
 * the surface model feeds the new UI while the frames keep the old one honest.
 * They are produced from the SAME envelopes in the SAME pass, so they cannot
 * disagree about what the run did.
 */
export interface SurfaceReplay {
  readonly model: SurfaceModel;
  /** One entry per applied envelope, in order. */
  readonly effects: readonly SurfaceEffect[];
  /** Only the non-null frames, in order. */
  readonly legacyFrames: readonly LegacySseFrame[];
}

/**
 * Replay envelopes onto a surface model, collecting the legacy frames on the way.
 *
 * @param envelopes - In `(runId, seq)` order, as the protocol guarantees.
 */
export function replayOntoSurface(envelopes: readonly RunEventEnvelope[]): SurfaceReplay {
  const model = new SurfaceModel();
  const effects: SurfaceEffect[] = [];
  const legacyFrames: LegacySseFrame[] = [];

  for (const envelope of envelopes) {
    effects.push(model.apply(envelope));
    const frame = projectToLegacyFrame(envelope);
    if (frame !== null) legacyFrames.push(frame);
  }

  return { model, effects, legacyFrames };
}
