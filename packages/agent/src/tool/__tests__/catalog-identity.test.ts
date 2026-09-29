// Plan 580 Phase 1 — agent-side byte-equal lock for the schema revision.
// `catalog-identity.getSchemaRevision` is now a re-export of the MCP
// Core implementation (`@duya/plugin-core/src/mcp/core/descriptor.ts`).
// This test keeps an inline copy of the ORIGINAL algorithm so any
// drift in the re-export breaks loudly and existing registry entry
// hashes stay stable.
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { getSchemaRevision, normalizeToolInputSchema } from '../catalog-identity.js';

function legacyCanonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(legacyCanonicalize);
  if (!value || typeof value !== 'object') return value;
  const sorted: Record<string, unknown> = {};
  for (const key of Object.keys(value as Record<string, unknown>).sort()) {
    const child = (value as Record<string, unknown>)[key];
    if (child !== undefined) sorted[key] = legacyCanonicalize(child);
  }
  return sorted;
}
function legacyGetSchemaRevision(schema: Record<string, unknown>): string {
  const serialized = JSON.stringify(legacyCanonicalize(schema));
  return `sha256:${createHash('sha256').update(serialized).digest('hex')}`;
}

const CORPUS: Record<string, unknown>[] = [
  { type: 'object', properties: {} },
  { type: 'object', properties: { q: { type: 'string' } }, required: ['q'] },
  { oneOf: [{ type: 'object' }, { type: 'string' }] },
  { type: 'object', $defs: { p: { type: 'object' } }, properties: { p: { $ref: '#/$defs/p' } } },
];

describe('catalog-identity re-export byte-equal (plan 580 D1)', () => {
  it('getSchemaRevision matches the frozen legacy algorithm', () => {
    for (const schema of CORPUS) {
      expect(getSchemaRevision(schema)).toBe(legacyGetSchemaRevision(schema));
    }
  });

  it('normalizeToolInputSchema keeps the canonicalize semantics', () => {
    const schema = { b: 2, a: 1, drop: undefined, nested: { y: 2, x: 1 } };
    const normalized = normalizeToolInputSchema(schema as never);
    expect(normalized).toEqual({ a: 1, b: 2, nested: { x: 1, y: 2 } });
  });

  it('normalizeToolInputSchema rejects non-object schemas', () => {
    expect(() => normalizeToolInputSchema([] as never)).toThrow(TypeError);
    expect(() => normalizeToolInputSchema(null as never)).toThrow(TypeError);
  });
});
