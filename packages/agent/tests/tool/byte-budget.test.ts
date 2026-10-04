import { describe, it, expect } from 'vitest';
import {
  registerAppConnectionTools,
  type AppConnectionToolDescriptor,
} from '../../src/tool/AppConnectionTool/index';
import { projectForProvider, DEFAULT_PROVIDER_SPEC_BUDGET } from '@duya/plugin-core/mcp/core/projection';
import { ToolRegistry } from '../../src/tool/registry';
import type { Tool } from '../../src/types';

function makeDescriptor(inputSchemaProps: number): AppConnectionToolDescriptor {
  const properties: Record<string, unknown> = {};
  for (let i = 0; i < inputSchemaProps; i++) {
    properties[`prop_${i}`] = {
      type: 'string',
      title: `Property ${i}`,
      description: 'x'.repeat(200),
    };
  }
  return {
    name: 'remote_notion_test',
    description: 'Big schema tool',
    inputSchema: { type: 'object', properties },
    inputSchemaSummary: 'summary',
    riskTier: 'modify',
    provider: 'notion',
    connectionId: 'conn',
    action: 'remote:test',
  };
}

/** The registered definition for a tool name, or undefined. */
function definitionFor(registry: ToolRegistry, name: string): Tool | undefined {
  return registry.getAllTools().find((t) => t.name === name);
}

// Plan 450 Phase C put the byte budget at registration time, in
// `downgradeForByteBudget`. Plan 580 D4 deleted that: the registry now stores
// the server's canonical schema verbatim (Ajv validation, the catalog detail
// view and the schema revision hash all need it unmodified), and the 8 KB
// trim moved to the last mile, `projectForProvider`, immediately before a tool
// enters the model's `tools[]`. These tests pin the relocated invariant, and
// pin it across the layer boundary: registration must NOT trim, projection
// MUST.
describe('AppConnectionTool spec byte budget (plan 450 Phase C, relocated by plan 580 D4)', () => {
  it('reports the budget constant', () => {
    expect(DEFAULT_PROVIDER_SPEC_BUDGET).toBe(8192);
  });

  it('passes through a small schema unchanged', () => {
    const registry = new ToolRegistry();
    const descriptor = makeDescriptor(5);
    const result = registerAppConnectionTools(registry, [descriptor]);

    expect(result.added).toBe(1);
    expect(result.downgraded).toBe(0);

    const definition = definitionFor(registry, descriptor.name);
    expect(definition?.input_schema).toEqual(descriptor.inputSchema);
    expect(projectForProvider(definition?.input_schema).downgraded).toBe(false);
  });

  it('trims an over-budget schema at the last mile, never at registration', () => {
    // Generate a schema large enough to exceed 8KB.
    const descriptor = makeDescriptor(80);
    const serialized = JSON.stringify(descriptor.inputSchema);
    expect(serialized.length).toBeGreaterThan(DEFAULT_PROVIDER_SPEC_BUDGET);

    const registry = new ToolRegistry();
    const result = registerAppConnectionTools(registry, [descriptor]);

    expect(result.added).toBe(1);
    // The registry keeps the full canonical schema: trimming here would
    // change the revision hash and break round-trip validation.
    expect(result.downgraded).toBe(0);
    const definition = definitionFor(registry, descriptor.name);
    expect(JSON.stringify(definition?.input_schema).length).toBe(serialized.length);

    // What reaches the model is flattened to an empty-object schema so the
    // prompt stays bounded, while the tool stays callable.
    const projection = projectForProvider(definition?.input_schema);
    expect(projection.downgraded).toBe(true);
    expect(projection.size).toBe(serialized.length);
    expect(projection.schema.type).toBe('object');
    expect(Object.keys(projection.schema.properties as Record<string, unknown>).length).toBe(0);
  });
});
