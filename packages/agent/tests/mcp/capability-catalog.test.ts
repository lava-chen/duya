import { describe, expect, it } from 'vitest';
import { buildMCPCapabilityCatalog } from '../../src/mcp/capability-catalog.js';
import { buildToolHintFromSchema, buildToolHint } from '../../src/mcp/tool-hint.js';
import type { Tool } from '../../src/types.js';

function mcpTool(
  serverName: string,
  toolName: string,
  source: NonNullable<Tool['mcpInfo']>['source'] = 'plugin',
): Tool {
  return {
    name: `mcp_${serverName}_${toolName}`,
    description: toolName,
    input_schema: { type: 'object' },
    mcpInfo: { serverName, toolName, source },
  };
}

describe('buildMCPCapabilityCatalog', () => {
  it('groups tools by connected server without exposing schemas', () => {
    const catalog = buildMCPCapabilityCatalog([
      mcpTool('notion', 'search_pages'),
      mcpTool('notion', 'create_page'),
      mcpTool('github', 'list_pull_requests', 'settings'),
    ]);

    expect(catalog).toContain('## MCP Capability Directory');
    expect(catalog).toContain('`notion` (plugin, 2 tools): create_page, search_pages');
    expect(catalog).toContain('`github` (user config.toml, 1 tools): list_pull_requests');
    expect(catalog).toContain('call `tool_search` with the server name');
    expect(catalog).not.toContain('input_schema');
  });

  it('returns an empty string when no MCP tools are connected', () => {
    expect(buildMCPCapabilityCatalog([])).toBe('');
  });

  it('renders byte-identically for the same toolset regardless of input order', () => {
    // Registration order is a Map insertion order and varies across sessions;
    // the rendered directory must NOT depend on it (Plan 480 P1.2).
    const forward = [
      mcpTool('notion', 'search_pages'),
      mcpTool('notion', 'create_page'),
      mcpTool('notion', 'update_page'),
      mcpTool('github', 'list_pull_requests'),
      mcpTool('slack', 'post_message'),
    ];
    const backward = [...forward].reverse();
    const shuffled = [
      forward[4],
      forward[1],
      forward[3],
      forward[0],
      forward[2],
    ];

    const a = buildMCPCapabilityCatalog(forward);
    const b = buildMCPCapabilityCatalog(backward);
    const c = buildMCPCapabilityCatalog(shuffled);
    expect(a).toBe(b);
    expect(a).toBe(c);
  });

  it('sorts tool names within a server byte-order', () => {
    const catalog = buildMCPCapabilityCatalog([
      mcpTool('zebra', 'zeta'),
      mcpTool('zebra', 'alpha'),
      mcpTool('zebra', 'mid'),
    ]);
    expect(catalog).toContain('alpha, mid, zeta');
  });

  it('caps tool names per server with a +N more suffix', () => {
    const tools = Array.from({ length: 6 }, (_, i) =>
      mcpTool('big', `tool_${i}`),
    );
    const catalog = buildMCPCapabilityCatalog(tools);
    expect(catalog).toContain('`big` (plugin, 6 tools): tool_0, tool_1, tool_2, tool_3, +2 more');
  });

  it('enforces the total character budget by dropping trailing servers', () => {
    // 40 servers under a tight 600-char budget must not render all of them.
    // maxServers must stay above what the character budget admits, so the
    // budget (not the server cap) is what truncates.
    const tools = Array.from({ length: 40 }, (_, i) =>
      mcpTool(`server_${String(i).padStart(2, '0')}`, 'tool_a'),
    );
    const catalog = buildMCPCapabilityCatalog(tools, {
      maxTotalChars: 600,
      maxServers: 40,
    });
    expect(catalog).toContain('omitted from this compact directory');
    // Trailing servers must be dropped once the character budget is spent.
    expect(catalog).not.toContain('`server_39`');
    expect(catalog.length).toBeLessThan(1200);
  });

  it('annotates the directory when discovery is still warming', () => {
    const catalog = buildMCPCapabilityCatalog([mcpTool('github', 'list_pull_requests')], {
      incomplete: true,
    });
    expect(catalog).toContain('still warming');
  });

  it('respects the maxServers option', () => {
    const tools = ['a', 'b', 'c', 'd', 'e'].map((s) => mcpTool(s, 'tool_x'));
    const catalog = buildMCPCapabilityCatalog(tools, { maxServers: 2 });
    expect(catalog).toContain('`a`');
    expect(catalog).not.toContain('`c`');
  });
});

describe('buildToolHintFromSchema (Plan 480 P1.4)', () => {
  it('lists argument names with required markers in schema order', () => {
    const hint = buildToolHintFromSchema({
      type: 'object',
      properties: {
        prompt: { type: 'string' },
        size: { type: 'string', enum: ['s', 'l'] },
        output_path: { type: 'string' },
      },
      required: ['prompt'],
    });
    expect(hint).toBe('prompt (required), size, output_path');
  });

  it('returns an empty string when the schema exposes no properties', () => {
    expect(buildToolHintFromSchema({ type: 'object' })).toBe('');
    expect(buildToolHintFromSchema({ type: 'string' })).toBe('');
    expect(buildToolHintFromSchema(undefined)).toBe('');
    expect(buildToolHintFromSchema(null)).toBe('');
  });

  it('caps the number of arguments shown', () => {
    const properties: Record<string, unknown> = {};
    for (let i = 0; i < 20; i++) properties[`arg_${i}`] = { type: 'string' };
    const hint = buildToolHintFromSchema({ type: 'object', properties }, 4);
    expect(hint.split(', ')).toHaveLength(4);
    expect(hint).toBe('arg_0, arg_1, arg_2, arg_3');
  });

  it('sanitizes labels that could break the one-line format', () => {
    const hint = buildToolHintFromSchema({
      type: 'object',
      properties: { 'bad`name\nwith\ttab': { type: 'string' } },
    });
    expect(hint).not.toContain('`');
    expect(hint).not.toContain('\n');
    expect(hint).not.toContain('\t');
  });

  it('buildToolHint wraps a full Tool definition', () => {
    const tool: Tool = {
      name: 'x',
      description: 'x',
      input_schema: { type: 'object', properties: { id: { type: 'string' } } },
    };
    expect(buildToolHint(tool)).toBe('id');
  });
});

  it('switches the closing guidance to tool_schema/tool_invoke in catalog mode', () => {
    const catalog = buildMCPCapabilityCatalog([mcpTool('github', 'list_pull_requests')], {
      entryPoint: 'tool_invoke',
    });
    expect(catalog).toContain('call `tool_schema` with the server name');
    expect(catalog).toContain('invoke it with `tool_invoke`');
    expect(catalog).not.toContain('call `tool_search`');

    const legacy = buildMCPCapabilityCatalog([mcpTool('github', 'list_pull_requests')]);
    expect(legacy).toContain('call `tool_search` with the server name');
  });
