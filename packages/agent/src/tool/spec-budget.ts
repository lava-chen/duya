/**
 * Tool spec byte budget (plan 452 Phase A).
 *
 * With Direct exposure the full inputSchema rides every request. A hosted
 * MCP server advertising a pathologically large schema (a hundred-property
 * wrapper, an embedded JSON document) would bloat the prompt for every
 * turn. Codex bounds this with `MAX_AGENT_PLUGIN_MCP_SPEC_BYTES`; duya
 * applies the same 8 KB budget at registration: over-budget schemas are
 * replaced with an empty object schema while the tool stays callable —
 * the executor still receives whatever JSON the model produces.
 */

import type { Tool } from '../types.js';

export const TOOL_SPEC_BYTE_BUDGET = 8192;

export function downgradeToolSchemaForBudget(
  definition: Tool,
  summary?: string,
): { definition: Tool; downgraded: boolean; size: number } {
  let size: number;
  try {
    size = JSON.stringify(definition.input_schema ?? {}).length;
  } catch {
    size = TOOL_SPEC_BYTE_BUDGET + 1;
  }
  if (size <= TOOL_SPEC_BYTE_BUDGET) {
    return { definition, downgraded: false, size };
  }
  const hint = summary ?? 'Use free-form JSON arguments; the server validates them.';
  return {
    definition: {
      ...definition,
      input_schema: { type: 'object', properties: {} },
      description: `${definition.description ?? ''}\n\n[Schema truncated: ${size} bytes exceeds ${TOOL_SPEC_BYTE_BUDGET}-byte budget; ${hint}]`.trim(),
    },
    downgraded: true,
    size,
  };
}
