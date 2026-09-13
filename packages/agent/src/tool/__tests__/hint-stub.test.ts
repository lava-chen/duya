import { describe, expect, it } from 'vitest';
import type { Tool } from '../../types.js';
import { buildHintStubEntry } from '../hint-stub.js';

const baseTool: Tool = {
  name: 'mcp__srv__query',
  description: 'Query the service.',
  input_schema: {
    type: 'object',
    properties: {
      sql: { type: 'string' },
      limit: { type: 'number' },
    },
    required: ['sql'],
  },
};

describe('buildHintStubEntry', () => {
  it('replaces the schema with an empty object and folds the summary into the description', () => {
    const stub = buildHintStubEntry(baseTool, { inputSchemaSummary: 'sql (required), limit' });
    expect(stub.name).toBe('mcp__srv__query');
    expect(stub.input_schema).toEqual({ type: 'object', properties: {} });
    expect(stub.description).toContain('Query the service.');
    expect(stub.description).toContain('Arguments: sql (required), limit.');
  });

  it('derives the argument hint from the schema when meta has no summary', () => {
    const stub = buildHintStubEntry(baseTool);
    expect(stub.description).toContain('Arguments: sql (required), limit.');
  });

  it('keeps the original description when no hint is derivable', () => {
    const tool: Tool = {
      name: 'opaque',
      description: 'No schema info.',
      input_schema: { type: 'string' },
    };
    const stub = buildHintStubEntry(tool);
    expect(stub.description).toBe('No schema info.');
    expect(stub.input_schema).toEqual({ type: 'object', properties: {} });
  });

  it('preserves extra identity fields (mcpInfo) from the source definition', () => {
    const withInfo: Tool = {
      ...baseTool,
      mcpInfo: { serverName: 'srv', toolName: 'query', source: 'unknown' },
    } as Tool;
    const stub = buildHintStubEntry(withInfo, { inputSchemaSummary: 'sql (required)' });
    expect((stub as Tool & { mcpInfo?: unknown }).mcpInfo).toBeDefined();
  });
});
