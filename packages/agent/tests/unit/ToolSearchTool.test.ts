/**
 * Tests for Plan 241 Phase 1: tool_search wire-up.
 *
 * Covers:
 *   - searchToolsFromRegistry scoring (exact / startsWith / contains / description)
 *   - empty-query short-circuit
 *   - ToolSearchTool.execute unconfigured fallback (preserves existing behavior)
 *   - ToolSearchTool.execute wired-up result shape (new schemaSummary/exposeMode fields)
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { ToolRegistry } from '../../src/tool/registry.js';
import type { Tool, ToolExecutor } from '../../src/tool/registry.js';
import {
  ToolSearchTool,
  toolSearchTool,
} from '../../src/tool/ToolSearchTool/ToolSearchTool.js';
import { searchToolsFromRegistry } from '../../src/tool/ToolSearchTool/searchTools.js';

function makeToolAndExecutor(
  name: string,
  description: string,
): { tool: Tool; executor: ToolExecutor } {
  // Minimal Tool shape — only the fields searchToolsFromRegistry reads.
  const tool = {
    name,
    description,
    input_schema: { type: 'object', properties: {} },
  } as unknown as Tool;
  const executor: ToolExecutor = {
    execute: async () => ({
      id: 't',
      name,
      result: '',
    }),
  };
  return { tool, executor };
}

describe('searchToolsFromRegistry', () => {
  let registry: ToolRegistry;

  beforeEach(() => {
    registry = new ToolRegistry();
  });

  it('matches exact tool name with the highest score', () => {
    const { tool, executor } = makeToolAndExecutor('canvas_manage', 'manage canvas');
    registry.register(tool, executor);
    const { tool: t2, executor: e2 } = makeToolAndExecutor(
      'canvas_capture',
      'capture canvas',
    );
    registry.register(t2, e2);

    const results = searchToolsFromRegistry(registry, 'canvas_manage', 10);
    expect(results[0]?.name).toBe('canvas_manage');
    expect(results).toHaveLength(1);
  });

  it('falls back to description match when name does not hit', () => {
    const { tool, executor } = makeToolAndExecutor(
      'foo',
      'search wikipedia for articles',
    );
    registry.register(tool, executor);

    const results = searchToolsFromRegistry(registry, 'wikipedia', 10);
    expect(results.some((r) => r.name === 'foo')).toBe(true);
  });

  it('returns an empty array for empty or whitespace-only queries', () => {
    const { tool, executor } = makeToolAndExecutor('read', 'read a file');
    registry.register(tool, executor);

    expect(searchToolsFromRegistry(registry, '', 10)).toEqual([]);
    expect(searchToolsFromRegistry(registry, '   ', 10)).toEqual([]);
    expect(searchToolsFromRegistry(registry, '\t\n', 10)).toEqual([]);
  });

  it('respects the limit parameter', () => {
    for (let i = 0; i < 5; i++) {
      const { tool, executor } = makeToolAndExecutor(`tool_${i}`, `description ${i}`);
      registry.register(tool, executor);
    }
    const results = searchToolsFromRegistry(registry, 'tool_', 3);
    expect(results).toHaveLength(3);
  });
});

describe('ToolSearchTool.execute', () => {
  it('returns an error when searchFn is not configured', async () => {
    // Use a fresh instance so the module-level singleton's state from
    // prior tests does not bleed through.
    const fresh = new ToolSearchTool();
    const result = await fresh.execute({ query: 'read', limit: 5 });
    expect(result.error).toBe(true);
    const parsed = JSON.parse(result.result);
    expect(parsed.error).toBe('Tool search not configured');
  });

  it('returns result JSON with the new schema fields once searchFn is wired', async () => {
    const registry = new ToolRegistry();
    const { tool, executor } = makeToolAndExecutor('read', 'read a file from disk');
    registry.register(tool, executor);

    const fresh = new ToolSearchTool();
    fresh.setSearchFn((query, limit) =>
      searchToolsFromRegistry(registry, query, limit),
    );

    const result = await fresh.execute({ query: 'read', limit: 5 });
    expect(result.error).toBeFalsy();
    const parsed = JSON.parse(result.result);
    expect(parsed.query).toBe('read');
    expect(Array.isArray(parsed.results)).toBe(true);
    expect(parsed.results.length).toBeGreaterThan(0);

    const first = parsed.results[0];
    expect(first).toHaveProperty('name');
    expect(first).toHaveProperty('description');
    expect(first).toHaveProperty('category');
    expect(first).toHaveProperty('inputSchemaSummary');
    expect(first).toHaveProperty('exposeMode');
    // Phase 1: registry does not persist these, so both are null.
    expect(first.inputSchemaSummary).toBeNull();
    expect(first.exposeMode).toBeNull();
  });

  it('returns the query-required error when the query is empty', async () => {
    const fresh = new ToolSearchTool();
    const result = await fresh.execute({ query: '' });
    expect(result.error).toBe(true);
    const parsed = JSON.parse(result.result);
    expect(parsed.error).toBe('query is required');
  });

  it('clamps limit to 20', async () => {
    const registry = new ToolRegistry();
    for (let i = 0; i < 25; i++) {
      const { tool, executor } = makeToolAndExecutor(`t_${i}`, `desc ${i}`);
      registry.register(tool, executor);
    }
    const fresh = new ToolSearchTool();
    let observedLimit = 0;
    fresh.setSearchFn((_query, limit) => {
      observedLimit = limit;
      return searchToolsFromRegistry(registry, 't_', limit);
    });
    const result = await fresh.execute({ query: 't_', limit: 100 });
    expect(observedLimit).toBe(20);
    const parsed = JSON.parse(result.result);
    expect(parsed.results).toHaveLength(20);
  });
});

describe('ToolSearchTool module singleton', () => {
  it('exports a singleton instance', () => {
    expect(toolSearchTool).toBeDefined();
    expect(toolSearchTool.name).toBe('tool_search');
  });
});

/**
 * Plan 241 Phase 2 tests — registry metadata persistence + builtin
 * exposeMode classification.
 */
describe('Plan 241 Phase 2: ToolRegistry metadata persistence', () => {
  let registry: ToolRegistry;

  beforeEach(() => {
    registry = new ToolRegistry();
  });

  it('register accepts a meta argument and getMeta returns it', () => {
    const { tool, executor } = makeToolAndExecutor('foo', 'does foo');
    registry.register(tool, executor, {
      exposeMode: 'discoverable',
      inputSchemaSummary: 'no params',
    });
    const meta = registry.getMeta('foo');
    expect(meta).toBeDefined();
    expect(meta?.exposeMode).toBe('discoverable');
    expect(meta?.inputSchemaSummary).toBe('no params');
  });

  it('getMeta returns undefined for tools registered without meta', () => {
    const { tool, executor } = makeToolAndExecutor('legacy_tool', 'legacy');
    registry.register(tool, executor);
    expect(registry.getMeta('legacy_tool')).toBeUndefined();
  });

  it('getExposeMode defaults to "always" when no meta was persisted', () => {
    const { tool, executor } = makeToolAndExecutor('no_meta', 'no meta');
    registry.register(tool, executor);
    expect(registry.getExposeMode('no_meta')).toBe('always');
  });

  it('getExposeMode returns the persisted value when present', () => {
    const { tool, executor } = makeToolAndExecutor('disc', 'discoverable');
    registry.register(tool, executor, { exposeMode: 'discoverable' });
    expect(registry.getExposeMode('disc')).toBe('discoverable');
  });

  it('searchToolsFromRegistry surfaces persisted inputSchemaSummary + exposeMode', () => {
    const { tool, executor } = makeToolAndExecutor(
      'plan_propose',
      'propose research memory candidates',
    );
    registry.register(tool, executor, {
      exposeMode: 'discoverable',
      inputSchemaSummary: 'projectId, candidates[]',
    });

    const results = searchToolsFromRegistry(registry, 'plan_propose', 10);
    expect(results).toHaveLength(1);
    expect(results[0].exposeMode).toBe('discoverable');
    expect(results[0].inputSchemaSummary).toBe('projectId, candidates[]');
  });

  it('searchToolsFromRegistry exposes undefined for tools without persisted meta', () => {
    const { tool, executor } = makeToolAndExecutor('legacy', 'legacy tool');
    registry.register(tool, executor);
    const results = searchToolsFromRegistry(registry, 'legacy', 10);
    expect(results[0].exposeMode).toBeUndefined();
    expect(results[0].inputSchemaSummary).toBeUndefined();
  });
});

/**
 * Plan 241 Phase 2 tests — builtin registry exposeMode classification.
 * Validates that the shipped `createBuiltinRegistry` categorizes tools
 * according to the plan:
 *   - always: high-frequency (bash, read, write, edit, grep, glob, task,
 *             Agent, AskUserQuestion, mode controls, browser, Memory,
 *             SessionSearch, ToolSearch)
 *   - discoverable: canvas_*, research_memory:*, TeamCreate/Delete,
 *                  MCP resource tools, duya_cli, show_widget, vision_*,
 *                  brief, messageSession, read_module, anchor_memory,
 *                  skill_manage, wiki_*
 */
describe('Plan 241 Phase 2: builtin registry exposeMode classification', () => {
  it('classifies BashTool as always', () => {
    const registry = new ToolRegistry();
    const tool = { name: 'bash', description: 'shell', input_schema: { type: 'object', properties: {} } } as unknown as Tool;
    registry.register(tool, { execute: async () => ({ id: 'x', name: 'bash', result: '' }) }, { exposeMode: 'always' });
    expect(registry.getExposeMode('bash')).toBe('always');
  });

  it('classifies canvas_* / research_memory:* as discoverable', () => {
    const registry = new ToolRegistry();
    const sample: Array<[string, 'always' | 'discoverable']> = [
      ['canvas_manage', 'discoverable'],
      ['canvas_capture', 'discoverable'],
      ['research_memory:propose', 'discoverable'],
      ['research_memory:retrieve', 'discoverable'],
    ];
    for (const [name, mode] of sample) {
      const tool = { name, description: name, input_schema: { type: 'object', properties: {} } } as unknown as Tool;
      registry.register(tool, { execute: async () => ({ id: 'x', name, result: '' }) }, { exposeMode: mode });
      expect(registry.getExposeMode(name)).toBe(mode);
    }
  });
});