// Unit tests for the invoke/MCP display-identity parser used by
// InvokeToolRow / McpToolRow / the tool registry summaries.

import { describe, it, expect } from 'vitest';
import {
  dedupeSourcePrefix,
  describeInvokeTool,
  describeMcpProviderName,
  formatInvokeSourceLabel,
  humanizeToolLabel,
  parseInvokeToolId,
} from './invoke-identity';

describe('parseInvokeToolId', () => {
  it('parses the stable catalog ID wire format', () => {
    expect(parseInvokeToolId('connector:slack:post_message')).toEqual({
      kind: 'connector',
      source: 'slack',
      toolName: 'post_message',
    });
  });

  it('decodes URL-encoded source ids and tool names', () => {
    // createToolId encodeURIComponent's the source and tool segments; a
    // server name with a slash survives the round-trip.
    expect(parseInvokeToolId('mcp:my%2Fserver:list%20files')).toEqual({
      kind: 'mcp',
      source: 'my/server',
      toolName: 'list files',
    });
  });

  it('keeps extra colons in the tool name segment', () => {
    // Encoded IDs never contain raw colons, but a hand-written ID with
    // them still parses with the tail as the tool name.
    expect(parseInvokeToolId('plugin:figma:main:list_files')).toEqual({
      kind: 'plugin',
      source: 'figma',
      toolName: 'main:list_files',
    });
  });

  it('returns null for foreign formats', () => {
    expect(parseInvokeToolId('')).toBeNull();
    expect(parseInvokeToolId('slack:post_message')).toBeNull();
    expect(parseInvokeToolId('widget:slack:post_message')).toBeNull();
  });
});

describe('humanizeToolLabel / dedupeSourcePrefix', () => {
  it('title-cases snake and kebab names', () => {
    expect(humanizeToolLabel('post_message')).toBe('Post message');
    expect(humanizeToolLabel('get-environment')).toBe('Get environment');
  });

  it('drops a repeated source prefix case-insensitively', () => {
    expect(dedupeSourcePrefix('Slack add source', 'Slack')).toBe('Add source');
    expect(dedupeSourcePrefix('Add source', 'Slack')).toBe('Add source');
    expect(dedupeSourcePrefix('Add source', '')).toBe('Add source');
  });
});

describe('formatInvokeSourceLabel', () => {
  it('title-cases provider and server ids', () => {
    expect(formatInvokeSourceLabel('connector', 'slack')).toBe('Slack');
    expect(formatInvokeSourceLabel('mcp', 'github')).toBe('Github');
  });

  it('uses the connection segment of plugin-owned ids', () => {
    expect(formatInvokeSourceLabel('plugin', 'figma:main')).toBe('Main');
  });
});

describe('describeMcpProviderName', () => {
  it('splits the first token as the server', () => {
    expect(describeMcpProviderName('mcp_github_create_issue')).toEqual({
      server: 'github',
      toolName: 'create_issue',
    });
  });

  it('returns the whole rest as the server when there is no tool segment', () => {
    expect(describeMcpProviderName('mcp_lit')).toEqual({ server: 'lit', toolName: '' });
  });

  it('returns null for non-MCP names', () => {
    expect(describeMcpProviderName('bash')).toBeNull();
    expect(describeMcpProviderName('mcp_')).toBeNull();
  });
});

describe('describeInvokeTool', () => {
  it('resolves the current { tool_id, arguments } shape', () => {
    expect(describeInvokeTool({ tool_id: 'connector:slack:post_message', arguments: {} })).toEqual({
      kind: 'connector',
      sourceId: 'slack',
      sourceLabel: 'Slack',
      toolLabel: 'Post message',
    });
  });

  it('dedupes a server prefix repeated in the tool name', () => {
    expect(describeInvokeTool({ tool_id: 'mcp:github:github_create_issue', arguments: {} })).toEqual({
      kind: 'mcp',
      sourceId: 'github',
      sourceLabel: 'Github',
      toolLabel: 'Create issue',
    });
  });

  it('falls back to the legacy { namespace, tool } draft shape', () => {
    expect(describeInvokeTool({ namespace: 'notion', tool: 'create_page' })).toEqual({
      kind: 'mcp',
      sourceId: 'notion',
      sourceLabel: 'Notion',
      toolLabel: 'Create page',
    });
    expect(describeInvokeTool({ namespace: 'builtin', tool: 'web_search' })).toEqual({
      kind: 'builtin',
      sourceId: '',
      sourceLabel: '',
      toolLabel: 'Web search',
    });
  });

  it('shows an unparseable tool_id verbatim instead of dropping the row', () => {
    expect(describeInvokeTool({ tool_id: 'legacy-flat-id', arguments: {} })).toEqual({
      kind: 'mcp',
      sourceId: '',
      sourceLabel: '',
      toolLabel: 'legacy-flat-id',
    });
  });

  it('returns null for empty or foreign inputs', () => {
    expect(describeInvokeTool(undefined)).toBeNull();
    expect(describeInvokeTool({})).toBeNull();
    expect(describeInvokeTool({ arguments: { a: 1 } })).toBeNull();
  });
});
