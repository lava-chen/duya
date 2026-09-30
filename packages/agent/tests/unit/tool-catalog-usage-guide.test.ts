import { describe, it, expect, vi } from 'vitest';
import { ToolCatalogTool, TOOL_CATALOG_RESULT_MARKER, type ToolCatalogView } from '../../src/tool/ToolCatalogTool/ToolCatalogTool.js';
import type { ToolCatalogEntry } from '../../src/tool/catalog-types.js';
import type { ToolSnapshot } from '../../src/tool/snapshot.js';

/**
 * Plan 583 Phase 2 — `ToolExecutor.getPrompt?()` had no consumer anywhere in
 * the agent, so every tool operating manual (browser ~20 KB, SkillTool,
 * BriefTool, plan-mode, image_generate) was unreachable by the model. The
 * detail response is where a manual belongs: the model has already committed
 * to that one tool by asking for its schema.
 */

interface EntryOverrides {
  getPrompt?: () => string;
  namespace?: string;
  toolId?: string;
}

function makeEntry(overrides: EntryOverrides = {}): ToolCatalogEntry {
  const executor = {
    execute: vi.fn().mockResolvedValue({ id: 'x', name: 'demo', result: 'ok' }),
    ...(overrides.getPrompt ? { getPrompt: overrides.getPrompt } : {}),
  };
  return {
    toolId: overrides.toolId ?? 'builtin:demo',
    internalName: 'demo',
    definition: { name: 'demo', description: 'A demo tool.', input_schema: { type: 'object' } },
    executor: executor as ToolCatalogEntry['executor'],
    exposure: 'deferred',
    discovery: { namespace: overrides.namespace ?? 'demo', conciseHint: 'demo tool', tags: [] },
    source: { kind: 'builtin', id: 'demo' },
    description: 'A demo tool.',
    schemaRevision: 'rev1',
    inputSchema: { type: 'object' },
  } as unknown as ToolCatalogEntry;
}

function makeView(entries: ToolCatalogEntry[]): ToolCatalogView {
  const byId = new Map(entries.map((e) => [e.toolId, e]));
  return {
    snapshot: {
      catalogEntries: entries,
      getCatalogEntry: (id: string) => byId.get(id),
    } as unknown as ToolSnapshot,
    registry: { getCatalogRevision: () => 1 } as never,
    eligibleToolIds: new Set(entries.map((e) => e.toolId)),
    directToolIds: new Set<string>(),
    loadedSchemaRevisions: new Map(),
    loadedSchemaRounds: new Map(),
    currentRound: 1,
  } as unknown as ToolCatalogView;
}

async function readDetail(entry: ToolCatalogEntry): Promise<Record<string, unknown>> {
  const tool = new ToolCatalogTool();
  tool.setView(makeView([entry]));
  const result = await tool.execute({ tool_id: entry.toolId });
  expect(result.error).toBeFalsy();
  const json = result.result.slice(TOOL_CATALOG_RESULT_MARKER.length);
  return JSON.parse(json) as Record<string, unknown>;
}

describe('tool_catalog detail: usage_guide', () => {
  it('attaches the tool usage guide to a detail response', async () => {
    const detail = await readDetail(makeEntry({ getPrompt: () => '## demo usage guide\nCall it like this.' }));
    expect(detail.usage_guide).toBe('## demo usage guide\nCall it like this.');
  });

  it('omits usage_guide when the tool does not implement getPrompt', async () => {
    const detail = await readDetail(makeEntry());
    expect('usage_guide' in detail).toBe(false);
  });

  it('omits usage_guide when getPrompt returns a non-string', async () => {
    const detail = await readDetail(makeEntry({ getPrompt: () => undefined as unknown as string }));
    expect('usage_guide' in detail).toBe(false);
  });

  it('omits usage_guide when getPrompt returns only whitespace', async () => {
    const detail = await readDetail(makeEntry({ getPrompt: () => '   \n  ' }));
    expect('usage_guide' in detail).toBe(false);
  });

  it('never lets a throwing getPrompt fail the schema read', async () => {
    const detail = await readDetail(
      makeEntry({
        getPrompt: () => {
          throw new Error('guide exploded');
        },
      }),
    );
    // The schema is still fully readable — a missing manual is not an error.
    expect(detail.mode).toBe('detail');
    expect(detail.input_schema).toEqual({ type: 'object' });
    expect('usage_guide' in detail).toBe(false);
  });

  it('truncates an oversized guide with an explicit marker', async () => {
    const huge = 'x'.repeat(20_000);
    const detail = await readDetail(makeEntry({ getPrompt: () => huge }));
    const guide = detail.usage_guide as string;
    expect(guide.length).toBeLessThan(huge.length);
    expect(guide).toContain('usage guide truncated at 12000 characters');
  });

  it('does not attach a guide to search results', async () => {
    const entry = makeEntry({ getPrompt: () => 'guide' });
    const tool = new ToolCatalogTool();
    tool.setView(makeView([entry]));
    const result = await tool.execute({ query: 'demo' });
    const json = result.result.slice(TOOL_CATALOG_RESULT_MARKER.length);
    const parsed = JSON.parse(json) as { mode: string; matches: Record<string, unknown>[] };
    expect(parsed.mode).toBe('search');
    // The guide is a detail-only payload: search stays cheap.
    expect('usage_guide' in parsed.matches[0]).toBe(false);
  });
});
