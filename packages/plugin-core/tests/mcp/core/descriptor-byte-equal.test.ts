// Plan 580 Phase 1 — computeSchemaRevision byte-equal guard.
// The Core implementation must be byte-identical with the original
// `catalog-identity.ts` algorithm (canonicalize → JSON.stringify →
// sha256). This test keeps a frozen inline copy of the ORIGINAL
// algorithm so any drift breaks loudly, independent of the re-export.
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { computeSchemaRevision, canonicalizeJson } from '../../../src/mcp/core/descriptor.js';

// FROZEN original implementation (packages/agent/src/tool/catalog-identity.ts
// at plan-580 baseline). Do not update this copy when Core evolves —
// update Core instead.
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
  { type: 'object', properties: { q: { type: 'string', description: 'Search query' } }, required: ['q'] },
  { oneOf: [{ type: 'object' }, { type: 'string' }] },
  {
    type: 'object',
    $defs: { page: { type: 'object', properties: { id: { type: 'string' } } } },
    properties: { page: { $ref: '#/$defs/page' } },
    additionalProperties: false,
    default: { x: 1 },
    title: 'Query',
  },
  { type: 'object', properties: { n: { type: 'number', default: 0 } }, zzz: 1, aaa: { b: 2, a: 1 } },
];

describe('computeSchemaRevision byte-equal (plan 580 D1)', () => {
  it('matches the frozen legacy algorithm over the corpus', () => {
    for (const schema of CORPUS) {
      expect(computeSchemaRevision(schema)).toBe(legacyGetSchemaRevision(schema));
    }
  });

  it('key order does not change the revision; undefined values are dropped', () => {
    const a = { type: 'object', properties: { a: { type: 'string' }, b: { type: 'number' } } };
    const b = { properties: { b: { type: 'number' }, a: { type: 'string' } }, type: 'object' };
    expect(computeSchemaRevision(a)).toBe(computeSchemaRevision(b));
    expect(canonicalizeJson({ a: 1, b: undefined })).toEqual({ a: 1 });
  });

  it('produces the sha256: prefixed hex form', () => {
    expect(computeSchemaRevision({})).toMatch(/^sha256:[0-9a-f]{64}$/);
  });
});
