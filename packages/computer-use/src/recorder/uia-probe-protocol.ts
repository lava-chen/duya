/**
 * uia-probe-protocol.ts — wire contract between the Electron main process
 * and the persistent PowerShell UIA probe (plan 556 Phase 2, design §4.4).
 *
 * Requests (main → probe stdin) are one JSON line each:
 *   {"id":1,"op":"probe","x":123,"y":456}
 *   {"id":2,"op":"readUrl","hwnd":197144}
 *   {"id":3,"op":"ping"}
 *
 * Responses (probe stdout) are one JSON line each:
 *   {"ready":true}                                    — first line after Add-Type
 *   {"id":1,"ok":true,"element":{...}|null}
 *   {"id":2,"ok":true,"url":"https://..."}
 *   {"id":3,"ok":true}
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
  op: 'probe' | 'readUrl' | 'ping';
  x?: number;
  y?: number;
  hwnd?: number;
}

/** Serialize one request as a single ASCII line (safe for any console codepage). */
export function buildRequestLine(request: UiaProbeRequest): string {
  if (request.op === 'probe') {
    return JSON.stringify({ id: request.id, op: 'probe', x: request.x, y: request.y });
  }
  if (request.op === 'readUrl') {
    return JSON.stringify({ id: request.id, op: 'readUrl', hwnd: request.hwnd });
  }
  return JSON.stringify({ id: request.id, op: 'ping' });
}

const successResponseSchema = z.object({
  id: z.number().int().nonnegative(),
  ok: z.literal(true),
  element: ElementDescriptorSchema.omit({ source: true }).nullable().optional(),
  url: z.string().optional(),
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
  | { kind: 'response'; id: number; ok: true; element: ElementDescriptor | null; url: string | null }
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

/** True when the foreground process name looks like a supported browser. */
export function isBrowserProcess(processName: string): boolean {
  const name = processName.toLowerCase();
  return name === 'chrome' || name === 'msedge' || name === 'firefox';
}
