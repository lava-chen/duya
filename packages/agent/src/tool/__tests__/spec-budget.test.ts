import { describe, it, expect } from 'vitest';
import { downgradeToolSchemaForBudget, TOOL_SPEC_BYTE_BUDGET } from '../spec-budget.js';
import type { Tool } from '../../types.js';

function makeTool(schemaBytes: number): Tool {
  return {
    name: 'big_tool',
    description: 'A tool with a large schema',
    input_schema: {
      type: 'object',
      properties: {
        payload: { type: 'string', description: 'x'.repeat(schemaBytes) },
      },
    },
  };
}

describe('downgradeToolSchemaForBudget (plan 452 Phase A)', () => {
  it('keeps schemas within the budget untouched', () => {
    const tool = makeTool(100);
    const result = downgradeToolSchemaForBudget(tool, 'summary');
    expect(result.downgraded).toBe(false);
    expect(result.definition).toBe(tool);
  });

  it('downgrades over-budget schemas to an empty object + description hint', () => {
    const tool = makeTool(TOOL_SPEC_BYTE_BUDGET * 2);
    const result = downgradeToolSchemaForBudget(tool, 'see the server docs');
    expect(result.downgraded).toBe(true);
    expect(result.definition.input_schema).toEqual({ type: 'object', properties: {} });
    expect(result.definition.description).toContain('Schema truncated');
    expect(result.definition.description).toContain('see the server docs');
    expect(result.definition.name).toBe('big_tool');
  });

  it('uses a generic hint when no summary is provided', () => {
    const result = downgradeToolSchemaForBudget(makeTool(TOOL_SPEC_BYTE_BUDGET * 2));
    expect(result.definition.description).toContain('free-form JSON');
  });

  it('treats non-serializable schemas as over-budget', () => {
    const tool: Tool = {
      name: 'cyclic',
      description: 'd',
      input_schema: {
        type: 'object',
        properties: {},
      },
    };
    // Circular reference via a getter-free assignment is impossible in
    // plain JSON-schema objects; simulate by passing a schema that throws
    // during stringify using a self-referencing structure cast to the type.
    const circular: Record<string, unknown> = { type: 'object', properties: {} };
    circular['self'] = circular;
    const result = downgradeToolSchemaForBudget({ ...tool, input_schema: circular as Tool['input_schema'] });
    expect(result.downgraded).toBe(true);
  });
});
