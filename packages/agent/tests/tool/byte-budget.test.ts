import { describe, it, expect } from 'vitest';
import {
  registerAppConnectionTools,
  APP_CONNECTION_SPEC_BYTE_BUDGET,
  type AppConnectionToolDescriptor,
} from '../../src/tool/AppConnectionTool/index';
import { ToolRegistry } from '../../src/tool/registry';

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

describe('AppConnectionTool spec byte budget (Plan 450 Phase C)', () => {
  it('reports the budget constant', () => {
    expect(APP_CONNECTION_SPEC_BYTE_BUDGET).toBe(8192);
  });

  it('passes through a small schema unchanged', () => {
    const registry = new ToolRegistry();
    const result = registerAppConnectionTools(registry, [makeDescriptor(5)]);
    expect(result.downgraded).toBe(0);
    expect(result.added).toBe(1);
  });

  it('downgrades a schema that exceeds the byte budget', () => {
    // Generate a schema large enough to exceed 8KB.
    const descriptor = makeDescriptor(80);
    const serialized = JSON.stringify(descriptor.inputSchema);
    expect(serialized.length).toBeGreaterThan(APP_CONNECTION_SPEC_BYTE_BUDGET);
    const registry = new ToolRegistry();
    const result = registerAppConnectionTools(registry, [descriptor]);
    expect(result.downgraded).toBe(1);
    expect(result.added).toBe(1);
    const tool = registry.getMeta(descriptor.name);
    expect(tool).toBeDefined();
    // The registered definition's input_schema should have been flattened to
    // an empty-object schema so the prompt stays bounded.
    const definition = registry.getAllTools().find((t) => t.name === descriptor.name) as
      | { input_schema: { type: string; properties: Record<string, unknown> } }
      | undefined;
    expect(definition?.input_schema.type).toBe('object');
    expect(Object.keys(definition?.input_schema.properties ?? {}).length).toBe(0);
  });
});
