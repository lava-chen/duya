/**
 * Plan 480 — catalog exposure grayscale validation harness (T6).
 *
 * This is the "灰度验证闸门" that unblocks the T1–T3 closure (deleting the
 * `discoverable`/`search` dual path + 241 injection). It validates the
 * catalog mechanism deterministically WITHOUT spinning the full agent loop:
 *
 *   1. P2.5 enforce decision matrix — `evaluateCatalogVisibilityGuard` is the
 *      exact policy DuyaAgent.guardedCanUseTool replays; we assert the reject
 *      path and the verbatim denial message under `catalog`+`enforce`.
 *   2. Meta-tool loop — `tool_schema` discovers the MCP tool, `tool_invoke`
 *      resolves + permission-gates + executes it (the catalog end-to-end).
 *   3. Edge paths — unknown tool, MCP-disconnect (unknown namespace), executor
 *      failure (G9 timeout shape), permission deny.
 *   4. Grayscale collector — replays a simulated session the way the agent
 *      loop does and reports the undeclared direct-call rate via
 *      `readUndeclaredCallStats()`. Run against real `exposure='catalog'`
 *      traffic; once the rate is at/under threshold, T1–T3 may be deleted.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { Tool, ToolResult } from '../../types.js';
import type { ToolExecutor } from '../registry.js';
import { ToolRegistry } from '../registry.js';
import {
  evaluateCatalogVisibilityGuard,
  CATALOG_VISIBILITY_DENIAL_MESSAGE,
  recordUndeclaredCall,
  readUndeclaredCallStats,
  resetUndeclaredCallStats,
} from '../visibility-guard.js';
import { toolSchemaTool } from '../ToolSchemaTool/ToolSchemaTool.js';
import { createToolSchemaProviderFromRegistry } from '../ToolSchemaTool/catalogFromRegistry.js';
import { toolInvokeTool } from '../ToolInvokeTool/ToolInvokeTool.js';
import { createToolInvokeDispatcherFromRegistry } from '../ToolInvokeTool/dispatcherFromRegistry.js';

/** The two byte-constant meta tools are always in the request's tools array. */
const META_TOOLS = new Set(['tool_schema', 'tool_invoke']);

function makeFakeMcpRegistry(): ToolRegistry {
  const registry = new ToolRegistry();
  const pingTool: Tool = {
    name: 'mcp__fakeserver__ping',
    description: 'Ping the fake MCP server.',
    input_schema: { type: 'object', properties: { msg: { type: 'string' } } },
    mcpInfo: { serverName: 'fakeserver', toolName: 'ping', source: 'unknown' },
  };
  const pingExecutor: ToolExecutor = {
    async execute(input: Record<string, unknown>): Promise<ToolResult> {
      const msg = typeof input.msg === 'string' ? input.msg : 'pong';
      return { id: 'fake', name: 'mcp__fakeserver__ping', result: `pong:${msg}` };
    },
  };
  registry.registerWithKey('mcp__fakeserver__ping', pingTool, pingExecutor, 'mcp');
  return registry;
}

describe('P2.5 enforce decision matrix (evaluateCatalogVisibilityGuard)', () => {
  const declared = META_TOOLS;

  it('catalog + enforce + undeclared real tool → reject with verbatim message', () => {
    const r = evaluateCatalogVisibilityGuard({
      exposure: 'catalog',
      catalogGuard: 'enforce',
      declaredTools: declared,
      toolName: 'mcp__fakeserver__ping',
    });
    expect(r.undeclared).toBe(true);
    expect(r.reject).toBe(true);
    expect(r.message).toBe(CATALOG_VISIBILITY_DENIAL_MESSAGE('mcp__fakeserver__ping'));
  });

  it('catalog + warn + undeclared → undeclared but NOT rejected (telemetry only)', () => {
    const r = evaluateCatalogVisibilityGuard({
      exposure: 'catalog',
      catalogGuard: 'warn',
      declaredTools: declared,
      toolName: 'mcp__fakeserver__ping',
    });
    expect(r.undeclared).toBe(true);
    expect(r.reject).toBe(false);
  });

  it('full exposure disables the guard (no undeclared concept)', () => {
    const r = evaluateCatalogVisibilityGuard({
      exposure: 'full',
      catalogGuard: 'enforce',
      declaredTools: declared,
      toolName: 'mcp__fakeserver__ping',
    });
    expect(r).toEqual({ undeclared: false, reject: false });
  });

  it('search exposure disables the guard (legacy 241 path still allowed)', () => {
    const r = evaluateCatalogVisibilityGuard({
      exposure: 'search',
      catalogGuard: 'enforce',
      declaredTools: declared,
      toolName: 'mcp__fakeserver__ping',
    });
    expect(r.undeclared).toBe(false);
  });

  it('declared meta tool is never flagged even under catalog + enforce', () => {
    const r = evaluateCatalogVisibilityGuard({
      exposure: 'catalog',
      catalogGuard: 'enforce',
      declaredTools: declared,
      toolName: 'tool_invoke',
    });
    expect(r.undeclared).toBe(false);
  });
});

describe('catalog meta-tool loop: tool_schema → tool_invoke', () => {
  let registry: ToolRegistry;

  beforeEach(() => {
    registry = makeFakeMcpRegistry();
    toolSchemaTool.setProvider(createToolSchemaProviderFromRegistry(registry));
    toolInvokeTool.setDispatcher(
      createToolInvokeDispatcherFromRegistry({
        registry,
        checkPermission: async () => ({ behavior: 'allow' }),
      }),
    );
  });

  afterEach(() => {
    toolSchemaTool.setProvider({ getCatalog: () => [] });
    toolInvokeTool.setDispatcher({ dispatch: async () => ({ result: '', error: true }) });
  });

  it('tool_schema lists the connected MCP namespace and its tool', async () => {
    const res = await toolSchemaTool.execute({ namespace: 'fakeserver' });
    expect(res.error).toBeFalsy();
    expect(res.result).toContain('fakeserver');
    expect(res.result).toContain('ping');
  });

  it('tool_invoke resolves + executes the discovered tool end-to-end', async () => {
    const res = await toolInvokeTool.execute({
      namespace: 'fakeserver',
      tool: 'ping',
      arguments: { msg: 'hi' },
    });
    expect(res.error).toBeFalsy();
    expect(res.result).toContain('pong:hi');
  });

  it('tool_invoke unknown tool → structured "Unknown tool" error', async () => {
    const res = await toolInvokeTool.execute({
      namespace: 'fakeserver',
      tool: 'nope',
      arguments: {},
    });
    expect(res.error).toBe(true);
    expect(res.result).toContain('Unknown tool');
  });

  it('MCP disconnect (unknown namespace) → tool_schema graceful "Unknown namespace"', async () => {
    const res = await toolSchemaTool.execute({ namespace: 'notconnected' });
    expect(res.error).toBe(true);
    expect(res.result).toContain('Unknown namespace');
  });

  it('executor failure (G9 timeout shape) → structured failure, no crash', async () => {
    const boom: ToolExecutor = {
      async execute(): Promise<ToolResult> {
        throw new Error('timeout after 30000ms');
      },
    };
    registry.registerWithKey(
      'mcp__fakeserver__boom',
      {
        name: 'mcp__fakeserver__boom',
        description: 'boom',
        input_schema: { type: 'object' },
        mcpInfo: { serverName: 'fakeserver', toolName: 'boom', source: 'unknown' },
      },
      boom,
      'mcp',
    );
    const res = await toolInvokeTool.execute({
      namespace: 'fakeserver',
      tool: 'boom',
      arguments: {},
    });
    expect(res.error).toBe(true);
    expect(res.result).toContain('timeout');
  });

  it('permission deny → structured error carrying the decision message', async () => {
    toolInvokeTool.setDispatcher(
      createToolInvokeDispatcherFromRegistry({
        registry,
        checkPermission: async () => ({ behavior: 'deny', message: 'blocked by policy' }),
      }),
    );
    const res = await toolInvokeTool.execute({
      namespace: 'fakeserver',
      tool: 'ping',
      arguments: {},
    });
    expect(res.error).toBe(true);
    expect(res.result).toContain('blocked by policy');
  });
});

describe('grayscale direct-call collector (T6 measurement hook)', () => {
  beforeEach(() => {
    resetUndeclaredCallStats();
  });

  /**
   * Replays a session the way DuyaAgent.guardedCanUseTool does per tool_use:
   * decide via the pure guard, and only then record undeclared calls.
   */
  function simulateSession(
    toolUses: string[],
    opts: { exposure: 'full' | 'search' | 'catalog'; catalogGuard: 'warn' | 'enforce' },
  ) {
    let undeclared = 0;
    for (const name of toolUses) {
      const d = evaluateCatalogVisibilityGuard({
        exposure: opts.exposure,
        catalogGuard: opts.catalogGuard,
        declaredTools: META_TOOLS,
        toolName: name,
      });
      if (d.undeclared) {
        undeclared += 1;
        recordUndeclaredCall(name);
      }
    }
    const stats = readUndeclaredCallStats();
    const total = toolUses.length;
    return { undeclared, stats, rate: total > 0 ? undeclared / total : 0 };
  }

  it('counts undeclared direct calls and reports the rate', () => {
    const out = simulateSession(
      ['tool_invoke', 'mcp__fakeserver__ping', 'mcp__fakeserver__ping'],
      { exposure: 'catalog', catalogGuard: 'warn' },
    );
    expect(out.undeclared).toBe(2);
    expect(out.stats['mcp__fakeserver__ping']).toBe(2);
    expect(out.rate).toBeCloseTo(2 / 3);
  });

  it('full exposure → zero undeclared (guard off, legacy path)', () => {
    const out = simulateSession(['mcp__fakeserver__ping'], {
      exposure: 'full',
      catalogGuard: 'enforce',
    });
    expect(out.undeclared).toBe(0);
    expect(out.stats).toEqual({});
  });

  it('resets cleanly between sessions', () => {
    simulateSession(['mcp__fakeserver__ping'], { exposure: 'catalog', catalogGuard: 'warn' });
    resetUndeclaredCallStats();
    expect(readUndeclaredCallStats()).toEqual({});
  });
});
