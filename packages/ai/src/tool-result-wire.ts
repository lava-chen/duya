/**
 * The explicit boundary between a runtime tool result and its wire form.
 *
 * ## Why a function and not a cast
 *
 * `RuntimeToolResult` is `ToolResultWire & DeferredToolExtras`, so every wire
 * field is structurally present on the runtime object and `toToolResultWire`
 * could be typed as an identity. It is written as an explicit projection
 * anyway, for three reasons:
 *
 *  1. Contract §A forbids Promise on the wire. A cast would let a Promise
 *     reach a frame, and `JSON.stringify` would turn it into `{}` — a tool
 *     that returned a deferred context would appear to have returned nothing,
 *     with no error anywhere. Projecting field by field makes that impossible
 *     to do by accident, and makes a field added to `ToolResultWire` without a
 *     line here a compile error.
 *
 *  2. The projection is the place the "was never on the wire" claim is
 *     auditable. Every line is a field a transcript row can legitimately hold.
 *
 *  3. `exactOptionalPropertyTypes` is on, so an optional field that is absent
 *     must stay absent rather than becoming an explicit `undefined`. That
 *     distinction is what `checkRequiredFields` in the protocol package uses
 *     to tell "never sent" from "sent as undefined", and preserving it here
 *     keeps the two packages telling the same story.
 *
 * ## What this does NOT do
 *
 * It does not convert the result into the protocol's event `ToolResult` with a
 * `ToolCallOutcome`. That upgrade is the router's job, and doing it here would
 * fabricate an `indeterminate` outcome for every result whose producer simply
 * omitted `error`. See `ToolCallOutcome` in
 * `@duya/agent-protocol` for the full argument.
 *
 * Plan 587 T3.1 is types-only, so nothing calls this yet; it exists so the
 * split is a real, testable boundary rather than a type assertion. Wiring it
 * into the emitter is removal task 587-T3-1-WIRE-SERIALIZER.
 */

import type { ToolResultWire } from '@duya/agent-protocol/transcript';
import type { RuntimeToolResult } from './types.js';

/**
 * Project a runtime tool result onto its wire form.
 *
 * The two `internal-async` fields — `pendingExtraResult` and
 * `pendingContext` — are deliberately absent. They are awaited by
 * `StreamingToolExecutor` and delivered on separate channels; they were never
 * part of the wire payload and are never persisted.
 */
export function toToolResultWire(result: RuntimeToolResult): ToolResultWire {
  const wire: ToolResultWire = {
    id: result.id,
    name: result.name,
    result: result.result,
  };

  if (result.error !== undefined) wire.error = result.error;
  if (result.duration_ms !== undefined) wire.duration_ms = result.duration_ms;
  if (result.metadata !== undefined) wire.metadata = result.metadata;
  if (result.images !== undefined) wire.images = result.images;
  if (result.blocks !== undefined) wire.blocks = result.blocks;
  if (result.structured !== undefined) wire.structured = result.structured;

  return wire;
}

/**
 * Whether a runtime tool result carries anything that must NOT cross the wire.
 *
 * Exists so a caller can assert the boundary was respected rather than hope
 * it. `test/tool-result-wire.test.ts` uses it, and an emitter should.
 */
export function hasDeferredRuntimeState(result: RuntimeToolResult): boolean {
  return result.pendingExtraResult !== undefined || result.pendingContext !== undefined;
}

/**
 * Serialize a wire tool result to the JSON text that goes on the wire.
 *
 * Returns the encoded text alongside the value so a caller can prove the
 * encoded form contains no promise-shaped holes. `JSON.stringify` turns a
 * `Promise` into `{}`, so "the two async fields are absent" is only provable
 * against the encoded output, not the object.
 */
export function serializeToolResult(result: RuntimeToolResult): {
  wire: ToolResultWire;
  json: string;
} {
  const wire = toToolResultWire(result);
  return { wire, json: JSON.stringify(wire) };
}
