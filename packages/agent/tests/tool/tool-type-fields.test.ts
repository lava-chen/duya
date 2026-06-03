// packages/agent/tests/tool/tool-type-fields.test.ts
// Phase 2A Batch A: ensure the Tool interface's new optional fields
// (internalKey / providerName / displayName / mcpInfo) are accepted
// by the type system, default to undefined, and survive a
// JSON round-trip without altering the existing fields.
//
// This test is a thin type-contract check; runtime consumers are
// exercised in Batch B (provider-name-routing.test.ts) and Batch C
// (reload.test.ts).

import { describe, it, expect } from 'vitest';
import type { Tool, ToolExecutor } from '../../src/types.js';

const stubExecutor: ToolExecutor = {
  execute: async () => ({ id: '', name: 'stub', result: 'ok' }),
};

describe('Tool interface — new optional fields (Phase 2A Batch A)', () => {
  it('accepts a builtin tool without any of the new fields', () => {
    const t: Tool = {
      name: 'Bash',
      description: 'Run shell commands',
      input_schema: { type: 'object', properties: {} },
    };
    expect(t.internalKey).toBeUndefined();
    expect(t.providerName).toBeUndefined();
    expect(t.displayName).toBeUndefined();
    expect(t.mcpInfo).toBeUndefined();
  });

  it('accepts an MCP tool with all four new fields populated', () => {
    const t: Tool = {
      name: 'mcp_literature_add_source',
      description: 'Add a source',
      input_schema: { type: 'object', properties: {} },
      internalKey: 'mcp__bundled:literature__add_source',
      providerName: 'mcp_literature_add_source',
      displayName: 'Literature › Add source',
      mcpInfo: { serverName: 'bundled:literature', toolName: 'add_source' },
    };
    expect(t.internalKey).toBe('mcp__bundled:literature__add_source');
    expect(t.providerName).toBe('mcp_literature_add_source');
    expect(t.displayName).toBe('Literature › Add source');
    expect(t.mcpInfo).toEqual({
      serverName: 'bundled:literature',
      toolName: 'add_source',
    });
  });

  it('displayName is optional and does not affect dispatch fields', () => {
    const a: Tool = {
      name: 'X',
      description: '',
      input_schema: {},
      internalKey: 'mcp__a__X',
      providerName: 'mcp_a_X',
      mcpInfo: { serverName: 'a', toolName: 'X' },
    };
    const b: Tool = { ...a, displayName: 'X (display)' };
    expect(a.displayName).toBeUndefined();
    expect(b.displayName).toBe('X (display)');
    // name / internalKey / providerName / mcpInfo identical
    expect(b.name).toBe(a.name);
    expect(b.internalKey).toBe(a.internalKey);
    expect(b.providerName).toBe(a.providerName);
    expect(b.mcpInfo).toEqual(a.mcpInfo);
  });

  it('mcpInfo is structurally { serverName, toolName }', () => {
    const t: Tool = {
      name: 'Y',
      description: '',
      input_schema: {},
      mcpInfo: { serverName: 'plugin:com.duya.lit:literature', toolName: 'add_source' },
    };
    expect(typeof t.mcpInfo?.serverName).toBe('string');
    expect(typeof t.mcpInfo?.toolName).toBe('string');
  });

  it('serializes through JSON.stringify without losing the new fields', () => {
    const t: Tool = {
      name: 'Z',
      description: 'desc',
      input_schema: { type: 'object' },
      internalKey: 'mcp__a__Z',
      providerName: 'mcp_a_Z',
      mcpInfo: { serverName: 'a', toolName: 'Z' },
    };
    const json = JSON.stringify(t);
    const round: Tool = JSON.parse(json);
    expect(round.name).toBe('Z');
    expect(round.internalKey).toBe('mcp__a__Z');
    expect(round.providerName).toBe('mcp_a_Z');
    expect(round.mcpInfo).toEqual({ serverName: 'a', toolName: 'Z' });
  });

  it('builtin tools continue to work with the existing executor shape', async () => {
    // Regression guard: the new fields must not change the executor
    // contract that builtin tools use today.
    const t: Tool = {
      name: 'Bash',
      description: 'x',
      input_schema: {},
    };
    const result = await stubExecutor.execute({ cmd: 'ls' }, '/tmp');
    expect(result.name).toBe('stub');
    // Tool itself carries no executor or closure; that's owned by
    // ToolRegistry at registration time. This assertion only ensures
    // the type itself compiles and round-trips.
    expect(t.name).toBe('Bash');
  });
});
