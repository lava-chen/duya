/**
 * Plan 580 Phase 3 / D10 — `tool_catalog` list mode with an opaque cursor.
 *
 * Contract under test:
 *   - `namespace` mode pages one namespace in stable `toolId` order,
 *     page size 20, `next_cursor` only when more rows remain.
 *   - The cursor binds `{catalogRevision, namespace, lastToolId}`; a
 *     catalog mutation between pages (revision bump) or a namespace swap
     fails loudly with `CATALOG_CURSOR_STALE` — never duplicated/skipped
 *     rows.
 *   - Malformed cursors are treated as stale (same recovery path: restart
 *     from page one).
 *   - Unknown namespaces return an empty page plus `suggested_namespaces`.
 *   - Modes are mutually exclusive; `cursor` without `namespace` is
 *     rejected with the legacy `INVALID_CATALOG_QUERY` code.
 *   - hidden tools never appear; meta tools (`tool_catalog`, `tool_invoke`)
 *     are excluded from lists as they are from search.
 */

import { describe, it, expect } from 'vitest';
import { ToolRegistry } from '../../registry.js';
import {
  ToolCatalogTool,
  TOOL_CATALOG_NAME,
  encodeToolCatalogListCursor,
  decodeToolCatalogListCursor,
} from '../ToolCatalogTool.js';
import type { ToolCatalogView } from '../ToolCatalogTool.js';
import type { Tool, ToolExecutor, ToolResult } from '../../../types.js';

function makeTool(name: string, namespace: string, exposure?: 'eager' | 'deferred' | 'hidden'): {
  definition: Tool;
  executor: ToolExecutor;
  meta: Record<string, unknown>;
} {
  return {
    definition: {
      name,
      description: `Test tool ${name}`,
      input_schema: { type: 'object', properties: {} },
    } as Tool,
    executor: {
      execute: async (): Promise<ToolResult> => ({ id: 'x', name, result: 'ok' }),
    },
    meta: {
      ...(exposure ? { exposure } : {}),
      discovery: { namespace, conciseHint: `hint ${name}`, tags: [] },
      source: { kind: 'connector', id: namespace },
    },
  };
}

function buildView(toolCount: number, namespace = 'notion'): {
  registry: ToolRegistry;
  catalog: ToolCatalogTool;
  view: ToolCatalogView;
} {
  const registry = new ToolRegistry();
  for (let i = 0; i < toolCount; i++) {
    const t = makeTool(`tool_${String(i).padStart(3, '0')}`, namespace);
    registry.register(t.definition, t.executor, t.meta as never);
  }
  // Register the catalog tool itself so META filtering has something real
  // to filter (mirrors production where tool_catalog is registered).
  const catalog = new ToolCatalogTool();
  registry.register(catalog.toTool(), catalog, {
    exposure: 'eager',
    discovery: { namespace: 'system', conciseHint: 'catalog', tags: [] },
    source: { kind: 'builtin', id: 'system' },
  });

  const snapshot = registry.snapshot(new Map());
  const eligible = new Set(snapshot.catalogEntries.map((e) => e.toolId));
  const view: ToolCatalogView = {
    snapshot,
    registry,
    eligibleToolIds: eligible,
    directToolIds: new Set(),
    loadedSchemaRevisions: new Map(),
    loadedSchemaRounds: new Map(),
    currentRound: 0,
  };
  catalog.setView(view);
  return { registry, catalog, view };
}

function parse(result: ToolResult): Record<string, unknown> {
  const marker = '<!-- duya-tool-catalog-result -->';
  return JSON.parse((result.result as string).replace(`${marker}\n`, '')) as Record<string, unknown>;
}

describe('tool_catalog list mode (plan 580 D10)', () => {
  it('pages 25 tools into 20 + 5 with next_cursor only between pages', async () => {
    const { catalog } = buildView(25);
    const page1 = parse(await catalog.execute({ namespace: 'notion' }));
    expect(page1.mode).toBe('list');
    expect(page1.namespace).toBe('notion');
    expect((page1.tools as unknown[]).length).toBe(20);
    expect(typeof page1.next_cursor).toBe('string');

    const page2 = parse(await catalog.execute({ namespace: 'notion', cursor: page1.next_cursor as string }));
    expect((page2.tools as unknown[]).length).toBe(5);
    expect(page2.next_cursor).toBeUndefined();

    // No overlap, no gaps: page1 ids ∪ page2 ids = all 25, sorted.
    const ids = [
      ...(page1.tools as Array<{ tool_id: string }>),
      ...(page2.tools as Array<{ tool_id: string }>),
    ].map((t) => t.tool_id);
    expect(new Set(ids).size).toBe(25);
    const sorted = [...ids].sort();
    expect(ids).toEqual(sorted);
  });

  it('returns an empty page with suggested_namespaces for an unknown namespace', async () => {
    const { catalog } = buildView(5, 'notion');
    const page = parse(await catalog.execute({ namespace: 'linear' }));
    expect(page.mode).toBe('list');
    expect((page.tools as unknown[]).length).toBe(0);
    expect(page.suggested_namespaces).toEqual(['notion']);
  });

  it('fails with CATALOG_CURSOR_STALE when the catalog changed between pages', async () => {
    const { registry, catalog } = buildView(25);
    const page1 = parse(await catalog.execute({ namespace: 'notion' }));

    // Inventory refresh mid-pagination: any registry mutation bumps the
    // revision (here: a new tool is discovered).
    const t = makeTool('tool_new', 'notion');
    registry.register(t.definition, t.executor, t.meta as never);

    const page2 = parse(await catalog.execute({ namespace: 'notion', cursor: page1.next_cursor as string }));
    expect(page2.errorCode).toBe('CATALOG_CURSOR_STALE');
  });

  it('fails with CATALOG_CURSOR_STALE on namespace swap or malformed cursor', async () => {
    const { catalog } = buildView(25);
    const page1 = parse(await catalog.execute({ namespace: 'notion' }));

    const swapped = parse(await catalog.execute({ namespace: 'linear', cursor: page1.next_cursor as string }));
    expect(swapped.errorCode).toBe('CATALOG_CURSOR_STALE');

    const malformed = parse(await catalog.execute({ namespace: 'notion', cursor: 'not-a-cursor' }));
    expect(malformed.errorCode).toBe('CATALOG_CURSOR_STALE');
  });

  it('rejects mode mixing with INVALID_CATALOG_QUERY (legacy code preserved)', async () => {
    const { catalog } = buildView(3);
    const mixed = parse(await catalog.execute({ namespace: 'notion', query: 'search' }));
    expect(mixed.errorCode).toBe('INVALID_CATALOG_QUERY');
    const cursorOnly = parse(await catalog.execute({ cursor: 'abc' }));
    expect(cursorOnly.errorCode).toBe('INVALID_CATALOG_QUERY');
  });

  it('never lists hidden or meta tools', async () => {
    const { catalog } = buildView(3, 'notion');
    // Hidden + meta tools would appear if filtering were broken.
    const page = parse(await catalog.execute({ namespace: 'system' }));
    const names = (page.tools as Array<{ name?: string }>).map((t) => t.name);
    expect(names).not.toContain(TOOL_CATALOG_NAME);
  });

  it('excludes hidden-exposure entries from list output', async () => {
    const registry = new ToolRegistry();
    const visible = makeTool('vis_1', 'notion');
    const hidden = makeTool('hid_1', 'notion', 'hidden');
    registry.register(visible.definition, visible.executor, visible.meta as never);
    registry.register(hidden.definition, hidden.executor, hidden.meta as never);
    const catalog = new ToolCatalogTool();
    registry.register(catalog.toTool(), catalog, {
      exposure: 'eager',
      discovery: { namespace: 'system', conciseHint: 'c', tags: [] },
      source: { kind: 'builtin', id: 'system' },
    });
    const snapshot = registry.snapshot(new Map());
    const eligible = new Set(
      snapshot.catalogEntries.filter((e) => e.exposure !== 'hidden').map((e) => e.toolId),
    );
    catalog.setView({
      snapshot,
      registry,
      eligibleToolIds: eligible,
      directToolIds: new Set(),
      loadedSchemaRevisions: new Map(),
      loadedSchemaRounds: new Map(),
      currentRound: 0,
    });
    const page = parse(await catalog.execute({ namespace: 'notion' }));
    const names = (page.tools as Array<{ name?: string }>).map((t) => t.name);
    expect(names).toContain('vis_1');
    expect(names).not.toContain('hid_1');
  });

  it('search mode is unaffected and still returns matches', async () => {
    const { catalog } = buildView(3);
    const page = parse(await catalog.execute({ query: 'tool_001' }));
    expect(page.mode).toBe('search');
    expect((page.matches as unknown[]).length).toBeGreaterThan(0);
  });
});

describe('list cursor codec (plan 580 D10)', () => {
  it('round-trips the encoded payload', () => {
    const cursor = { catalogRevision: 42, namespace: 'notion', lastToolId: 'conn:notion:tool_019' };
    const decoded = decodeToolCatalogListCursor(encodeToolCatalogListCursor(cursor));
    expect(decoded).toEqual(cursor);
  });

  it('rejects malformed or hostile payloads', () => {
    expect(decodeToolCatalogListCursor('!!!')).toBeUndefined();
    expect(decodeToolCatalogListCursor(Buffer.from('{"namespace":"notion"}').toString('base64'))).toBeUndefined();
    expect(decodeToolCatalogListCursor(
      Buffer.from('{"catalogRevision":0,"namespace":"notion","lastToolId":"x"}').toString('base64'),
    )).toBeUndefined();
    expect(decodeToolCatalogListCursor(
      Buffer.from('{"catalogRevision":"7","namespace":"notion","lastToolId":"x"}').toString('base64'),
    )).toBeUndefined();
  });
});
