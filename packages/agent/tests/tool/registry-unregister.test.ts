// packages/agent/tests/tool/registry-unregister.test.ts
// Phase 2A Batch A: unit tests for the new ToolRegistry additive API:
//
//   - `registerWithKey(key, definition, executor, owner?)` — register
//     under an explicit internal key distinct from `definition.name`.
//   - `unregister(key): boolean` — remove a single entry by key.
//   - `unregisterAll(predicate): number` — predicate-based removal.
//   - `replaceByOwner('mcp', preparedEntries)` — atomic replace of
//     all entries owned by a given owner (currently only 'mcp').
//
// Existing `register(definition, executor)` and the other public
// methods (`getTool / getAllTools / getExecutor / has / size /
// execute / isToolConcurrencySafe`) MUST remain byte-equivalent in
// behavior. This file asserts that as a regression guard at the end.

import { describe, it, expect } from 'vitest';
import { ToolRegistry, MCPRegistryReplaceError } from '../../src/tool/registry.js';
import type { Tool, ToolExecutor } from '../../src/types.js';

const exec: ToolExecutor = {
  execute: async (input) => ({
    id: 'x',
    name: 'placeholder',
    result: JSON.stringify(input),
  }),
};

const bash: Tool = {
  name: 'Bash',
  description: 'Run shell',
  input_schema: { type: 'object' },
};
const read: Tool = {
  name: 'Read',
  description: 'Read file',
  input_schema: { type: 'object' },
};

const mcpQuery: Tool = {
  name: 'mcp_serverA_query',
  description: 'query',
  input_schema: { type: 'object' },
  internalKey: 'mcp__serverA__query',
  providerName: 'mcp_serverA_query',
  mcpInfo: { serverName: 'serverA', toolName: 'query' },
};

const mcpSearch: Tool = {
  name: 'mcp_serverA_search',
  description: 'search',
  input_schema: { type: 'object' },
  internalKey: 'mcp__serverA__search',
  providerName: 'mcp_serverA_search',
  mcpInfo: { serverName: 'serverA', toolName: 'search' },
};

// ============================================================================
// registerWithKey
// ============================================================================

describe('ToolRegistry.registerWithKey', () => {
  it('registers a tool under the explicit key, not the definition name', () => {
    const r = new ToolRegistry();
    r.registerWithKey('mcp__serverA__query', mcpQuery, exec);
    expect(r.has('mcp__serverA__query')).toBe(true);
    // Visible name is also reachable for callers that key by it
    // (StreamingToolExecutor in Batch B uses the internal key path).
    expect(r.getTool('mcp__serverA__query')?.name).toBe('mcp_serverA_query');
  });

  it('defaults owner to "mcp"', () => {
    const r = new ToolRegistry();
    r.registerWithKey('mcp__serverA__query', mcpQuery, exec);
    // replaceByOwner('mcp', empty) should remove the entry
    r.replaceByOwner('mcp', []);
    expect(r.has('mcp__serverA__query')).toBe(false);
  });

  it('throws on duplicate key', () => {
    const r = new ToolRegistry();
    r.registerWithKey('mcp__serverA__query', mcpQuery, exec);
    expect(() => r.registerWithKey('mcp__serverA__query', mcpQuery, exec)).toThrow(
      /duplicate registration for key "mcp__serverA__query"/,
    );
  });

  it('allows separate keys that happen to share the same definition.name', () => {
    // Two MCP tools from different servers sharing the visible
    // `mcp_query` name is a legitimate collision case the engine
    // resolves via providerName suffixing; the registry must NOT
    // collapse them.
    const r = new ToolRegistry();
    const fromA: Tool = { ...mcpQuery, internalKey: 'mcp__serverA__query' };
    const fromB: Tool = {
      ...mcpQuery,
      internalKey: 'mcp__serverB__query',
      mcpInfo: { serverName: 'serverB', toolName: 'query' },
    };
    r.registerWithKey('mcp__serverA__query', fromA, exec);
    r.registerWithKey('mcp__serverB__query', fromB, exec);
    expect(r.size).toBe(2);
  });
});

// ============================================================================
// unregister
// ============================================================================

describe('ToolRegistry.unregister', () => {
  it('returns true and removes an existing entry', () => {
    const r = new ToolRegistry();
    r.register(bash, exec);
    expect(r.unregister('Bash')).toBe(true);
    expect(r.has('Bash')).toBe(false);
    expect(r.size).toBe(0);
  });

  it('returns false when the key is absent', () => {
    const r = new ToolRegistry();
    expect(r.unregister('DoesNotExist')).toBe(false);
  });

  it('does not affect other entries', () => {
    const r = new ToolRegistry();
    r.register(bash, exec);
    r.register(read, exec);
    r.unregister('Bash');
    expect(r.has('Bash')).toBe(false);
    expect(r.has('Read')).toBe(true);
    expect(r.size).toBe(1);
  });
});

// ============================================================================
// unregisterAll
// ============================================================================

describe('ToolRegistry.unregisterAll', () => {
  it('removes all entries matching the predicate and returns the count', () => {
    const r = new ToolRegistry();
    r.registerWithKey('mcp__serverA__query', mcpQuery, exec);
    r.registerWithKey('mcp__serverA__search', mcpSearch, exec);
    r.register(bash, exec);
    r.register(read, exec);
    const removed = r.unregisterAll((_key, def) => def.name.startsWith('mcp_'));
    expect(removed).toBe(2);
    expect(r.size).toBe(2);
    expect(r.has('Bash')).toBe(true);
    expect(r.has('Read')).toBe(true);
  });

  it('returns 0 when the predicate matches nothing', () => {
    const r = new ToolRegistry();
    r.register(bash, exec);
    expect(r.unregisterAll(() => false)).toBe(0);
    expect(r.size).toBe(1);
  });
});

// ============================================================================
// replaceByOwner
// ============================================================================

describe('ToolRegistry.replaceByOwner', () => {
  function makeRegistryWithBuiltins(): ToolRegistry {
    const r = new ToolRegistry();
    r.register(bash, exec);
    r.register(read, exec);
    return r;
  }

  it('atomic replace: removes all current mcp entries and adds prepared entries', () => {
    const r = makeRegistryWithBuiltins();
    r.registerWithKey('mcp__a__q', mcpQuery, exec);
    r.registerWithKey('mcp__a__s', mcpSearch, exec);
    expect(r.size).toBe(4);

    const newEntry = {
      key: 'mcp__b__q',
      definition: { ...mcpQuery, internalKey: 'mcp__b__q' } as Tool,
      executor: exec,
    };
    const result = r.replaceByOwner('mcp', [newEntry]);
    expect(result.removedKeys.sort()).toEqual(['mcp__a__q', 'mcp__a__s']);
    expect(result.addedKeys).toEqual(['mcp__b__q']);
    expect(result.keptKeys).toEqual([]);

    expect(r.size).toBe(3); // Bash + Read + mcp__b__q
    expect(r.has('Bash')).toBe(true);
    expect(r.has('Read')).toBe(true);
    expect(r.has('mcp__b__q')).toBe(true);
    expect(r.has('mcp__a__q')).toBe(false);
    expect(r.has('mcp__a__s')).toBe(false);
  });

  it('does not touch non-mcp entries (owner === "non-mcp")', () => {
    const r = makeRegistryWithBuiltins();
    r.replaceByOwner('mcp', []); // zero-config reload
    expect(r.has('Bash')).toBe(true);
    expect(r.has('Read')).toBe(true);
    expect(r.size).toBe(2);
  });

  it('handles add-only (zero → some)', () => {
    const r = makeRegistryWithBuiltins();
    const result = r.replaceByOwner('mcp', [
      { key: 'mcp__a__q', definition: mcpQuery, executor: exec },
    ]);
    expect(result.removedKeys).toEqual([]);
    expect(result.addedKeys).toEqual(['mcp__a__q']);
    expect(r.size).toBe(3);
  });

  it('handles remove-only (some → zero)', () => {
    const r = makeRegistryWithBuiltins();
    r.registerWithKey('mcp__a__q', mcpQuery, exec);
    const result = r.replaceByOwner('mcp', []);
    expect(result.removedKeys).toEqual(['mcp__a__q']);
    expect(result.addedKeys).toEqual([]);
    expect(r.size).toBe(2);
  });

  it('keptKeys reports entries that survive unchanged', () => {
    const r = makeRegistryWithBuiltins();
    r.registerWithKey('mcp__a__q', mcpQuery, exec);
    r.registerWithKey('mcp__a__s', mcpSearch, exec);
    const result = r.replaceByOwner('mcp', [
      { key: 'mcp__a__q', definition: mcpQuery, executor: exec }, // survives
      { key: 'mcp__a__s', definition: mcpSearch, executor: exec }, // survives
    ]);
    expect(result.removedKeys).toEqual([]);
    expect(result.addedKeys).toEqual([]);
    expect(result.keptKeys.sort()).toEqual(['mcp__a__q', 'mcp__a__s']);
  });

  it('throws MCPRegistryReplaceError on duplicate prepared keys; registry unchanged', () => {
    const r = makeRegistryWithBuiltins();
    r.registerWithKey('mcp__a__q', mcpQuery, exec);
    const before = r.size;
    expect(() =>
      r.replaceByOwner('mcp', [
        { key: 'mcp__b__x', definition: mcpQuery, executor: exec },
        { key: 'mcp__b__x', definition: mcpSearch, executor: exec },
      ]),
    ).toThrow(MCPRegistryReplaceError);
    // Registry state preserved.
    expect(r.size).toBe(before);
    expect(r.has('mcp__a__q')).toBe(true);
  });

  it('throws when a prepared key collides with an existing non-mcp key; registry unchanged', () => {
    const r = makeRegistryWithBuiltins();
    expect(() =>
      r.replaceByOwner('mcp', [
        { key: 'Bash', definition: bash, executor: exec },
      ]),
    ).toThrow(MCPRegistryReplaceError);
    expect(r.has('Bash')).toBe(true);
    expect(r.has('Read')).toBe(true);
  });

  it('throws on unsupported ownerId', () => {
    const r = new ToolRegistry();
    expect(() =>
      r.replaceByOwner('plugin' as 'mcp', []),
    ).toThrow(MCPRegistryReplaceError);
  });
});

// ============================================================================
// replaceByOwner — atomicity contract (validate-then-commit)
// ============================================================================
//
// These tests pin the user-mandated atomicity contract on
// `replaceByOwner`. Every error path must leave the registry
// byte-equivalent to its pre-call state; every success path
// must leave the registry in a single, deterministic committed
// state with no double registration or drift across repeated
// calls.

describe('ToolRegistry.replaceByOwner — atomicity contract', () => {
  it('success path: old mcp entries are replaced with new mcp entries; non-mcp entries are preserved', () => {
    const r = new ToolRegistry();
    r.register(bash, exec);
    r.register(read, exec);
    r.registerWithKey('mcp__a__q', mcpQuery, exec);
    r.registerWithKey('mcp__a__s', mcpSearch, exec);
    const beforeNonMcp = new Map(
      [...r.getAllTools()]
        .filter((t) => t.name === 'Bash' || t.name === 'Read')
        .map((t) => [t.name, t] as const),
    );

    const result = r.replaceByOwner('mcp', [
      { key: 'mcp__b__q', definition: mcpQuery, executor: exec },
      { key: 'mcp__b__s', definition: mcpSearch, executor: exec },
    ]);

    expect(result.removedKeys.sort()).toEqual(['mcp__a__q', 'mcp__a__s']);
    expect(result.addedKeys.sort()).toEqual(['mcp__b__q', 'mcp__b__s']);
    expect(result.keptKeys).toEqual([]);

    // Non-mcp entries preserved bit-for-bit (same Tool object).
    expect(r.getTool('Bash')).toBe(beforeNonMcp.get('Bash'));
    expect(r.getTool('Read')).toBe(beforeNonMcp.get('Read'));
    expect(r.has('mcp__a__q')).toBe(false);
    expect(r.has('mcp__a__s')).toBe(false);
    expect(r.has('mcp__b__q')).toBe(true);
    expect(r.has('mcp__b__s')).toBe(true);
    expect(r.size).toBe(4);
  });

  it('error path: duplicate prepared keys throw, registry is byte-equivalent', () => {
    const r = new ToolRegistry();
    r.register(bash, exec);
    r.registerWithKey('mcp__a__q', mcpQuery, exec);
    // Snapshot uses the registry's internal key (MCP entries are
    // keyed by `internalKey`, not by `definition.name`).
    const snapshotByKey = new Map(
      [...r.getAllTools()].map((t) => {
        // GetTool re-uses definition.name for builtin; for MCP we
        // need the actual registry key. Iterate by tools Map.
        return null;
      }).filter(() => false),
    );
    // Simpler: snapshot the size + the entry identity check we care
    // about (mcp__a__q's Tool object must still be present).
    const mcpQBefore = r.getTool('mcp__a__q');

    expect(() =>
      r.replaceByOwner('mcp', [
        { key: 'mcp__b__x', definition: mcpQuery, executor: exec },
        { key: 'mcp__b__x', definition: mcpSearch, executor: exec },
      ]),
    ).toThrow(MCPRegistryReplaceError);

    // Registry state identical to before the failed call.
    expect(r.size).toBe(2);
    expect(r.has('Bash')).toBe(true);
    expect(r.has('mcp__a__q')).toBe(true);
    expect(r.getTool('mcp__a__q')).toBe(mcpQBefore);
    expect(r.has('mcp__b__x')).toBe(false);
  });

  it('error path: prepared key collides with non-mcp key throws, registry is byte-equivalent', () => {
    const r = new ToolRegistry();
    r.register(bash, exec);
    r.register(read, exec);
    r.registerWithKey('mcp__a__q', mcpQuery, exec);
    const bashBefore = r.getTool('Bash');
    const readBefore = r.getTool('Read');
    const mcpQBefore = r.getTool('mcp__a__q');

    expect(() =>
      r.replaceByOwner('mcp', [
        // The prepared key here is the literal `Bash` — collides
        // with the non-mcp entry that was registered via the old
        // path. The call must throw and leave the registry intact.
        { key: 'Bash', definition: bash, executor: exec },
      ]),
    ).toThrow(MCPRegistryReplaceError);

    expect(r.size).toBe(3);
    expect(r.getTool('Bash')).toBe(bashBefore);
    expect(r.getTool('Read')).toBe(readBefore);
    expect(r.getTool('mcp__a__q')).toBe(mcpQBefore);
  });

  it('empty entries: clears all current mcp entries, non-mcp entries preserved', () => {
    const r = new ToolRegistry();
    r.register(bash, exec);
    r.register(read, exec);
    r.registerWithKey('mcp__a__q', mcpQuery, exec);
    r.registerWithKey('mcp__a__s', mcpSearch, exec);

    const result = r.replaceByOwner('mcp', []);

    expect(result.removedKeys.sort()).toEqual(['mcp__a__q', 'mcp__a__s']);
    expect(result.addedKeys).toEqual([]);
    expect(result.keptKeys).toEqual([]);
    expect(r.size).toBe(2);
    expect(r.has('Bash')).toBe(true);
    expect(r.has('Read')).toBe(true);
    expect(r.has('mcp__a__q')).toBe(false);
    expect(r.has('mcp__a__s')).toBe(false);
  });

  it('idempotency: two consecutive replaces with the same entries produce a stable, drift-free state', () => {
    const r = new ToolRegistry();
    r.register(bash, exec);
    r.registerWithKey('mcp__a__q', mcpQuery, exec);

    const prepared = [
      { key: 'mcp__b__q', definition: mcpQuery, executor: exec },
    ];

    const first = r.replaceByOwner('mcp', prepared);
    const firstState = r.getAllTools().map((t) => t.name).sort();

    const second = r.replaceByOwner('mcp', prepared);
    const secondState = r.getAllTools().map((t) => t.name).sort();

    // First call moves the mcp entry from `a__q` to `b__q`.
    expect(first.removedKeys).toEqual(['mcp__a__q']);
    expect(first.addedKeys).toEqual(['mcp__b__q']);

    // Second call is a no-op on the mcp side: `b__q` is in both
    // the current mcp set and the prepared set, so it goes to
    // keptKeys. No drift, no `__2` suffix, no double registration.
    expect(second.removedKeys).toEqual([]);
    expect(second.addedKeys).toEqual([]);
    expect(second.keptKeys).toEqual(['mcp__b__q']);

    expect(firstState).toEqual(secondState);
    expect(r.size).toBe(2); // Bash + mcp__b__q
    expect(r.has('mcp__a__q')).toBe(false);
    expect(r.has('mcp__b__q')).toBe(true);
  });
});

// ============================================================================
// Regression guards: existing API must remain byte-equivalent
// ============================================================================

describe('ToolRegistry — existing public API regression guard', () => {
  it('register(definition, executor) still keys by definition.name', () => {
    const r = new ToolRegistry();
    r.register(bash, exec);
    expect(r.has('Bash')).toBe(true);
    // internalKey field, if present on the definition, must NOT
    // change the lookup key in the old path. (This is the
    // "byte-equivalent" guarantee.)
    const withInternal: Tool = {
      ...bash,
      internalKey: 'mcp__legacy__Bash',
    };
    r.register(withInternal, exec);
    // Still keyed by name, internalKey ignored by the old path.
    expect(r.has('Bash')).toBe(true);
    expect(r.has('mcp__legacy__Bash')).toBe(false);
  });

  it('getTool / getAllTools / getExecutor / has / size / execute / isToolConcurrencySafe unchanged', async () => {
    const r = new ToolRegistry();
    r.register(bash, exec);
    r.register(read, exec);

    expect(r.getTool('Bash')?.name).toBe('Bash');
    expect(r.getExecutor('Bash')).toBe(exec);
    expect(r.has('Bash')).toBe(true);
    expect(r.size).toBe(2);
    expect(r.getAllTools().map((t) => t.name).sort()).toEqual(['Bash', 'Read']);
    expect(r.isToolConcurrencySafe('Bash')).toBe(false);

    const r2 = await r.execute('Bash', { cmd: 'ls' });
    // ToolResult.name is whatever the executor chose to put on it.
    // The regression guard only ensures that `execute` does not throw
    // and that the call dispatches to the registered executor.
    expect(r2).not.toBeNull();
    expect(r2?.id).toBe('x');

    // has() on a missing key returns false.
    expect(r.has('Missing')).toBe(false);
    // execute() on a missing key returns null.
    const missing = await r.execute('Missing', {});
    expect(missing).toBeNull();
  });
});
