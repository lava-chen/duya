/**
 * uia-probe-protocol.ts — wire contract between the Electron main process
 * and the persistent PowerShell UIA probe (plan 556 Phase 2, design §4.4).
 *
 * Requests (main → probe stdin) are one JSON line each:
 *   {"id":1,"op":"probe","x":123,"y":456}
 *   {"id":2,"op":"readUrl","hwnd":197144}
 *   {"id":3,"op":"ping"}
 *   {"id":4,"op":"enumerate","hwnd":197144,"maxDepth":40,"maxNodes":500,
 *      "totalMs":8000,"controlTypes":["Button","Edit",...]}   (plan 562 —
 *      knobs optional; totalMs overrides the walk budget for this request)
 *   {"id":5,"op":"invoke","hwnd":197144,"index":12,"method":"invoke",
 *      "value":null,"name":"Sign in","controlType":"Button"}
 *      (plan 564 — structural act op; index is 1-based into the probe's
 *       last enumerate emission order for that hwnd; name/controlType
 *       are optional staleness guards)
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
 *   {"id":5,"ok":true,"method":"invoke","pattern":"InvokePattern",  — plan 564:
 *      "element":{...},"value":null}                   method = what ran, pattern =
 *                                                       UIA pattern used (null for
 *                                                       focus), element = post-action
 *                                                       read-back, value = ValuePattern
 *                                                       read-back after setValue
 *   {"id":2,"ok":false,"reason":"timeout"}
 *
 * invoke failure reasons (plan 564): stale-tree (cached element gone or
 * verify mismatch — caller should re-enumerate), no-element, no-pattern,
 * bad-index, no-window, timeout.
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
  op: 'probe' | 'readUrl' | 'ping' | 'enumerate' | 'fg' | 'invoke' | 'apps' | 'windows' | 'selectText';
  x?: number;
  y?: number;
  hwnd?: number;
  /** enumerate: TreeWalker recursion depth cap (probe default when absent). */
  maxDepth?: number;
  /** enumerate: emitted-node cap (probe default when absent). */
  maxNodes?: number;
  /**
   * enumerate: total walk budget for THIS request (ms; probe default
   * 1500 when absent). The main side raises it for a cold window so the
   * first walk can absorb UIA COM activation + the target's own
   * accessibility-engine startup.
   */
  totalMs?: number;
  /** enumerate: interactive ControlType override (probe default when absent). */
  controlTypes?: string[];
  /**
   * invoke (plan 564): 1-based position in the probe's last enumerate
   * emission order for the target hwnd.
   */
  index?: number;
  /**
   * invoke: structural method. `auto` picks the pattern from the
   * element's ControlType (UFO-style default chain).
   */
  method?: 'auto' | 'invoke' | 'toggle' | 'expand' | 'collapse' | 'select' | 'focus' | 'setValue';
  /** invoke: payload for method=setValue. */
  value?: string;
  /** invoke: optional staleness guards verified against the cached element. */
  name?: string;
  controlType?: string;
  /**
   * windows (plan 575): pid filter — 0/absent lists every top-level
   * window (list_windows), a positive pid narrows to that process.
   */
  pid?: number;
  /**
   * selectText (plan 575): the text to locate inside the element's
   * TextPattern document range and select.
   */
  text?: string;
}

/**
 * Interactive ControlType whitelist (plan 562 Phase 0). Only elements
 * whose UIA ControlType is in this list become enumerate nodes; the
 * traversal still walks *through* every other element to reach the
 * interactive descendants inside containers.
 *
 * plan 576 widens the list with the ZCode content/row vocabulary:
 * DataItem/TreeItem (list/table/tree rows), Document (page content with
 * its value), SplitButton and Spinner. Static Text is deliberately NOT
 * whitelisted — Text nodes are absorbed as a `label` on the next
 * emitted element and never occupy emission slots (the 1-based invoke
 * cache order stays interactive-only).
 *
 * Order is the wire default; the enumerate request may override it via
 * `controlTypes`. Matching is case-insensitive against the
 * `ProgrammaticName` minus the `ControlType.` prefix.
 */
export const DEFAULT_INTERACTIVE_CONTROL_TYPES: readonly string[] = [
  'Button',
  'SplitButton',
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
  'DataItem',
  'TreeItem',
  'Document',
  'Spinner',
];

/**
 * Structural invoke methods (plan 564). `auto` lets the probe pick the
 * pattern from the element's ControlType (UFO²-style default chain:
 * Button/MenuItem/Hyperlink → InvokePattern, CheckBox/Toggle →
 * TogglePattern, ComboBox → ExpandCollapse, ListItem → SelectionItem,
 * Edit → ValuePattern when a value is supplied, else SetFocus).
 */
export const UIA_INVOKE_METHODS = [
  'auto',
  'invoke',
  'toggle',
  'expand',
  'collapse',
  'select',
  'focus',
  'setValue',
] as const;

export type UiaInvokeMethod = (typeof UIA_INVOKE_METHODS)[number];

/** Stable failure reason strings the probe emits for `invoke`. */
export const UIA_INVOKE_FAILURE_REASONS = {
  /** Cached element is gone or the staleness guard mismatched — re-enumerate. */
  STALE_TREE: 'stale-tree',
  /** Nothing cached for the hwnd / slot (call tree/enumerate first). */
  NO_ELEMENT: 'no-element',
  /** The element carries none of the requested UIA patterns. */
  NO_PATTERN: 'no-pattern',
  /** Index outside the cached tree (1-based). */
  BAD_INDEX: 'bad-index',
  /** The hwnd has no live UIA element (window closed). */
  NO_WINDOW: 'no-window',
  /** Internal budget blown (UIA call hung). */
  TIMEOUT: 'timeout',
} as const;

/**
 * Wire shape of one enumerate element: the recorder's element fields
 * (provenance is stamped downstream, same as probe) plus the
 * `interactive` assertion the overlay's renderer-side defense re-checks.
 */
export type EnumeratedElement = Omit<ElementDescriptor, 'source'> & {
  /** True when the element passed the interactive ControlType whitelist. */
  interactive?: boolean;
  /** Real UIA state (plan 575 probe upgrade) — absent = unknown. */
  enabled?: boolean;
  focused?: boolean;
  /** Emitted only when the element carries SelectionItemPattern. */
  selected?: boolean;
  /** Emitted only when the element carries TogglePattern (plan 576). */
  checked?: boolean;
  /** Non-empty HelpText only (plan 576). */
  description?: string;
  /**
   * plan 576 walk contract: REAL UIA tree depth relative to the window
   * root. The model-facing renderer indents by it and uses it to keep
   * ancestors when trimming.
   */
  depth?: number;
  /**
   * Static-Text run absorbed from the neighborhood (plan 576): the text
   * beside an otherwise-unlabeled field. Forward-attached by the walk,
   * capped; absent when no Text neighbor exists.
   */
  label?: string;
  /** Only when true — the walk does not descend into offscreen subtrees. */
  offscreen?: boolean;
};

/** ElementDescriptor with the `interactive` flag carried through. */
export type EnumeratedElementDescriptor = ElementDescriptor & {
  interactive?: boolean;
  enabled?: boolean;
  focused?: boolean;
  selected?: boolean;
  checked?: boolean;
  description?: string;
  depth?: number;
  label?: string;
  offscreen?: boolean;
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
      ...(request.totalMs !== undefined ? { totalMs: request.totalMs } : {}),
      ...(request.controlTypes !== undefined ? { controlTypes: request.controlTypes } : {}),
    });
  }
  if (request.op === 'invoke') {
    return JSON.stringify({
      id: request.id,
      op: 'invoke',
      hwnd: request.hwnd,
      index: request.index,
      method: request.method ?? 'auto',
      ...(request.value !== undefined ? { value: request.value } : {}),
      ...(request.name !== undefined ? { name: request.name } : {}),
      ...(request.controlType !== undefined ? { controlType: request.controlType } : {}),
    });
  }
  if (request.op === 'apps') {
    return JSON.stringify({ id: request.id, op: 'apps' });
  }
  if (request.op === 'windows') {
    return JSON.stringify({ id: request.id, op: 'windows', pid: request.pid ?? 0 });
  }
  if (request.op === 'selectText') {
    return JSON.stringify({
      id: request.id,
      op: 'selectText',
      hwnd: request.hwnd,
      index: request.index,
      text: request.text,
      ...(request.name !== undefined ? { name: request.name } : {}),
      ...(request.controlType !== undefined ? { controlType: request.controlType } : {}),
    });
  }
  return JSON.stringify({ id: request.id, op: 'ping' });
}

const EnumeratedElementSchema = ElementDescriptorSchema.omit({ source: true }).extend({
  interactive: z.boolean().optional(),
  /** Real UIA state (plan 575 probe upgrade) — absent = unknown. */
  enabled: z.boolean().optional(),
  focused: z.boolean().optional(),
  /** Emitted only when the element carries SelectionItemPattern. */
  selected: z.boolean().optional(),
  /** Emitted only when the element carries TogglePattern (plan 576). */
  checked: z.boolean().optional(),
  /** Non-empty HelpText only (plan 576). */
  description: z.string().optional(),
  /** REAL UIA tree depth relative to the window root (plan 576). */
  depth: z.number().int().nonnegative().optional(),
  /** Absorbed static-Text run (plan 576) — absent when none. */
  label: z.string().optional(),
  /** Only when true; the walk does not descend into offscreen subtrees. */
  offscreen: z.boolean().optional(),
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
  /** apps (plan 575): processes with a visible main window. */
  apps: z
    .array(
      z.object({
        pid: z.number(),
        exe: z.string().nullable(),
        title: z.string(),
        active: z.boolean(),
      }),
    )
    .optional(),
  /** windows (plan 575): top-level windows with geometry + shell state. */
  windows: z
    .array(
      z.object({
        hwnd: z.number(),
        pid: z.number(),
        title: z.string(),
        rect: z
          .object({ x: z.number(), y: z.number(), w: z.number(), h: z.number() })
          .nullable(),
        minimized: z.boolean(),
        cloaked: z.boolean(),
      }),
    )
    .optional(),
  /** Success-side qualifier, e.g. "elevated" (window skipped, UIPI). */
  reason: z.string().nullable().optional(),
  /** invoke (plan 564): the structural method that actually ran. */
  method: z.string().optional(),
  /** invoke / selectText (plan 575): UIA pattern used ("TextPattern" on select). */
  pattern: z.string().nullable().optional(),
  /** invoke: ValuePattern read-back after setValue (null otherwise). */
  value: z.string().nullable().optional(),
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
      /** invoke: structural method that ran; null for other ops. */
      method: string | null;
      /** invoke: UIA pattern used ("InvokePattern", null for SetFocus). */
      pattern: string | null;
      /** invoke: ValuePattern read-back after setValue. */
      value: string | null;
      /** apps (plan 575): processes with a visible main window; null otherwise. */
      apps: Array<{ pid: number; exe: string | null; title: string; active: boolean }> | null;
      /** windows (plan 575): top-level windows with geometry; null otherwise. */
      windows: Array<{
        hwnd: number;
        pid: number;
        title: string;
        rect: { x: number; y: number; w: number; h: number } | null;
        minimized: boolean;
        cloaked: boolean;
      }> | null;
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
      method: success.data.method ?? null,
      pattern: success.data.pattern ?? null,
      value: success.data.value ?? null,
      apps: success.data.apps ?? null,
      windows: success.data.windows ?? null,
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
