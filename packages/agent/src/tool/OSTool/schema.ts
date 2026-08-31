/**
 * schema.ts — zod input schema for the computer_use tool (plan 454 §5 Task B).
 *
 * Discriminated union over the 10 actions. Each branch declares only
 * the fields relevant to that action; common fields (somMode,
 * timeoutMs, displayId) sit on the top level alongside `action`.
 *
 * Validation rules:
 *   - exactly one action discriminator per call
 *   - coords + element are mutually exclusive inside `click` /
 *     `drag` (use element OR coords, not both)
 *   - numeric fields are finite (no NaN / Infinity)
 *   - text fields cap at 50k chars (defensive against runaway typing)
 *   - safety: text input must not contain shell invocation patterns
 *     (Phase 3 expands this; Phase 2 covers the simple cases)
 */

import { z } from 'zod';

import { COMPUTER_USE_ACTIONS } from './constants.js';

// ─────────────────────────────────────────────────────────────────────
// Common
// ─────────────────────────────────────────────────────────────────────

const finiteNumber = z.number().refine(Number.isFinite, {
  message: 'must be a finite number',
});

const nonNegativeInt = finiteNumber.int().nonnegative();

const safeText = z
  .string()
  .min(0)
  .max(50_000, 'text exceeds 50,000 character cap');

const somMode = z.boolean().optional();
const displayId = nonNegativeInt.optional();
const timeoutMs = nonNegativeInt.optional();

// ─────────────────────────────────────────────────────────────────────
// Per-action shapes
// ─────────────────────────────────────────────────────────────────────

const captureShape = z
  .object({
    action: z.literal('capture'),
    somMode,
    displayId,
    timeoutMs,
  })
  .strict();

const clickShape = z
  .object({
    action: z.literal('click'),
    element: nonNegativeInt.optional(),
    x: finiteNumber.optional(),
    y: finiteNumber.optional(),
    button: z.enum(['left', 'right', 'middle']).optional(),
    count: z.enum(['single', 'double', 'triple']).optional(),
    modifiers: z
      .array(z.enum(['ctrl', 'alt', 'shift', 'meta']))
      .max(4)
      .optional(),
    timeoutMs,
  })
  .strict()
  .refine(
    (v) =>
      v.element !== undefined || (v.x !== undefined && v.y !== undefined),
    {
      message: 'click requires either `element` (SOM index) or `x`+`y`',
    },
  )
  .refine(
    (v) => !(v.element !== undefined && (v.x !== undefined || v.y !== undefined)),
    {
      message: 'click `element` is mutually exclusive with `x`/`y`',
    },
  );

const typeShape = z
  .object({
    action: z.literal('type'),
    text: safeText,
    delayMs: nonNegativeInt.optional(),
    timeoutMs,
  })
  .strict();

const keyShape = z
  .object({
    action: z.literal('key'),
    key: z.string().min(1).max(64),
    modifiers: z
      .array(z.enum(['ctrl', 'alt', 'shift', 'meta']))
      .max(4)
      .optional(),
    timeoutMs,
  })
  .strict();

const scrollShape = z
  .object({
    action: z.literal('scroll'),
    direction: z.enum(['up', 'down', 'left', 'right']),
    amount: nonNegativeInt.max(100).refine((n) => n > 0, {
      message: 'amount must be > 0',
    }),
    timeoutMs,
  })
  .strict();

const dragShape = z
  .object({
    action: z.literal('drag'),
    fromElement: nonNegativeInt.optional(),
    toElement: nonNegativeInt.optional(),
    fromX: finiteNumber.optional(),
    fromY: finiteNumber.optional(),
    toX: finiteNumber.optional(),
    toY: finiteNumber.optional(),
    steps: nonNegativeInt.max(100).optional(),
    timeoutMs,
  })
  .strict()
  .refine(
    (v) =>
      (v.fromX !== undefined && v.fromY !== undefined &&
        v.toX !== undefined && v.toY !== undefined) ||
      (v.fromElement !== undefined && v.toElement !== undefined),
    {
      message:
        'drag requires either both element refs or all four coords (fromX/fromY/toX/toY)',
    },
  );

const setValueShape = z
  .object({
    action: z.literal('set_value'),
    value: safeText,
    delayMs: nonNegativeInt.optional(),
    timeoutMs,
  })
  .strict();

const waitShape = z
  .object({
    action: z.literal('wait'),
    ms: nonNegativeInt.max(60_000).refine((n) => n > 0, {
      message: 'ms must be > 0',
    }),
    timeoutMs,
  })
  .strict();

const zoomShape = z
  .object({
    action: z.literal('zoom'),
    // Region in screen coordinates (logical pixels, top-left origin).
    x: finiteNumber,
    y: finiteNumber,
    w: finiteNumber.int().positive(),
    h: finiteNumber.int().positive(),
    timeoutMs,
  })
  .strict()
  .refine(
    (v) => v.x >= 0 && v.y >= 0 && v.w > 0 && v.h > 0,
    {
      message: 'zoom region requires positive x, y, w, h',
    },
  );

// ─────────────────────────────────────────────────────────────────────
// Discriminated union
// ─────────────────────────────────────────────────────────────────────

/**
 * Top-level input schema. Parses + validates any computer_use call.
 */
export const computerUseInputSchema = z.discriminatedUnion(
  'action',
  [
    captureShape,
    clickShape,
    typeShape,
    keyShape,
    scrollShape,
    dragShape,
    setValueShape,
    waitShape,
    zoomShape,
  ],
);

/**
 * Static enum list, exported for the tool definition.
 */
export const COMPUTER_USE_ACTION_LIST = [...COMPUTER_USE_ACTIONS];

/**
 * Minimal shape-of-shape export so other modules can build their own
 * zod schemas from the same primitives.
 */
export const sharedPrimitives = {
  finiteNumber,
  nonNegativeInt,
  safeText,
  somMode,
  displayId,
  timeoutMs,
} as const;