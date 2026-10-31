/**
 * F18 approval-window binding pins (plan: 2026-10-31 tool surface convergence).
 * Complements the differential file: a compatible registry change landing
 * mid-approval runs the LIVE executor with the approved arguments; a removal
 * mid-approval fails with TOOL_NOT_FOUND instead of running anything.
 */

import { describe, expect, it } from 'vitest';

import { ToolRegistry } from '../../src/tools/catalog/registry.js';
import { ToolInvokeTool } from '../../src/tools/discovery/ToolInvokeTool.js';
import { createToolInvokeDispatcherFromRegistry } from '../../src/tools/discovery/dispatcherFromRegistry.js';
import type { DiscoveryToolContext } from '../../src/tools/discovery/context.js';

function context(): { getAppState: () => Record<string, unknown>; options: Record<string, unknown> } {
  const appState: Record<string, unknown> = {};
  return { getAppState: () => appState, options: {} };
}

function slowExecutor(record: string[], seen: Array<Record<string, unknown>>): unknown {
  return {
    execute: async (input: Record<string, unknown>) => {
      record.push('live');
      seen.push(structuredClone(input));
      return { id: 'r', name: 'mcp__f18__probe', result: 'ok' };
    },
  };
}

describe('F18 approval-window binding', () => {
  it('a compatible mid-approval change runs the live executor with the approved arguments', async () => {
    const registry = new ToolRegistry();
    const record: string[] = [];
    const seen: Array<Record<string, unknown>> = [];
    registry.registerWithKey(
      'mcp__f18__probe',
      {
        name: 'mcp__f18__probe',
        description: 'F18 probe',
        input_schema: { type: 'object', properties: {} },
      },
      {
        execute: async () => {
          record.push('stale');
          return { id: 'r', name: 'mcp__f18__probe', result: 'stale-ok' };
        },
      } as never,
      'mcp',
      { exposure: 'deferred', source: { kind: 'mcp', id: 'f18' } },
    );
    const invokeTool = new ToolInvokeTool();
    registry.register(invokeTool.toTool(), invokeTool as never, { exposure: 'eager' });
    const ctx = context();
    const snapshot = registry.snapshot(new Map());
    const entry = snapshot.catalogEntries.find((e) => e.exposure === 'deferred');
    if (!entry) throw new Error('no deferred probe');
    const dispatcher = createToolInvokeDispatcherFromRegistry({
      registry,
      getSnapshot: () => snapshot,
      checkPermission: async () => {
        // The registry change lands while the permission decision is pending:
        // same internal key, compatible schema, new executor.
        const fresh = slowExecutor(record, seen);
        registry.unregister('mcp__f18__probe');
        registry.registerWithKey(
          'mcp__f18__probe',
          { name: 'mcp__f18__probe', description: 'F18 probe v2', input_schema: { type: 'object', properties: { value: { type: 'string' } } } },
          fresh,
          'mcp',
          { exposure: 'deferred', source: { kind: 'mcp', id: 'f18' }, catalogInputSchema: { type: 'object', properties: { value: { type: 'string' } } } },
        );
        return { behavior: 'allow' as const };
      },
      contextProvider: () => ctx as unknown as DiscoveryToolContext,
    } as never);
    invokeTool.setDispatcherForContext(ctx as unknown as DiscoveryToolContext, dispatcher);

    const result = await invokeTool.execute(
      { tool_id: entry.toolId, arguments: { value: 'approved-args' } },
      undefined,
      ctx as unknown as DiscoveryToolContext,
    );

    expect(result.error).toBeUndefined();
    expect(record).toEqual(['live']);
    expect(seen).toEqual([{ value: 'approved-args' }]);
  });

  it('a tool removed mid-approval fails with TOOL_NOT_FOUND instead of running', async () => {
    const registry = new ToolRegistry();
    const record: string[] = [];
    registry.registerWithKey(
      'mcp__f18__probe',
      {
        name: 'mcp__f18__probe',
        description: 'F18 probe',
        input_schema: { type: 'object', properties: {} },
      },
      {
        execute: async () => {
          record.push('stale');
          return { id: 'r', name: 'mcp__f18__probe', result: 'stale-ok' };
        },
      } as never,
      'mcp',
      { exposure: 'deferred', source: { kind: 'mcp', id: 'f18' } },
    );
    const invokeTool = new ToolInvokeTool();
    registry.register(invokeTool.toTool(), invokeTool as never, { exposure: 'eager' });
    const ctx = context();
    const snapshot = registry.snapshot(new Map());
    const deferred = snapshot.catalogEntries.find((e) => e.exposure === 'deferred');
    if (!deferred) throw new Error('no deferred probe');
    const dispatcher = createToolInvokeDispatcherFromRegistry({
      registry,
      getSnapshot: () => snapshot,
      checkPermission: async () => {
        registry.unregister('mcp__f18__probe');
        return { behavior: 'allow' as const };
      },
      contextProvider: () => ctx as unknown as DiscoveryToolContext,
    } as never);
    invokeTool.setDispatcherForContext(ctx as unknown as DiscoveryToolContext, dispatcher);

    const result = await invokeTool.execute(
      { tool_id: deferred.toolId, arguments: { value: 'approved-args' } },
      undefined,
      ctx as unknown as DiscoveryToolContext,
    );

    expect(result.error).toBe(true);
    expect(result.metadata?.errorCode).toBe('TOOL_NOT_FOUND');
    expect(record).toEqual([]);
  });
});
