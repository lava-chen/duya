// Plan 580 Phase 1 — deadline clock, alias allocator, projection, ledger types.
import { describe, expect, it } from 'vitest';
import { createDeadlineClock, deadlineClockFrom, deadlineClockFromIpc } from '../../../src/mcp/core/deadline.js';
import {
  allocateConnectionToolAlias,
  connectionNamespace,
  deriveConnectionSlug,
  fnv1a32Hex,
} from '../../../src/mcp/core/alias.js';
import { downgradedSchemaDescription, projectForProvider } from '../../../src/mcp/core/projection.js';
import { McpError } from '../../../src/mcp/core/error-taxonomy.js';
import {
  emptyLedgerSnapshot,
  serializeInventoryLedgerSnapshot,
} from '../../../src/mcp/core/ledger-types.js';

describe('DeadlineClock (plan 580 D5)', () => {
  it('tracks remaining time without going negative', () => {
    const clock = createDeadlineClock(1000, 1_000_000);
    expect(clock.deadlineAt).toBe(1_001_000);
    expect(clock.remainingMs(1_000_400)).toBe(600);
    expect(clock.remainingMs(1_002_000)).toBe(0);
    expect(clock.isExpired(1_001_000)).toBe(true);
    expect(clock.isExpired(1_000_999)).toBe(false);
  });

  it('bridges to an AbortController; abort is idempotent', () => {
    const clock = createDeadlineClock(5000);
    expect(clock.signal.aborted).toBe(false);
    clock.abort();
    expect(clock.signal.aborted).toBe(true);
    expect(() => clock.abort()).not.toThrow();
  });

  it('throwIfExpired throws MCP_TIMEOUT synchronously', () => {
    const clock = deadlineClockFrom(1);
    expect(() => clock.throwIfExpired('callTool')).toThrowError(McpError);
  });

  it('reconstructs from an IPC deadlineAt stamp and ignores malformed values', () => {
    const now = Date.now();
    const clock = deadlineClockFromIpc(now + 5000);
    expect(clock).toBeDefined();
    expect(clock!.remainingMs(now)).toBeLessThanOrEqual(5000);
    expect(deadlineClockFromIpc(undefined)).toBeUndefined();
    expect(deadlineClockFromIpc(-1)).toBeUndefined();
    expect(deadlineClockFromIpc('soon')).toBeUndefined();
  });
});

describe('connection slug + alias allocator (plan 580 D7)', () => {
  it('fnv1a32Hex is deterministic and 8 hex chars', () => {
    const a = fnv1a32Hex('connection-uuid-1');
    expect(a).toMatch(/^[0-9a-f]{8}$/);
    expect(fnv1a32Hex('connection-uuid-1')).toBe(a);
    expect(fnv1a32Hex('connection-uuid-2')).not.toBe(a);
  });

  it('derives a 4-hex slug; expands to 6-hex on collision', () => {
    const slugA = deriveConnectionSlug('conn-a', new Set());
    expect(slugA).toHaveLength(4);
    // Force a collision: take whatever 4-hex slice conn-b would get.
    const fullB = fnv1a32Hex('conn-b').slice(0, 4);
    const slugB = deriveConnectionSlug('conn-b', new Set([fullB]));
    expect(slugB).toHaveLength(6);
    expect(slugB).toBe(fnv1a32Hex('conn-b').slice(0, 6));
  });

  it('namespace: first connection holds the bare provider, later ones get provider:slug', () => {
    expect(connectionNamespace('notion', '')).toBe('notion');
    expect(connectionNamespace('notion', 'a31f')).toBe('notion:a31f');
  });

  it('single-connection alias is byte-identical with the pre-plan-580 chain B toolAlias', () => {
    // Before: `remote_${provider}_${toolName}`.replace(/[^a-zA-Z0-9_-]/g, '_')
    const legacy = (provider: string, toolName: string) =>
      `remote_${provider}_${toolName}`.replace(/[^a-zA-Z0-9_-]/g, '_');
    const cases: Array<[string, string]> = [
      ['notion', 'search'],
      ['notion', 'create_page'],
      ['notion', 'get-page-1'],
      ['google_drive', 'list.files'],
      ['slack', 'postMessage'],
    ];
    for (const [provider, toolName] of cases) {
      const alias = allocateConnectionToolAlias(connectionNamespace(provider, ''), toolName, new Set());
      expect(alias, `${provider}/${toolName}`).toBe(legacy(provider, toolName));
    }
  });

  it('sanitizes illegal chars and never exceeds 64 chars', () => {
    const longTool = 'x'.repeat(200);
    const alias = allocateConnectionToolAlias('notion', longTool, new Set());
    expect(alias.length).toBeLessThanOrEqual(64);
    expect(alias).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it('two accounts of one provider never share an alias', () => {
    const used = new Set<string>();
    const first = allocateConnectionToolAlias('notion', 'search', used);
    used.add(first);
    const second = allocateConnectionToolAlias('notion:a31f', 'search', used);
    expect(first).toBe('remote_notion_search');
    expect(second).toBe('remote_notion_a31f_search');
    expect(first).not.toBe(second);
  });

  it('collapsing edge: identical sanitized bases collide via __N suffix', () => {
    const used = new Set<string>();
    const a = allocateConnectionToolAlias('prov', 'a.b', used);
    used.add(a);
    // `a.b` and `a_b` both sanitize to remote_prov_a_b → second must suffix.
    const b = allocateConnectionToolAlias('prov', 'a_b', used);
    expect(b).toBe('remote_prov_a_b__2');
  });
});

describe('projectForProvider (plan 580 D4)', () => {
  it('wraps a typeless root (oneOf) minimally, preserving semantics', () => {
    const canonical = { oneOf: [{ type: 'object', properties: { a: { type: 'string' } } }] };
    const { schema, downgraded } = projectForProvider(canonical);
    expect(downgraded).toBe(false);
    expect(schema).toEqual({
      type: 'object',
      anyOf: [{ oneOf: [{ type: 'object', properties: { a: { type: 'string' } } }] }],
    });
  });

  it('passes through a schema that already declares a root type byte-identically', () => {
    const canonical = { type: 'object', properties: { q: { type: 'string' } }, required: ['q'] };
    const { schema, downgraded, size } = projectForProvider(canonical);
    expect(schema).toBe(canonical); // identity — not a clone
    expect(downgraded).toBe(false);
    expect(size).toBe(JSON.stringify(canonical).length);
  });

  it('downgrades over-budget schemas to an empty object schema', () => {
    const big = { type: 'object', properties: { blob: { type: 'string', description: 'y'.repeat(10_000) } } };
    const { schema, downgraded, size } = projectForProvider(big);
    expect(downgraded).toBe(true);
    expect(schema).toEqual({ type: 'object', properties: {} });
    expect(size).toBeGreaterThan(8192);
  });

  it('handles undefined / malformed canonical safely', () => {
    expect(projectForProvider(undefined).schema).toEqual({ type: 'object', properties: {} });
    expect(projectForProvider([]).schema).toEqual({ type: 'object', properties: {} });
    expect(projectForProvider('nope' as unknown as Record<string, unknown>).downgraded).toBe(false);
  });

  it('downgradedSchemaDescription is deterministic and mentions the budget', () => {
    const d1 = downgradedSchemaDescription('Search pages', 9000);
    const d2 = downgradedSchemaDescription('Search pages', 9000);
    expect(d1).toBe(d2);
    expect(d1).toContain('9000 bytes exceeds 8192-byte budget');
    expect(d1.startsWith('Search pages')).toBe(true);
  });
});

describe('ledger snapshot (plan 580 D3/D10)', () => {
  it('empty snapshot has zero layers and failed status', () => {
    const snap = emptyLedgerSnapshot(123);
    expect(snap.discoveryStatus).toBe('failed');
    expect(snap.layers).toEqual({ discovered: 0, descriptors: 0, aliases: 0, registered: 0, discoverable: 0 });
    expect(snap.inventoryRevision).toBe(0);
    expect(snap.fetchedAt).toBe(123);
  });

  it('serialization is deterministic regardless of key insertion order', () => {
    const a = emptyLedgerSnapshot(1);
    const b: typeof a = {
      fetchedAt: 1,
      discoveryStatus: 'failed',
      pagesFetched: 0,
      discoveredTotal: 0,
      inventoryRevision: 0,
      layers: { discovered: 0, descriptors: 0, aliases: 0, registered: 0, discoverable: 0 },
    };
    expect(serializeInventoryLedgerSnapshot(a)).toBe(serializeInventoryLedgerSnapshot(b));
  });
});
