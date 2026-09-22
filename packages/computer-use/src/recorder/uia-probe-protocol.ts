/**
 * uia-probe-protocol.ts — wire contract between the Electron main process
 * and the persistent PowerShell UIA probe (plan 556 Phase 2, design §4.4).
 *
 * Requests (main → probe stdin) are one JSON line each:
 *   {"id":1,"op":"probe","x":123,"y":456}
 *   {"id":2,"op":"readUrl","hwnd":197144}
 *   {"id":3,"op":"ping"}
 *   {"id":4,"op":"enumerate","hwnd":197144,"maxDepth":40,"maxNodes":500,
 *      "controlTypes":["Button","Edit",...]}   (plan 562 — knobs optional)
 *
 * Responses (probe stdout) are one JSON line each:
 *   {"ready":true}                                    — first line after Add-Type
 *   {"id":1,"ok":true,"element":{...}|null}
 *   {"id":2,"ok":true,"url":"https://..."}
 *   {"id":3,"ok":true}
 *   {"id":4,"ok":true,"elements":[{...}],             — interactive elements with real
 *      "truncated":false,"reason":null}                 BoundingRectangles (plan 562);
 *                                                       truncated:true = partial tree
 *                                                       kept after a budget hit,
 *                                                       reason:"elevated" = UIPI skip
 *   {"id":2,"ok":false,"reason":"timeout"}
 *
 * This module is pure data (zod parse/build helpers only) so both the
 * main-side client and the tests run without electron. Every failure
 * shape decodes to something the recorder can map to `source:'none'` —
 * a probe problem must never propagate into the recording pipeline.
 */

import { z } from 'zod';

import { ElementDescriptorSchema } from './events.js';
import type { ElementDescriptor } from './events.js';

/** Probe operation payload the main side builds. */
export interface UiaProbeRequest {
  id: number;
  op: 'probe' | 'readUrl' | 'ping' | 'enumerate' | 'fg';
  x?: number;
  y?: number;
  hwnd?: number;
  /** enumerate: TreeWalker recursion depth cap (probe default when absent). */
  maxDepth?: number;
  /** enumerate: emitted-node cap (probe default when absent). */
  maxNodes?: number;
  /** enumerate: interactive ControlType override (probe default when absent). */
  controlTypes?: string[];
}

/**
 * Interactive ControlType whitelist (plan 562 Phase 0). Only elements
 * whose UIA ControlType is in this list become enumerate nodes; the
 * traversal still walks *through* every other element to reach the
 * interactive descendants inside containers.
 *
 * Order is the wire default; the enumerate request may override it via
 * `controlTypes`. Matching is case-insensitive against the
 * `ProgrammaticName` minus the `ControlType.` prefix.
 */
export const DEFAULT_INTERACTIVE_CONTROL_TYPES: readonly string[] = [
  'Button',
  'Edit',
  'Hyperlink',
  'CheckBox',
  'RadioButton',
  'ComboBox',
  'TabItem',
  'MenuItem',
  'Slider',
  'ListItem',
  'ToggleSwitch',
];

/**
 * Wire shape of one enumerate element: the recorder's element fields
 * (provenance is stamped downstream, same as probe) plus the
 * `interactive` assertion the overlay's renderer-side defense re-checks.
 */
export type EnumeratedElement = Omit<ElementDescriptor, 'source'> & {
  /** True when the element passed the interactive ControlType whitelist. */
  interactive?: boolean;
};

/** ElementDescriptor with the `interactive` flag carried through. */
export type EnumeratedElementDescriptor = ElementDescriptor & {
  interactive?: boolean;
};

/** Serialize one request as a single ASCII line (safe for any console codepage). */
export function buildRequestLine(request: UiaProbeRequest): string {
  if (request.op === 'probe') {
    return JSON.stringify({ id: request.id, op: 'probe', x: request.x, y: request.y });
  }
  if (request.op === 'readUrl') {
    return JSON.stringify({ id: request.id, op: 'readUrl', hwnd: request.hwnd });
  }
  if (request.op === 'fg') {
    return JSON.stringify({ id: request.id, op: 'fg' });
  }
  if (request.op === 'enumerate') {
    return JSON.stringify({
      id: request.id,
      op: 'enumerate',
      hwnd: request.hwnd,
      ...(request.maxDepth !== undefined ? { maxDepth: request.maxDepth } : {}),
      ...(request.maxNodes !== undefined ? { maxNodes: request.maxNodes } : {}),
      ...(request.controlTypes !== undefined ? { controlTypes: request.controlTypes } : {}),
    });
  }
  return JSON.stringify({ id: request.id, op: 'ping' });
}

const EnumeratedElementSchema = ElementDescriptorSchema.omit({ source: true }).extend({
  interactive: z.boolean().optional(),
});

const successResponseSchema = z.object({
  id: z.number().int().nonnegative(),
  ok: z.literal(true),
  element: ElementDescriptorSchema.omit({ source: true }).nullable().optional(),
  url: z.string().optional(),
  elements: z.array(EnumeratedElementSchema).optional(),
  truncated: z.boolean().optional(),
  /** fg: foreground window snapshot (plan 562 phase 5). */
  fg: z
    .object({
      hwnd: z.number(),
      pid: z.number(),
      processName: z.string(),
      title: z.string(),
    })
    .optional(),
  /** Success-side qualifier, e.g. "elevated" (window skipped, UIPI). */
  reason: z.string().nullable().optional(),
});

const failureResponseSchema = z.object({
  id: z.number().int().nonnegative(),
  ok: z.literal(false),
  reason: z.string().optional(),
});

const readyResponseSchema = z.object({
  ready: z.literal(true),
});

export type UiaProbeResponse =
  | { kind: 'ready' }
  | {
      kind: 'response';
      id: number;
      ok: true;
      element: ElementDescriptor | null;
      url: string | null;
      /** enumerate: interactive elements with real rects; null for other ops. */
      elements: EnumeratedElementDescriptor[] | null;
      /** enumerate: true when a budget hit ended the walk early (partial tree). */
      truncated: boolean;
      /** fg: foreground window snapshot; null for other ops. */
      fg: { hwnd: number; pid: number; processName: string; title: string } | null;
      /** enumerate success qualifier, e.g. "elevated" (window skipped). */
      reason: string | null;
    }
  | { kind: 'response'; id: number; ok: false; reason: string };

/**
 * Parse one stdout line from the probe. Returns null for anything that
 * is not a valid protocol line (the caller logs and drops it).
 */
export function parseUiaProbeLine(line: string): UiaProbeResponse | null {
  const trimmed = line.trim();
  if (trimmed.length === 0) {
    return null;
  }
  let raw: unknown;
  try {
    raw = JSON.parse(trimmed);
  } catch {
    return null;
  }
  const ready = readyResponseSchema.safeParse(raw);
  if (ready.success) {
    return { kind: 'ready' };
  }
  const failure = failureResponseSchema.safeParse(raw);
  if (failure.success) {
    return {
      kind: 'response',
      id: failure.data.id,
      ok: false,
      reason: failure.data.reason ?? 'error',
    };
  }
  const success = successResponseSchema.safeParse(raw);
  if (success.success) {
    return {
      kind: 'response',
      id: success.data.id,
      ok: true,
      // The wire shape omits `source` (provenance is stamped downstream
      // by elementToDescriptor); the runtime data is compatible.
      element: (success.data.element ?? null) as ElementDescriptor | null,
      url: success.data.url ?? null,
      elements: success.data.elements
        ? success.data.elements
            .map(enumeratedElementToDescriptor)
            .filter((el): el is EnumeratedElementDescriptor => el !== null)
        : null,
      truncated: success.data.truncated ?? false,
      fg: success.data.fg ?? null,
      reason: success.data.reason ?? null,
    };
  }
  return null;
}

/**
 * Map a probe `element` payload to the recorder's ElementDescriptor.
 * The probe emits the recorder's element shape WITHOUT a `source`
 * (provenance is stamped here); `null` (or a schema mismatch) decodes
 * to `{ source: 'none' }` so upstream never has to distinguish "no
 * element" from "bad payload".
 */
export function elementToDescriptor(element: unknown): ElementDescriptor {
  if (element === null || element === undefined) {
    return { source: 'none' };
  }
  const parsed = ElementDescriptorSchema.omit({ source: true }).safeParse(element);
  if (!parsed.success) {
    return { source: 'none' };
  }
  return { ...(parsed.data as Omit<ElementDescriptor, 'source'>), source: 'uia-probe' };
}

/**
 * Map one enumerate element to a descriptor, preserving the
 * `interactive` flag the overlay's renderer-side defense re-checks.
 * Returns null for a schema mismatch — enumerate callers drop bad
 * entries instead of failing the whole tree.
 */
export function enumeratedElementToDescriptor(element: unknown): EnumeratedElementDescriptor | null {
  const parsed = EnumeratedElementSchema.safeParse(element);
  if (!parsed.success) {
    return null;
  }
  return {
    ...(parsed.data as Omit<ElementDescriptor, 'source'>),
    source: 'uia-probe',
  };
}

/**
 * Renderer-side defense for the element overlay (plan 562 Phase 3):
 * re-assert the interactive whitelist on the consuming side. Enumerate
 * already filters, but the overlay channel may be fed from anywhere —
 * anything without a whitelisted ControlType or a usable rect is
 * dropped rather than drawn.
 */
export function isInteractiveOverlayElement(
  element: EnumeratedElementDescriptor,
  controlTypes: readonly string[] = DEFAULT_INTERACTIVE_CONTROL_TYPES,
): boolean {
  if (element.interactive === false) {
    return false;
  }
  if (!element.rect || element.rect.w <= 0 || element.rect.h <= 0) {
    return false;
  }
  const type = (element.controlType ?? '').toLowerCase();
  if (type.length === 0) {
    return false;
  }
  return controlTypes.some((c) => c.toLowerCase() === type);
}

/** True when the foreground process name looks like a supported browser. */
export function isBrowserProcess(processName: string): boolean {
  const name = processName.toLowerCase();
  return name === 'chrome' || name === 'msedge' || name === 'firefox';
}
