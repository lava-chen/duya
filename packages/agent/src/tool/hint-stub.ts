import type { Tool } from '../types.js';
import { buildToolHint } from '../mcp/tool-hint.js';

/**
 * Hint-tier stub entry builder.
 *
 * A `hint`-exposed tool carries a stub definition on the request's tools
 * array instead of its full input schema: name, description (with the
 * argument summary folded in) and an empty object schema. The model sees
 * that the tool exists and what arguments it roughly takes; the full schema
 * stays behind `tool_schema` for deep reads.
 *
 * The executor receives whatever JSON the model produces — same contract as
 * the spec-budget downgrade — so a stub entry stays directly callable.
 */
export function buildHintStubEntry(
  tool: Tool,
  meta?: { inputSchemaSummary?: string },
): Tool {
  const summary =
    meta?.inputSchemaSummary?.trim() || buildToolHint(tool) || undefined;
  const description = summary
    ? `${tool.description ?? ''}\n\nArguments: ${summary}.`.trim()
    : tool.description;
  return {
    ...tool,
    description,
    input_schema: { type: 'object', properties: {} },
  };
}
