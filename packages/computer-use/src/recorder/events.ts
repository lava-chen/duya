/**
 * events.ts — Recorder event schema (plan 556 Phase 0).
 *
 * Single source of truth for the shape of every event that flows
 * through the recorder pipeline. The schema is intentionally close to
 * the design doc §4.5 and is what `session-store.ts` parses back off
 * disk. Anything that wants to inspect or mutate events (aggregators,
   converter, matcher) imports the types from here so a single edit
 * propagates.
 *
 * Three rules this file enforces:
 *
 *  1. Discriminated union by `type`. Adding a new event kind is one
 *     entry in the union and one branch in any consumer's switch.
 *  2. `safeParseRecorderEvent` swallows malformed JSONL lines so the
 *     session-store can survive a crash that left a partial line on
 *     disk (the final append is the one most likely to be truncated).
 *  3. Everything is plain data; runtime side effects live in
 *     `privacy.ts` (redaction) and `aggregators.ts` (state machines).
 */

import { z } from 'zod';

import type { Bbox } from '../backend/types.js';

/** Foreground window reference at the moment an event was captured. */
export interface AppRef {
  /** Human-friendly app name, e.g. "Google Chrome", "记事本". */
  name: string;
  /** Window title text (may be empty for some apps). */
  title: string;
  /** Process executable name without extension, e.g. "chrome", "notepad". */
  processName: string;
  /** OS process id (uint32). */
  pid: number;
}

export const AppRefSchema = z.object({
  name: z.string(),
  title: z.string(),
  processName: z.string(),
  pid: z.number().int().nonnegative(),
});

/**
 * Description of the UI element under the cursor at click / typing time.
 *
 * `source` is the only required field so that a missing probe result
 * is representable. Every other field is best-effort from UIA.
 */
export interface ElementDescriptor {
  /** UIA Name (often the button label / field placeholder). */
  name?: string;
  /** UIA ControlType localized string, e.g. "Button" / "Edit". */
  controlType?: string;
  /** UIA AutomationId (developer-set stable id). */
  automationId?: string;
  /** UIA ClassName, e.g. "Button", "Edit", "Chrome_RenderWidgetHostHWND". */
  className?: string;
  /** Bounding rectangle in logical screen pixels (top-left origin). */
  rect?: Bbox;
  /** True when UIA flags the element as a password input. Forces text redaction. */
  isPassword?: boolean;
  /** Provenance — drives the matcher's confidence scoring downstream. */
  source: 'uia-probe' | 'none';
}

export const ElementDescriptorSchema = z.object({
  name: z.string().optional(),
  controlType: z.string().optional(),
  automationId: z.string().optional(),
  className: z.string().optional(),
  rect: z
    .object({
      x: z.number(),
      y: z.number(),
      w: z.number().nonnegative(),
      h: z.number().nonnegative(),
    })
    .optional(),
  isPassword: z.boolean().optional(),
  source: z.enum(['uia-probe', 'none']),
});

/** Shared click geometry. `count` covers double-click collapse. */
export interface ClickPayload {
  x: number;
  y: number;
  button: 'left' | 'right' | 'middle';
  /** 1 = single, 2 = double (triple+ collapses to 2 in the aggregator). */
  count: 1 | 2;
}

export const ClickPayloadSchema = z.object({
  x: z.number(),
  y: z.number(),
  button: z.enum(['left', 'right', 'middle']),
  count: z.union([z.literal(1), z.literal(2)]),
});

/**
 * Discriminated union of every event the recorder emits.
 *
 * Notes:
 * - `ts` is epoch milliseconds (`Date.now()`); the converter treats
 *   ordering by arrival, not by wall clock, so a clock skew between
 *   the hook-worker and main doesn't matter as long as events are
 *   appended in arrival order.
 * - `app` is denormalized onto every event so the session-store can
 *   be rebuilt losslessly from `events.jsonl` alone (session.json
 *   carries only counters + app summary).
 */
export type RecorderEvent =
  | {
      type: 'app_focus';
      ts: number;
      app: AppRef;
      /** Filled when the focused app is a browser and UIA read its address bar. */
      browserUrl?: string;
    }
  | {
      type: 'window_open' | 'window_close';
      ts: number;
      app: AppRef;
    }
  | {
      type: 'click';
      ts: number;
      app: AppRef;
      browserUrl?: string;
      click: ClickPayload;
      element: ElementDescriptor;
    }
  | {
      type: 'type';
      ts: number;
      app: AppRef;
      browserUrl?: string;
      text: string;
      /** Element captured at *flush* time, not per keystroke. */
      element: ElementDescriptor;
    }
  | {
      type: 'key';
      ts: number;
      app: AppRef;
      /** Canonical key name, e.g. "enter", "tab", "ctrl+s". */
      key: string;
      modifiers: string[];
    }
  | {
      type: 'scroll';
      ts: number;
      app: AppRef;
      direction: 'up' | 'down';
      amount: number;
    };

export const RecorderEventSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('app_focus'),
    ts: z.number().int().nonnegative(),
    app: AppRefSchema,
    browserUrl: z.string().optional(),
  }),
  z.object({
    type: z.union([z.literal('window_open'), z.literal('window_close')]),
    ts: z.number().int().nonnegative(),
    app: AppRefSchema,
  }),
  z.object({
    type: z.literal('click'),
    ts: z.number().int().nonnegative(),
    app: AppRefSchema,
    browserUrl: z.string().optional(),
    click: ClickPayloadSchema,
    element: ElementDescriptorSchema,
  }),
  z.object({
    type: z.literal('type'),
    ts: z.number().int().nonnegative(),
    app: AppRefSchema,
    browserUrl: z.string().optional(),
    text: z.string(),
    element: ElementDescriptorSchema,
  }),
  z.object({
    type: z.literal('key'),
    ts: z.number().int().nonnegative(),
    app: AppRefSchema,
    key: z.string().min(1),
    modifiers: z.array(z.string()),
  }),
  z.object({
    type: z.literal('scroll'),
    ts: z.number().int().nonnegative(),
    app: AppRefSchema,
    direction: z.enum(['up', 'down']),
    amount: z.number().int().nonnegative(),
  }),
]);

/** Stable list of every event kind — useful for exhaustive switches. */
export const RECORDER_EVENT_TYPES = [
  'app_focus',
  'window_open',
  'window_close',
  'click',
  'type',
  'key',
  'scroll',
] as const;

export type RecorderEventType = (typeof RECORDER_EVENT_TYPES)[number];

/**
 * Parse a single JSONL line into a RecorderEvent, tolerating
 * truncation. Returns `null` for empty lines, invalid JSON, or schema
 * mismatches — the session-store drops the line and keeps going.
 *
 * Why a custom helper instead of `RecorderEventSchema.safeParse`:
 * the design doc requires the file reader to discard a *partial*
 * final line, and `safeParse` cannot distinguish "partial" from
 * "malformed". We surface the parse error in dev/test but never
 * throw on read.
 */
export function safeParseRecorderEvent(
  raw: string,
): { ok: true; event: RecorderEvent } | { ok: false; reason: string } {
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    return { ok: false, reason: 'empty' };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch (err) {
    return {
      ok: false,
      reason: `json:${err instanceof Error ? err.message : String(err)}`,
    };
  }
  const result = RecorderEventSchema.safeParse(parsed);
  if (!result.success) {
    return {
      ok: false,
      reason: `schema:${result.error.issues.map((i) => `${i.path.join('.')}:${i.message}`).join(';')}`,
    };
  }
  return { ok: true, event: result.data as RecorderEvent };
}