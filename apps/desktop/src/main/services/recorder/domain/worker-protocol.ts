/**
 * worker-protocol.ts — wire contract between the hook-worker child
 * process and the Electron main process (plan 556 Phase 1).
 *
 * The worker (hook-worker-entry.ts) writes one JSON object per line to
 * stdout; the main side (recorder-hook-worker.ts) line-buffers and
 * validates each line with `parseWorkerLine`. Garbage lines are counted
 * and dropped, never thrown — a corrupt stdout line must not kill a
 * recording.
 *
 * This module lives on the MAIN side of the protocol only: the worker
 * entry must stay dependency-free (its only import is uiohook-napi), so
 * it declares its emit shapes structurally and the zod schemas here are
 * the authoritative reader-side validation.
 */

import { z } from 'zod';

/** Raw mouse button as reported by libuiohook on Windows. */
export type RawMouseButton = 1 | 2 | 3 | 4 | 5; // 1=left 2=right 3=middle 4/5=extra

export const RawMouseButtonSchema = z.union([
  z.literal(1),
  z.literal(2),
  z.literal(3),
  z.literal(4),
  z.literal(5),
]);

const modifierFlagsSchema = z.object({
  shiftKey: z.boolean(),
  ctrlKey: z.boolean(),
  altKey: z.boolean(),
  metaKey: z.boolean(),
});

const tsSchema = z.number().int().nonnegative();

/**
 * A keydown line. `char` is the US-layout resolution (null when none);
 * `name` is the canonical name for special keys (null otherwise). The
 * `<key:N>` placeholder decision belongs to the aggregator, not here.
 */
export const KeyDownEventSchema = z
  .object({
    kind: z.literal('keydown'),
    ts: tsSchema,
    keycode: z.number().int().nonnegative(),
    name: z.string().nullable(),
    char: z.string().nullable(),
  })
  .merge(modifierFlagsSchema);

export const KeyUpEventSchema = z
  .object({
    kind: z.literal('keyup'),
    ts: tsSchema,
    keycode: z.number().int().nonnegative(),
  })
  .merge(modifierFlagsSchema);

export const MouseDownEventSchema = z.object({
  kind: z.literal('mousedown'),
  ts: tsSchema,
  x: z.number(),
  y: z.number(),
  button: RawMouseButtonSchema,
  clicks: z.number().int().nonnegative(),
});

export const MouseUpEventSchema = z.object({
  kind: z.literal('mouseup'),
  ts: tsSchema,
  x: z.number(),
  y: z.number(),
  button: RawMouseButtonSchema,
});

/**
 * A wheel line. `rotation > 0` means scrolled DOWN (toward the user) —
 * libuiohook inverts the Windows vertical delta to match other platforms.
 * Horizontal wheels are reported by the native layer but dropped in the
 * worker (the RecorderEvent model is vertical-only for MVP).
 */
export const WheelEventSchema = z.object({
  kind: z.literal('wheel'),
  ts: tsSchema,
  rotation: z.number().int(),
  amount: z.number().int().nonnegative(),
});

export const HeartbeatEventSchema = z.object({
  kind: z.literal('heartbeat'),
  ts: tsSchema,
});

export const WorkerEventSchema = z.discriminatedUnion('kind', [
  KeyDownEventSchema,
  KeyUpEventSchema,
  MouseDownEventSchema,
  MouseUpEventSchema,
  WheelEventSchema,
  HeartbeatEventSchema,
]);

export type KeyDownEvent = z.infer<typeof KeyDownEventSchema>;
export type KeyUpEvent = z.infer<typeof KeyUpEventSchema>;
export type MouseDownEvent = z.infer<typeof MouseDownEventSchema>;
export type MouseUpEvent = z.infer<typeof MouseUpEventSchema>;
export type WheelEvent = z.infer<typeof WheelEventSchema>;
export type HeartbeatEvent = z.infer<typeof HeartbeatEventSchema>;

export type WorkerEvent =
  | KeyDownEvent
  | KeyUpEvent
  | MouseDownEvent
  | MouseUpEvent
  | WheelEvent
  | HeartbeatEvent;

/**
 * Parse one stdout line from the hook-worker. Returns `null` for empty
 * lines or schema violations (caller counts and drops them).
 */
export function parseWorkerLine(line: string): WorkerEvent | null {
  const trimmed = line.trim();
  if (trimmed.length === 0) {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return null;
  }
  const result = WorkerEventSchema.safeParse(parsed);
  return result.success ? (result.data as WorkerEvent) : null;
}

/** True when the key event's flags say a ctrl/alt/meta combo is in progress. */
export function isComboKeyDown(event: KeyDownEvent): boolean {
  return event.ctrlKey || event.altKey || event.metaKey;
}
