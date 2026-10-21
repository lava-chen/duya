// packages/plugin-core/src/mcp/core/descriptor.ts
// Plan 580 D1/D4 — canonical MCP tool descriptor + schema revision hash.
//
// `computeSchemaRevision` is DOWNHILLED here from
// `packages/agent/src/tool/catalog-identity.ts` (plan 580 D1). The
// algorithm is byte-identical: canonicalize (recursively sorted keys,
// undefined dropped) → JSON.stringify → sha256 hex with a `sha256:`
// prefix. Existing registry entry hashes therefore do not change; a
// byte-equal test in the agent package locks this.

import { createHash } from 'node:crypto';

/**
 * Canonical MCP tool descriptor — one entry of a completed
 * (cursor-exhausted) `tools/list` discovery. Fields mirror the MCP
 * wire shape verbatim; `inputSchema` is the CANONICAL schema and must
 * never be trimmed, re-interpreted, or type-rewritten (plan 580 D4).
 * Provider-facing projections are generated exclusively by
 * `projectForProvider` at the last mile.
 */
export interface McpToolDescriptor {
  name: string;
  description?: string;
  /** Canonical JSON-schema input spec, verbatim from the server. */
  inputSchema?: Record<string, unknown>;
  /** MCP tool annotations (readOnly / destructive / openWorld), verbatim. */
  annotations?: Record<string, unknown>;
}

/** Recursively sort object keys and drop `undefined` values. */
export function canonicalizeJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalizeJson);
  if (!value || typeof value !== 'object') return value;

  const sorted: Record<string, unknown> = {};
  for (const key of Object.keys(value as Record<string, unknown>).sort()) {
    const child = (value as Record<string, unknown>)[key];
    if (child !== undefined) sorted[key] = canonicalizeJson(child);
  }
  return sorted;
}

/**
 * Stable revision hash of a JSON-schema object. Byte-equal with the
 * pre-plan-580 `getSchemaRevision` implementation in
 * `packages/agent/src/tool/catalog-identity.ts:26-29`.
 */
export function computeSchemaRevision(schema: Record<string, unknown>): string {
  const serialized = JSON.stringify(canonicalizeJson(schema));
  return `sha256:${createHash('sha256').update(serialized).digest('hex')}`;
}
