/**
 * mcp/result-parser.ts — MCP cross-ABI result parsing (plan 519 §3.1 / D1).
 *
 * Tools over MCP return `{ content: [{ type: 'text' | 'image', text }] }`.
 * The driver serializes duya-shaped results as JSON text; capture also
 * carries a base64 PNG as an `image` block. These parsers extract the
 * duya types back out, guarding against missing/foreign fields so a
 * driver version drift fails loudly but never crashes the tool layer.
 */

import type {
  ActionResult,
  AppInfo,
  CaptureResult,
  SomElement,
} from '../types.js';
import type { Verdict } from '../../verdict/types.js';
import type { McpToolResultContent } from './cua-driver.js';

/**
 * Pull the single JSON text payload out of an MCP tool result. Returns
 * null when there is no parseable text block (or the text isn't JSON).
 */
function parseTextPayload(result: McpToolResultContent): unknown {
  const contents = result?.content;
  if (!Array.isArray(contents)) return null;
  for (const block of contents) {
    if (block?.type === 'text' && typeof block.text === 'string' && block.text.trim() !== '') {
      try {
        return JSON.parse(block.text);
      } catch {
        // keep scanning; a non-JSON blob is not our payload
      }
    }
  }
  return null;
}

/** Pull the first base64 image block out of an MCP tool result, if any. */
function extractImageBase64(result: McpToolResultContent): string | undefined {
  const contents = result?.content;
  if (!Array.isArray(contents)) return undefined;
  for (const block of contents) {
    if (block?.type === 'image' && typeof block.text === 'string' && block.text) {
      return block.text;
    }
  }
  return undefined;
}

/** Clamp unknown values to a boolean, defaulting to false. */
function asBool(value: unknown): boolean {
  return value === true;
}

/** Parse a SOM element array, tolerating partially-filled entries. */
function parseElements(raw: unknown): SomElement[] {
  if (!Array.isArray(raw)) return [];
  const out: SomElement[] = [];
  for (const item of raw) {
    const el = item as Record<string, unknown> | null;
    if (!el || typeof el !== 'object') continue;
    // index + bbox are load-bearing for the tool; skip anything missing them.
    if (typeof el.index !== 'number') continue;
    const b = (el.bbox ?? {}) as Record<string, unknown>;
    if (typeof b.x !== 'number' || typeof b.y !== 'number') continue;
    const bbox = { x: b.x, y: b.y, w: typeof b.w === 'number' ? b.w : 0, h: typeof b.h === 'number' ? b.h : 0 };
    const kind = el.kind as SomElement['kind'] | undefined;
    const axSource = el.axSource as SomElement['axSource'] | undefined;
    out.push({
      index: el.index,
      bbox,
      label: typeof el.label === 'string' ? el.label : '',
      ...(kind ? { kind } : {}),
      ...(axSource ? { axSource } : {}),
    });
  }
  return out;
}

/**
 * Parse a `capture` tool result into a CaptureResult. The base64 image
 * comes from the `image` content block; geometry + elements from JSON.
 */
export function parseCaptureResult(result: McpToolResultContent): CaptureResult {
  const payload = (parseTextPayload(result) ?? {}) as Record<string, unknown>;
  const image = typeof result.base64 === 'string'
    ? result.base64
    : extractImageBase64(result);
  return {
    base64: image ?? '',
    width: typeof payload.width === 'number' ? payload.width : 0,
    height: typeof payload.height === 'number' ? payload.height : 0,
    elements: parseElements(payload.elements),
    displayId: typeof payload.displayId === 'number' ? payload.displayId : 0,
    capturedAt: typeof payload.capturedAt === 'string'
      ? payload.capturedAt
      : new Date().toISOString(),
  };
}

/** Parse an `ActionResult` (click / drag / type / key / focus / set_value). */
export function parseActionResult(result: McpToolResultContent): ActionResult {
  const payload = (parseTextPayload(result) ?? {}) as Record<string, unknown>;
  // Verdict may be embedded under `verdict` for read-back enable actions.
  let verdict: Verdict | undefined;
  const rawVerdict = payload.verdict as Record<string, unknown> | undefined;
  if (rawVerdict && typeof rawVerdict === 'object') {
    const effect = rawVerdict.effect;
    if (effect === 'confirmed' || effect === 'unverifiable' || effect === 'suspected_noop') {
      const escalationRaw = rawVerdict.escalation as Record<string, unknown> | undefined;
      const escalation: Verdict['escalation'] | undefined =
        escalationRaw && typeof escalationRaw === 'object'
          ? {
              recommended: asEscalationRec(escalationRaw.recommended),
              reason: asString(escalationRaw.reason),
            }
          : undefined;
      verdict = {
        effect,
        verified: {
          elementChanged: asBool((rawVerdict.verified as Record<string, unknown> | undefined)?.elementChanged),
          newFocusedEntity: null,
        },
        ...(escalation ? { escalation } : {}),
        ...(typeof rawVerdict.readbackMs === 'number' ? { readbackMs: rawVerdict.readbackMs } : {}),
        ...(typeof rawVerdict.fallbackUsed === 'boolean' ? { fallbackUsed: rawVerdict.fallbackUsed } : {}),
      };
    }
  }
  return {
    ok: payload.ok !== false,
    ...(typeof payload.ok === 'boolean' && !payload.ok ? { reason: typeof payload.reason === 'string' ? payload.reason : undefined } : {}),
    ...(typeof payload.durationMs === 'number' ? { durationMs: payload.durationMs } : {}),
    ...(verdict ? { verdict } : {}),
  };
}

/** Parse a `list_apps` tool result into AppInfo[]. */
export function parseListApps(result: McpToolResultContent): AppInfo[] {
  const payload = (parseTextPayload(result) ?? {}) as Record<string, unknown>;
  if (!Array.isArray(payload.apps)) return [];
  const out: AppInfo[] = [];
  for (const item of payload.apps as Array<Record<string, unknown>>) {
    if (!item || typeof item !== 'object') continue;
    out.push({
      title: asString(item.title) || '',
      processName: asString(item.processName) || '',
      pid: typeof item.pid === 'number' ? item.pid : null,
      // focusedEntity must remain null unless a real object comes through;
      // we never fabricate one from a loose string on the MCP edge.
    });
  }
  return out;
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function asEscalationRec(value: unknown): 're-capture' | 'raise' | 'foreground' {
  if (value === 're-capture' || value === 'raise' || value === 'foreground') return value;
  return 're-capture';
}

/** Re-export for tests that need the raw guard helpers. */
export { asBool };