import type { Tool } from '../types.js';

/**
 * packages/agent/src/mcp/tool-hint.ts
 *
 * Plan 480 P1.4 — per-tool hint generator (the "one-line hint").
 *
 * Mirrors grok's `descriptionGenerator` / `inputSchemaSummary` role: a short,
 * schema-free line telling the model what arguments a tool takes, so it can
 * decide whether to deep-read the full schema (via `tool_schema`) without
 * fetching every schema upfront.
 *
 * The target shape is the one already used for the built-in `image_generate`
 * discoverable tool (`tool/builtin.ts`): a comma-separated argument-name list
 * with `(required)` markers, e.g.
 *
 *   prompt (required), size, quality, reference_image, output_path
 *
 * This module produces that shape from a JSON Schema, and replaces the
 * placeholder summary `'Input schema from the connected MCP server.'` that
 * MCP tool registration currently stores in `meta.inputSchemaSummary`
 * (`mcp/apply.ts`).
 */

/** Matches the image_generate hint length so hints stay one line. */
const MAX_ARGUMENTS_IN_HINT = 8;
const MAX_ARGUMENT_LABEL_LENGTH = 40;

interface JsonSchemaLike {
  type?: unknown;
  properties?: Record<string, unknown>;
  required?: unknown[];
}

function safeName(value: string): string {
  return value
    .replace(/[\r\n\t`]/g, ' ')
    .trim()
    .slice(0, MAX_ARGUMENT_LABEL_LENGTH);
}

/**
 * Build an argument-name hint from an input JSON Schema.
 *
 * @param inputSchema - The tool's raw input schema (JSON Schema draft).
 * @returns A comma-separated argument list with `(required)` markers, or ''
 *          when the schema exposes no enumerable properties (e.g. a bare
 *          string schema or a schema without a `properties` map).
 */
export function buildToolHintFromSchema(
  inputSchema: unknown,
  maxArguments: number = MAX_ARGUMENTS_IN_HINT,
): string {
  if (inputSchema === null || typeof inputSchema !== 'object') return '';

  const schema = inputSchema as JsonSchemaLike;
  const properties = schema.properties;
  if (properties === null || typeof properties !== 'object') return '';

  const names = Object.keys(properties);
  if (names.length === 0) return '';

  const required = new Set(
    Array.isArray(schema.required)
      ? schema.required.filter((item): item is string => typeof item === 'string')
      : [],
  );

  return names
    .slice(0, Math.max(1, maxArguments))
    .map((name) => {
      const label = safeName(name);
      if (!label) return null;
      return required.has(name) ? `${label} (required)` : label;
    })
    .filter((part): part is string => part !== null)
    .join(', ');
}

/**
 * Build the hint stored on a tool definition, falling back to a truthful
 * signal when nothing can be extracted (never the old placeholder).
 */
export function buildToolHint(tool: Pick<Tool, 'input_schema'>): string {
  return buildToolHintFromSchema(tool.input_schema);
}
