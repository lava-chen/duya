/**
 * W1 resolver unit — real-target resolution is read-only and fail-closed
 * (plan: 2026-10-31 tool surface & harness convergence, W1).
 */

import { describe, expect, it } from 'vitest';

import { ToolRegistry } from '../../src/tools/catalog/registry.js';
import { createRealTargetResolver } from '../../src/tools/discovery/real-target.js';
import { makeProbe, registerDeferred, toolIdOf } from './w1-diff-harness.js';

describe('W1 real-target resolver', () => {
  it('resolves a deferred MCP target to its direct-call scheduling view', () => {
    const registry = new ToolRegistry();
    const probe = makeProbe('mcp__w1__reader', 5);
    registerDeferred(registry, probe);
    const resolve = createRealTargetResolver(registry);

    const view = resolve({ id: 'outer-1', name: 'tool_invoke', input: { tool_id: toolIdOf(registry, probe.name), arguments: {} } });
    expect(view).toBeDefined();
    expect(view?.targetName).toBe('mcp__w1__reader');
    expect(view?.batch).toBe('read');
    expect(view?.isConcurrencySafe).toBe(false);
  });

  it('carries the target executor write-path extractor', () => {
    const registry = new ToolRegistry();
    const probe = makeProbe('mcp__w1__writer', 5, {
      extractWritePaths: (input) => [String(input.path)],
    });
    registerDeferred(registry, probe);
    const resolve = createRealTargetResolver(registry);

    const view = resolve({ id: 'outer-1', name: 'tool_invoke', input: { tool_id: toolIdOf(registry, probe.name), arguments: { path: '/tmp/x' } } });
    // The view's extractors take the OUTER call input and unwrap the
    // routed `arguments` envelope for the target's own extractor.
    expect(view?.extractWritePaths?.({ tool_id: 'x', arguments: { path: '/tmp/x' } })).toEqual(['/tmp/x']);
  });

  it('fails closed: unknown id, eager, hidden, non-invoke, malformed input', () => {
    const registry = new ToolRegistry();
    registerDeferred(registry, makeProbe('mcp__w1__any', 5), 'deferred');
    registerDeferred(registry, makeProbe('mcp__w1__eager', 5), 'eager');
    registerDeferred(registry, makeProbe('mcp__w1__hidden', 5), 'hidden');
    const resolve = createRealTargetResolver(registry);

    expect(resolve({ id: 'o', name: 'tool_invoke', input: { tool_id: 'mcp__w1__missing', arguments: {} } })).toBeUndefined();
    expect(resolve({ id: 'o', name: 'tool_invoke', input: { tool_id: 'mcp__w1__eager', arguments: {} } })).toBeUndefined();
    expect(resolve({ id: 'o', name: 'tool_invoke', input: { tool_id: 'mcp__w1__hidden', arguments: {} } })).toBeUndefined();
    expect(resolve({ id: 'o', name: 'read', input: { path: '/tmp' } })).toBeUndefined();
    expect(resolve({ id: 'o', name: 'tool_invoke', input: { arguments: {} } })).toBeUndefined();
    expect(resolve({ id: 'o', name: 'tool_invoke', input: { tool_id: '  ', arguments: {} } })).toBeUndefined();
  });

  it('is read-only and stable: repeated resolution yields identical views', () => {
    const registry = new ToolRegistry();
    registerDeferred(registry, makeProbe('mcp__w1__stable', 5));
    const resolve = createRealTargetResolver(registry);
    const first = resolve({ id: 'o', name: 'tool_invoke', input: { tool_id: 'mcp__w1__stable', arguments: {} } });
    const second = resolve({ id: 'o', name: 'tool_invoke', input: { tool_id: 'mcp__w1__stable', arguments: {} } });
    expect(second).toEqual(first);
    expect(registry.getTool('mcp__w1__stable')).toBeDefined();
  });
});
