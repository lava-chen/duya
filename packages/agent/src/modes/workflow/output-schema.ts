/**
 * output-schema.ts — loose JSON-Schema validation for agent node
 * `output_schema` (plan 552 §4.2 constraint c: host-side validation +
 * one re-ask retry, grok host_service contract H:507-689).
 *
 * Implements the JSON-Schema subset that matters for structured
 * hand-off — type / properties / required / items / enum — without
 * pulling a full validator dependency. Unknown keywords are ignored
 * (lenient host), so a schema the validator cannot express degrades
 * to "shape unchanged" rather than false rejections.
 */

export interface LooseSchema {
  type?: string | string[];
  properties?: Record<string, LooseSchema>;
  required?: readonly string[];
  items?: LooseSchema;
  enum?: readonly unknown[];
}

function typeOf(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}

function matchesType(value: unknown, type: string): boolean {
  if (type === 'integer') return typeof value === 'number' && Number.isInteger(value);
  if (type === 'number') return typeof value === 'number' && Number.isFinite(value);
  return typeOf(value) === type;
}

/**
 * Validate `value` against the loose schema subset. Returns null when
 * valid, otherwise a short human-readable reason (fed back to the agent
 * for the one re-ask retry).
 */
export function validateLooseJsonSchema(value: unknown, schema: LooseSchema | undefined): string | null {
  if (!schema || typeof schema !== 'object') return null;

  if (schema.type) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    if (!types.some((t) => matchesType(value, t))) {
      return `expected type ${types.join('|')}, got ${typeOf(value)}`;
    }
  }
  if (schema.enum && !schema.enum.some((option) => option === value)) {
    return `value not in enum [${schema.enum.map((o) => JSON.stringify(o)).join(', ')}]`;
  }
  if (schema.type === 'object' || (schema.properties && typeOf(value) === 'object')) {
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      const obj = value as Record<string, unknown>;
      for (const key of schema.required ?? []) {
        if (!(key in obj)) return `missing required property "${key}"`;
      }
      for (const [key, sub] of Object.entries(schema.properties ?? {})) {
        if (key in obj) {
          const reason = validateLooseJsonSchema(obj[key], sub);
          if (reason) return `property "${key}": ${reason}`;
        }
      }
    }
  }
  if (schema.items && Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) {
      const reason = validateLooseJsonSchema(value[i], schema.items);
      if (reason) return `items[${i}]: ${reason}`;
    }
  }
  return null;
}
