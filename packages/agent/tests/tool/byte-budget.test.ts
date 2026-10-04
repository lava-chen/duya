import { describe, it, expect } from 'vitest';
import {
  registerAppConnectionTools,
  type AppConnectionToolDescriptor,
} from '../../src/tool/AppConnectionTool/index';
import { TOOL_SPEC_BYTE_BUDGET } from '../../src/tool/spec-budget';
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
// `downgradeForByteBudget`, and exported APP_CONNECTION_SPEC_BYTE_BUDGET from
// this module's subject. Plan 580 D4 deleted both: the registry now stores the
// server's canonical schema verbatim (Ajv validation, the catalog detail view
// and the schema revision hash all need it unmodified), and the 8 KB trim
// moved to the last mile, `projectForProvider` in @duya/plugin-core,
// immediately before a tool enters the model's `tools[]`.
//
// So the invariant that survives here is the half this module owns:
// registration must NOT trim, at any size. The trimming half is asserted
// where it now lives, in plugin-core's projection tests. Reaching across the
// package boundary to re-assert it from here would be a new
// pkg:agent -> pkg:plugin-core edge for a test file, and the same behaviour
// would be covered twice.
describe('AppConnectionTool spec byte budget (plan 450 Phase C, relocated by plan 580 D4)', () => {
  it('reports the budget constant', () => {
    expect(TOOL_SPEC_BYTE_BUDGET).toBe(8192);
  });

  it('registers a small schema verbatim', () => {
    const registry = new ToolRegistry();
    const descriptor = makeDescriptor(5);
    const result = registerAppConnectionTools(registry, [descriptor]);

    expect(result.added).toBe(1);
    expect(result.downgraded).toBe(0);
    expect(definitionFor(registry, descriptor.name)?.input_schema).toEqual(descriptor.inputSchema);
  });

  it('does not trim an over-budget schema at registration', () => {
    // A schema large enough that the last-mile projection will trim it.
    const descriptor = makeDescriptor(80);
    const serialized = JSON.stringify(descriptor.inputSchema);
    expect(serialized.length).toBeGreaterThan(TOOL_SPEC_BYTE_BUDGET);

    const registry = new ToolRegistry();
    const result = registerAppConnectionTools(registry, [descriptor]);

    expect(result.added).toBe(1);
    expect(result.downgraded).toBe(0);
    // Byte-identical to what the server advertised: trimming here would change
    // the schema revision hash and break round-trip validation.
    const definition = definitionFor(registry, descriptor.name);
    expect(JSON.stringify(definition?.input_schema).length).toBe(serialized.length);
    expect(definition?.input_schema).toEqual(descriptor.inputSchema);
  });
});
