/**
 * Plan 583 Phase 2 — `tool_catalog` detail mode attaches the tool's own
 * operating manual (`ToolExecutor.getPrompt()`).
 *
 * Why this test exists: `getPrompt()` was declared in the registry and
 * implemented by six-plus tools, but nothing ever called it. The browser
 * manual is ~20 KB, so that was roughly 20 KB of written operating knowledge
 * that no model could ever read. The detail response is the point where the
 * model has committed to one specific tool, which is where the guide belongs.
 *
 * The contract under test:
 *   - `usage_guide` is present only in `detail` mode, never in list or search
 *     output. That is the on-demand promise the tool description makes.
 *   - A tool without `getPrompt()` simply has no `usage_guide` key.
 *   - Never fatal: a guide that throws, returns a non-string, or is blank is
 *     omitted, and the schema read still succeeds.
 *   - A guide over the cap is truncated with an explicit marker rather than
 *     silently cut, so the model knows it saw a prefix.
 *   - The real BrowserTool's manual actually reaches the response. The other
 *     cases use fakes; without this one, a refactor could keep every unit test
 *     green while the real manual quietly stopped shipping.
 */

import { describe, it, expect } from 'vitest';
import { ToolRegistry } from '../../registry.js';
import { ToolCatalogTool, TOOL_CATALOG_NAME } from '../ToolCatalogTool.js';
import type { ToolCatalogView } from '../ToolCatalogTool.js';
import { BrowserTool } from '../../BrowserTool/BrowserTool.js';
import type { Tool, ToolExecutor, ToolResult } from '../../../types.js';

/** Mirrors the private cap in ToolCatalogTool.ts. */
const MAX_USAGE_GUIDE_CHARS = 12_000;

type Executor = ToolExecutor & { getPrompt?: () => unknown };

function makeTool(
  name: string,
  namespace: string,
  executor?: Partial<Executor>,
): { definition: Tool; executor: Executor; meta: Record<string, unknown> } {
  return {
    definition: {
      name,
      description: `Test tool ${name}`,
      input_schema: { type: 'object', properties: {} },
    } as Tool,
    executor: {
      execute: async (): Promise<ToolResult> => ({ id: 'x', name, result: 'ok' }),
      ...executor,
    } as Executor,
    meta: {
      discovery: { namespace, conciseHint: `hint ${name}`, tags: [] },
      source: { kind: 'connector', id: namespace },
    },
  };
}

function buildCatalog(tools: Array<{ definition: Tool; executor: Executor; meta: Record<string, unknown> }>): {
  catalog: ToolCatalogTool;
  toolIds: Map<string, string>;
} {
  const registry = new ToolRegistry();
  const toolIds = new Map<string, string>();
  for (const t of tools) {
    registry.register(t.definition, t.executor, t.meta as never);
    toolIds.set(t.definition.name, '');
  }
  const catalog = new ToolCatalogTool();
  registry.register(catalog.toTool(), catalog, {
    exposure: 'eager',
    discovery: { namespace: 'system', conciseHint: 'catalog', tags: [] },
    source: { kind: 'builtin', id: 'system' },
  });

  const snapshot = registry.snapshot(new Map());
  for (const entry of snapshot.catalogEntries) {
    if (entry.definition.name !== TOOL_CATALOG_NAME) toolIds.set(entry.definition.name, entry.toolId);
  }
  const view: ToolCatalogView = {
    snapshot,
    registry,
    eligibleToolIds: new Set(snapshot.catalogEntries.map((e) => e.toolId)),
    directToolIds: new Set(),
    loadedSchemaRevisions: new Map(),
    loadedSchemaRounds: new Map(),
    currentRound: 0,
  };
  catalog.setView(view);
  return { catalog, toolIds };
}

function parse(result: ToolResult): Record<string, unknown> {
  const marker = '<!-- duya-tool-catalog-result -->';
  return JSON.parse((result.result as string).replace(`${marker}\n`, '')) as Record<string, unknown>;
}

describe('tool_catalog detail mode — usage_guide (plan 583 phase 2)', () => {
  it("attaches a tool's getPrompt() manual to its detail response", async () => {
    const { catalog, toolIds } = buildCatalog([
      makeTool('guided', 'notion', { getPrompt: () => '## Manual\nDo the thing.' }),
    ]);
    const detail = parse(await catalog.execute({ tool_id: toolIds.get('guided') }));
    expect(detail.mode).toBe('detail');
    expect(detail.usage_guide).toBe('## Manual\nDo the thing.');
  });

  it('omits usage_guide for a tool that has no getPrompt()', async () => {
    const { catalog, toolIds } = buildCatalog([makeTool('plain', 'notion')]);
    const detail = parse(await catalog.execute({ tool_id: toolIds.get('plain') }));
    expect(detail.mode).toBe('detail');
    expect('usage_guide' in detail).toBe(false);
  });

  it.each([
    ['throws', () => { throw new Error('boom'); }],
    ['returns a non-string', () => ({ not: 'a string' })],
    ['returns undefined', () => undefined],
    ['returns only whitespace', () => '   \n\t '],
  ])('never fails the schema read when the guide %s', async (_label, getPrompt) => {
    const { catalog, toolIds } = buildCatalog([makeTool('degenerate', 'notion', { getPrompt })]);
    const detail = parse(await catalog.execute({ tool_id: toolIds.get('degenerate') }));
    expect(detail.mode).toBe('detail');
    expect(detail.input_schema).toBeDefined();
    expect('usage_guide' in detail).toBe(false);
  });

  it('truncates an oversized guide with an explicit marker', async () => {
    const { catalog, toolIds } = buildCatalog([
      makeTool('verbose', 'notion', { getPrompt: () => 'x'.repeat(MAX_USAGE_GUIDE_CHARS + 500) }),
    ]);
    const guide = parse(await catalog.execute({ tool_id: toolIds.get('verbose') })).usage_guide as string;
    expect(guide).toContain(`[usage guide truncated at ${MAX_USAGE_GUIDE_CHARS} characters]`);
    expect(guide.length).toBeLessThan(MAX_USAGE_GUIDE_CHARS + 200);
  });

  it('keeps the guide out of list and search output', async () => {
    const { catalog } = buildCatalog([
      makeTool('guided', 'notion', { getPrompt: () => '## Manual' }),
    ]);
    const list = parse(await catalog.execute({ namespace: 'notion' }));
    const search = parse(await catalog.execute({ query: 'guided' }));
    expect('usage_guide' in list).toBe(false);
    expect(JSON.stringify(search)).not.toContain('usage_guide');
  });

  it("delivers the real browser tool's ~20 KB manual", async () => {
    // The regression this whole phase existed to fix. Every other case here
    // uses a fake executor; only this one proves the shipping tool's manual
    // is actually reachable by a model.
    const browser = new BrowserTool();
    const { catalog, toolIds } = buildCatalog([
      {
        definition: browser.toTool(),
        executor: browser,
        meta: {
          discovery: { namespace: 'browser', conciseHint: 'drive a real browser', tags: ['browser'] },
          source: { kind: 'builtin', id: 'browser' },
        },
      },
    ]);
    const detail = parse(await catalog.execute({ tool_id: toolIds.get('browser') }));
    const guide = detail.usage_guide as string;

    expect(typeof guide).toBe('string');
    // The manual must be substantial — a stub or an empty string would mean
    // the ~20 KB of operating knowledge is unreachable again.
    expect(guide.length).toBeGreaterThan(5_000);
    // Spot-check that it is the real manual, not arbitrary text.
    expect(guide).toContain('Browser Tool');
    expect(guide).toContain('navigate');
    // The full manual is ~20 KB, so it does NOT fit under the cap. Lock the
    // truncated state explicitly rather than leaving it to an `if`: if the cap
    // is ever raised above the manual length, that is a deliberate change and
    // this assertion is what should make a reviewer look at it.
    expect(guide.length).toBeGreaterThan(MAX_USAGE_GUIDE_CHARS);
    expect(guide).toContain(`[usage guide truncated at ${MAX_USAGE_GUIDE_CHARS} characters]`);
  });
});
