// packages/plugin-core/src/mcp/core/projection.ts
// Plan 580 D4 — canonical → provider projection, strictly last-mile.
//
// `canonicalInputSchema` is stored verbatim (registry entry, Ajv
// validation, catalog detail, schema revision). `projectForProvider`
// runs ONLY in the last mile — the moment before a tool enters the
// model's `tools[]` array:
//   - root missing `type` → minimal semantic-preserving wrap
//     `{ type: 'object', anyOf: [canonical] }` (provider APIs reject
//     typeless roots; we never overwrite a declared root);
//   - root already has `type` → pass through byte-identical;
//   - 8 KB spec budget trimming happens HERE and nowhere else — over-
//     budget schemas degrade to an empty object schema (the executor
//     still receives the raw args JSON the model produced).

export const DEFAULT_PROVIDER_SPEC_BUDGET = 8192;

export interface SchemaProjection {
  /** Provider-safe schema to send in the model `tools[]` entry. */
  schema: Record<string, unknown>;
  /** True when the budget trimmed the schema (description annotation is the caller's job). */
  downgraded: boolean;
  /** Serialized size of the canonical schema (bytes, JSON.stringify length). */
  size: number;
}

/**
 * Project a canonical input schema for a provider request. Pure
 * JSON→JSON transform; deterministic for a given (canonical, budget).
 */
export function projectForProvider(
  canonical: Record<string, unknown> | undefined,
  budget: number = DEFAULT_PROVIDER_SPEC_BUDGET,
): SchemaProjection {
  if (!canonical || typeof canonical !== 'object' || Array.isArray(canonical)) {
    return { schema: { type: 'object', properties: {} }, downgraded: false, size: 0 };
  }

  let size: number;
  try {
    size = JSON.stringify(canonical).length;
  } catch {
    size = budget + 1;
  }
  if (size > budget) {
    return { schema: { type: 'object', properties: {} }, downgraded: true, size };
  }

  const rootType = (canonical as { type?: unknown }).type;
  if (typeof rootType !== 'string' || rootType === '') {
    // Minimal semantic-preserving wrap: the canonical schema keeps its
    // full shape inside `anyOf`; the added root type satisfies providers
    // that require an object root. No declared field is overwritten.
    return {
      schema: { type: 'object', anyOf: [canonical] },
      downgraded: false,
      size,
    };
  }

  return { schema: canonical, downgraded: false, size };
}

/**
 * Build the model-visible description for a downgraded (over-budget)
 * tool. Deterministic single-line annotation; mirrors the pre-plan-580
 * spec-budget wording so existing snapshots stay stable.
 */
export function downgradedSchemaDescription(
  originalDescription: string | undefined,
  size: number,
  budget: number = DEFAULT_PROVIDER_SPEC_BUDGET,
  hint = 'Use free-form JSON arguments; the server validates them.',
): string {
  return `${originalDescription ?? ''}\n\n[Schema truncated: ${size} bytes exceeds ${budget}-byte budget; ${hint}]`.trim();
}
