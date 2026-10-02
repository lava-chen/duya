/**
 * packages/cli/src/commands/__tests__/mcp-list.test.ts
 *
 * Unit tests for `duya mcp list` text rendering.
 *
 * `GET /v1/mcps` returns unvalidated JSON, so renderListText must
 * tolerate malformed rows (missing/empty name, null entries,
 * non-array allowedAgentIds) instead of crashing — regression tests
 * for the TypeError on `r.name.length` reported against the
 * installed `duya` bundle.
 */

import { describe, it, expect } from 'vitest';
import { renderListText } from '../mcp.js';
import type { UserMcpTomlServer } from '@duya/plugin-core/mcp/user-config';

/** Wire-shaped rows: the CLI must not trust this shape. */
function wireRows(rows: unknown[]): UserMcpTomlServer[] {
  return rows as unknown as UserMcpTomlServer[];
}

describe('renderListText', () => {
  it('renders aligned columns for well-formed rows', () => {
    const out = renderListText(
      wireRows([
        {
          name: 'github',
          enabled: true,
          command: 'npx',
          args: ['-y', '@modelcontextprotocol/server-github'],
        },
        { name: 'docs', enabled: false, url: 'http://127.0.0.1:9/mcp' },
      ]),
    );
    expect(out).toContain('2 MCP servers configured');
    expect(out).toMatch(/github\s+on\s+stdio\s+npx\s+\[all\]/);
    expect(out).toMatch(/docs\s+off\s+streamable-http\s+http:\/\/127\.0\.0\.1:9\/mcp\s+\[all\]/);
  });

  it('renders scope from allowedAgentIds when present', () => {
    const out = renderListText(
      wireRows([{ name: 's1', enabled: true, command: 'x', allowedAgentIds: ['a', 'b'] }]),
    );
    expect(out).toContain('[a,b]');
  });

  it('does not crash when a row is missing name', () => {
    const out = renderListText(wireRows([{ enabled: true, command: 'x' }]));
    expect(out).toContain('(unnamed)');
  });

  it('does not crash when name is an empty string', () => {
    const out = renderListText(wireRows([{ name: '', enabled: true, command: 'x' }]));
    expect(out).toContain('(unnamed)');
  });

  it('does not crash when a row is null', () => {
    const out = renderListText(wireRows([null, { name: 'ok', enabled: true, command: 'x' }]));
    expect(out).toContain('2 MCP servers configured');
    expect(out).toContain('(unnamed)');
    expect(out).toContain('ok');
  });

  it('falls back to [all] scope when allowedAgentIds is not an array', () => {
    const out = renderListText(
      wireRows([{ name: 's1', enabled: true, command: 'x', allowedAgentIds: 'a' }]),
    );
    expect(out).toContain('[all]');
  });

  it('falls back to stdio transport when transport is not a string', () => {
    const out = renderListText(
      wireRows([{ name: 's1', enabled: true, command: 'x', transport: 7 }]),
    );
    expect(out).toMatch(/s1\s+on\s+stdio\s+x/);
  });

  it('treats a missing enabled field as on', () => {
    const out = renderListText(wireRows([{ name: 's1', command: 'x' }]));
    expect(out).toMatch(/s1\s+on\s+stdio\s+x/);
  });

  it('keeps the empty-list placeholder', () => {
    expect(renderListText([])).toBe(
      '(no MCP servers configured; use `duya mcp add` to add one)',
    );
  });
});
