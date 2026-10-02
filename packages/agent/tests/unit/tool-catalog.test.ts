import { describe, expect, it, vi } from 'vitest';
import type { Tool, ToolUseContext } from '../../src/types.js';
import { invalidateToolCatalogSchemaReads, recordToolCatalogSchemaRead, ToolCatalogTool, type ToolCatalogView } from '../../src/tool/ToolCatalogTool/ToolCatalogTool.js';
import { ToolInvokeTool } from '../../src/tool/ToolInvokeTool/ToolInvokeTool.js';
import { createToolInvokeDispatcherFromRegistry } from '../../src/tool/ToolInvokeTool/dispatcherFromRegistry.js';
import { ToolRegistry, type ToolExecutor } from '../../src/tool/registry.js';

const schema = {
  type: 'object',
  properties: { value: { type: 'string' } },
  required: ['value'],
  additionalProperties: false,
};

function resultPayload(result: string): Record<string, unknown> {
  return JSON.parse(result.slice(result.indexOf('\n') + 1)) as Record<string, unknown>;
}

function makeHarness(inputSchema: Record<string, unknown> = schema, exposure: 'eager' | 'deferred' = 'deferred') {
  const registry = new ToolRegistry();
  const definition: Tool = {
    name: 'probe_tool',
    description: 'Inspect a probe by value.',
    input_schema: inputSchema,
  };
  const executor: ToolExecutor = {
    execute: vi.fn(async (input) => ({
      id: 'result-1',
      name: 'probe_tool',
      result: `executed ${String(input.value)}`,
    })),
  };
  registry.register(definition, executor, {
    exposure,
    discovery: { namespace: 'probes', conciseHint: 'Inspect a probe by value.', tags: ['inspection'] },
  });
  const catalogTool = new ToolCatalogTool();
  const invokeTool = new ToolInvokeTool();
  registry.register(catalogTool.toTool(), catalogTool, { exposure: 'eager' });
  registry.register(invokeTool.toTool(), invokeTool, { exposure: 'eager' });

  const snapshot = registry.snapshot(new Map());
  const eligibleToolIds = new Set(snapshot.catalogEntries.map((entry) => entry.toolId));
  const view: ToolCatalogView = {
    snapshot,
    registry,
    eligibleToolIds,
    directToolIds: new Set(snapshot.catalogEntries.filter((entry) => entry.exposure === 'eager').map((entry) => entry.toolId)),
    loadedSchemaRevisions: new Map(),
    loadedSchemaRounds: new Map(),
    currentRound: 0,
  };
  catalogTool.setView(view);
  const probe = snapshot.catalogEntries.find((entry) => entry.definition.name === 'probe_tool');
  if (!probe) throw new Error('test harness probe tool was not catalogued');
  return { registry, executor, catalogTool, invokeTool, view, toolId: probe.toolId };
}

function wireDispatcher(
  harness: ReturnType<typeof makeHarness>,
  context: ToolUseContext,
  behavior: 'allow' | 'deny' = 'allow',
) {
  const dispatcher = createToolInvokeDispatcherFromRegistry({
    registry: harness.registry,
    getSnapshot: () => harness.view.snapshot,
    getLoadedSchemaRevision: (toolId) => harness.view.loadedSchemaRevisions.get(toolId),
    getLoadedSchemaRound: (toolId) => harness.view.loadedSchemaRounds.get(toolId),
    getCurrentRound: () => harness.view.currentRound,
    isEligibleTool: (toolId) => harness.view.eligibleToolIds.has(toolId),
    checkPermission: async () => ({ behavior, ...(behavior === 'deny' ? { message: 'blocked' } : {}) }),
    contextProvider: () => context,
  });
  harness.invokeTool.setDispatcherForContext(context, dispatcher);
}

function fakeContext(): ToolUseContext {
  return { toolUseId: 'turn-1', options: {} } as unknown as ToolUseContext;
}

describe('tool_catalog', () => {
  it('returns short search matches without schemas and one full schema by stable ID', async () => {
    const harness = makeHarness();
    const search = await harness.catalogTool.execute({ query: 'inspect probe' });
    const searchResult = resultPayload(search.result);
    const matches = searchResult.matches as Array<Record<string, unknown>>;
    expect(matches).toHaveLength(1);
    expect(matches[0]?.tool_id).toBe(harness.toolId);
    expect(matches[0]).not.toHaveProperty('input_schema');

    const detail = await harness.catalogTool.execute({ tool_id: harness.toolId });
    const detailResult = resultPayload(detail.result);
    expect(detailResult).toMatchObject({
      mode: 'detail',
      tool_id: harness.toolId,
      input_schema: schema,
      invocation: { tool: 'tool_invoke' },
    });
    expect(detailResult.schema_revision).toBe(harness.view.snapshot.getCatalogEntry(harness.toolId)?.schemaRevision);
    expect(harness.view.loadedSchemaRevisions.has(harness.toolId)).toBe(false);
    expect(harness.catalogTool.getView()).toBe(harness.view);
    expect(detail.metadata?.toolCatalogSchemaRead).toEqual({
      tool_id: harness.toolId,
      schema_revision: detailResult.schema_revision,
    });

    harness.view.directToolIds = new Set([harness.toolId]);
    const directDetail = resultPayload((await harness.catalogTool.execute({ tool_id: harness.toolId })).result);
    expect(directDetail.invocation).toBe('direct');
  });

  it('returns the full catalog schema when the provider definition is budget-downgraded', async () => {
    const registry = new ToolRegistry();
    const definition: Tool = {
      name: 'large_mcp_tool',
      description: 'Budget-limited provider description.',
      input_schema: { type: 'object', properties: {} },
    };
    registry.registerWithKey('mcp__large__tool', definition, {
      execute: async () => ({ id: 'x', name: definition.name, result: 'ok' }),
    }, 'mcp', {
      exposure: 'deferred',
      catalogDescription: 'Original server description.',
      catalogInputSchema: schema,
      discovery: { namespace: 'large', conciseHint: 'Run the large tool.', tags: [] },
    });
    const catalog = new ToolCatalogTool();
    registry.register(catalog.toTool(), catalog, { exposure: 'eager' });
    const snapshot = registry.snapshot(new Map());
    const entry = snapshot.catalogEntries.find((candidate) => candidate.definition.name === definition.name);
    if (!entry) throw new Error('large MCP tool was not catalogued');
    catalog.setView({
      snapshot,
      registry,
      eligibleToolIds: new Set([entry.toolId]),
      directToolIds: new Set(),
      loadedSchemaRevisions: new Map(),
      loadedSchemaRounds: new Map(),
      currentRound: 0,
    });

    const detail = resultPayload((await catalog.execute({ tool_id: entry.toolId })).result);
    expect(detail.description).toBe('Original server description.');
    expect(detail.input_schema).toEqual(schema);
    expect(definition.input_schema).toEqual({ type: 'object', properties: {} });
  });

  it('matches CUA screenshot and click language and returns results in stable order', async () => {
    const harness = makeHarness();
    const cuA = {
      name: 'computer_cua',
      description: 'Interact with desktop windows and applications.',
      input_schema: schema,
    } satisfies Tool;
    harness.registry.register(cuA, { execute: async () => ({ id: 'cua', name: cuA.name, result: 'ok' }) }, {
      exposure: 'deferred',
      discovery: { namespace: 'computer', conciseHint: 'Capture screens and click desktop controls.', tags: ['computer'] },
    });
    const snapshot = harness.registry.snapshot(new Map());
    const eligibleToolIds = new Set(snapshot.catalogEntries.map((entry) => entry.toolId));
    harness.catalogTool.setView({ snapshot, registry: harness.registry, eligibleToolIds, directToolIds: new Set(), loadedSchemaRevisions: new Map(), loadedSchemaRounds: new Map(), currentRound: 0 });

    const first = resultPayload((await harness.catalogTool.execute({ query: 'take screenshot and click UI' })).result);
    const second = resultPayload((await harness.catalogTool.execute({ query: 'take screenshot and click UI' })).result);
    expect(first.matches).toEqual(second.matches);
    expect((first.matches as Array<Record<string, unknown>>).map((match) => match.name)).toContain('computer_cua');
  });

  it('uses persistent source IDs rather than MCP display names', () => {
    const buildId = (serverName: string) => {
      const registry = new ToolRegistry();
      const tool: Tool = {
        name: `mcp_${serverName}_create_issue`,
        description: 'Create an issue.',
        input_schema: schema,
        mcpInfo: { serverName, toolName: 'create_issue', source: 'settings', connectionId: 'connection-7' },
      };
      registry.registerWithKey(`mcp__${serverName}__create_issue`, tool, {
        execute: async () => ({ id: 'x', name: tool.name, result: 'ok' }),
      }, 'mcp');
      return registry.snapshot(new Map()).catalogEntries[0]?.toolId;
    };
    expect(buildId('issues')).toBe('mcp:connection-7:create_issue');
    expect(buildId('renamed-issues')).toBe('mcp:connection-7:create_issue');
  });

  it('keeps plugin servers distinct while surviving a display rename', () => {
    const buildId = (serverName: string, connectionId: string) => {
      const registry = new ToolRegistry();
      const tool: Tool = {
        name: `mcp_${serverName}_create_issue`,
        description: 'Create an issue.',
        input_schema: schema,
        mcpInfo: { serverName, toolName: 'create_issue', source: 'plugin', pluginId: 'com.example.issues', connectionId },
      };
      registry.registerWithKey(`mcp__plugin__${serverName}__create_issue`, tool, {
        execute: async () => ({ id: 'x', name: tool.name, result: 'ok' }),
      }, 'mcp');
      return registry.snapshot(new Map()).catalogEntries[0]?.toolId;
    };
    expect(buildId('primary', 'connection-a')).toBe('plugin:com.example.issues%3Aconnection-a:create_issue');
    expect(buildId('renamed-primary', 'connection-a')).toBe('plugin:com.example.issues%3Aconnection-a:create_issue');
    expect(buildId('secondary', 'connection-b')).not.toBe(buildId('primary', 'connection-a'));
  });

  it('finds screen capture tools and suggests namespaces when no tool matches', async () => {
    const harness = makeHarness();
    const screenTool: Tool = {
      name: 'computer_cua',
      description: 'Interact with desktop windows and applications.',
      input_schema: schema,
    };
    harness.registry.register(screenTool, { execute: async () => ({ id: 'cua', name: screenTool.name, result: 'ok' }) }, {
      exposure: 'deferred',
      discovery: { namespace: 'computer', conciseHint: 'Capture screens and click desktop controls.', tags: ['computer'] },
    });
    const snapshot = harness.registry.snapshot(new Map());
    harness.catalogTool.setView({ snapshot, registry: harness.registry, eligibleToolIds: new Set(snapshot.catalogEntries.map((entry) => entry.toolId)), directToolIds: new Set(), loadedSchemaRevisions: new Map(), loadedSchemaRounds: new Map(), currentRound: 0 });

    const screenSearch = resultPayload((await harness.catalogTool.execute({ query: 'screenshot' })).result);
    expect((screenSearch.matches as Array<Record<string, unknown>>).map((match) => match.name)).toContain('computer_cua');
    const noMatch = resultPayload((await harness.catalogTool.execute({ query: 'calendar appointment' })).result);
    expect(noMatch.suggested_namespaces).toEqual(['computer', 'probes']);
  });
});

describe('tool_invoke', () => {
  it('keeps per-turn catalog and dispatcher wiring on shallow tool-context copies', async () => {
    const harness = makeHarness();
    const context = fakeContext();
    harness.catalogTool.setContextView(context, harness.view);
    wireDispatcher(harness, context);

    const catalogContext = { ...context, toolUseId: 'catalog-read' };
    const detail = await harness.catalogTool.execute(
      { tool_id: harness.toolId },
      undefined,
      catalogContext,
    );
    expect(detail.error).toBeFalsy();
    expect(recordToolCatalogSchemaRead(harness.view, detail.metadata)).toBe(true);

    harness.view.currentRound += 1;
    const invokeContext = { ...context, toolUseId: 'deferred-invoke' };
    const invoked = await harness.invokeTool.execute(
      { tool_id: harness.toolId, arguments: { value: 'ok' } },
      undefined,
      invokeContext,
    );
    expect(invoked.error).toBeFalsy();
    expect(invoked.result).toContain('executed ok');
    expect(harness.executor.execute).toHaveBeenCalledOnce();
  });

  /**
   * The schema-read requirement was removed in 06e5617a ("converge
   * capability core and lifecycle"): a catalog detail read is now optional
   * and the dispatcher validates against the live schema instead. The old
   * expectations (SCHEMA_NOT_LOADED without a prior read, SCHEMA_STALE
   * after a revision change) described a guard that no longer exists -- the
   * dispatcher's deps still declare getLoadedSchemaRevision /
   * getLoadedSchemaRound / getCurrentRound and DuyaAgent still injects
   * them, but nothing reads them.
   *
   * What still has to hold is that arguments are checked against the live
   * schema before anything executes, and that a schema change between the
   * model's read and the call is still caught. That is now the validator's
   * job rather than a staleness check, so it is asserted that way.
   */
  it('validates arguments against the live schema, with or without a prior detail read', async () => {
    const harness = makeHarness();
    const context = fakeContext();
    wireDispatcher(harness, context);

    // No schema read at all: valid arguments still execute.
    const noRead = await harness.invokeTool.execute({ tool_id: harness.toolId, arguments: { value: 'ok' } }, undefined, context);
    expect(noRead.error).not.toBe(true);
    expect(harness.executor.execute).toHaveBeenCalledOnce();
    harness.executor.execute.mockClear();

    // No schema read, invalid arguments: rejected before any side effect.
    const badNoRead = await harness.invokeTool.execute({ tool_id: harness.toolId, arguments: { value: 1 } }, undefined, context);
    expect(badNoRead.metadata?.errorCode).toBe('INVALID_ARGUMENTS');
    expect(harness.executor.execute).not.toHaveBeenCalled();

    // A detail read is still recorded and can still be invalidated.
    const detail = await harness.catalogTool.execute({ tool_id: harness.toolId });
    expect(recordToolCatalogSchemaRead(harness.view, detail.metadata)).toBe(true);
    invalidateToolCatalogSchemaReads(harness.view);
    expect(harness.view.loadedSchemaRevisions.has(harness.toolId)).toBe(false);
    expect(harness.view.loadedSchemaRounds.has(harness.toolId)).toBe(false);
    expect(recordToolCatalogSchemaRead(harness.view, detail.metadata)).toBe(true);

    harness.view.currentRound += 1;
    const valid = await harness.invokeTool.execute({ tool_id: harness.toolId, arguments: { value: 'ok' } }, undefined, context);
    expect(valid.error).not.toBe(true);
    expect(harness.executor.execute).toHaveBeenCalledOnce();
  });

  it('rejects a schema-changed call, eager targets, and denied calls before side effects', async () => {
    const stale = makeHarness();
    const staleContext = fakeContext();
    wireDispatcher(stale, staleContext);
    const staleDetail = await stale.catalogTool.execute({ tool_id: stale.toolId });
    expect(recordToolCatalogSchemaRead(stale.view, staleDetail.metadata)).toBe(true);
    stale.view.currentRound += 1;
    stale.registry.register({
      name: 'probe_tool',
      description: 'Inspect a probe by value.',
      input_schema: { ...schema, properties: { value: { type: 'number' } } },
    }, stale.executor, { exposure: 'deferred', discovery: { namespace: 'probes', conciseHint: 'Inspect a probe by value.', tags: ['inspection'] } });
    // The tool's schema changed under the model. There is no SCHEMA_STALE
    // code any more; the live validator is what rejects the now-wrong
    // arguments, and it must do so before the executor runs.
    const staleResult = await stale.invokeTool.execute({ tool_id: stale.toolId, arguments: { value: 'old' } }, undefined, staleContext);
    expect(staleResult.metadata?.errorCode).toBe('INVALID_ARGUMENTS');
    expect(stale.executor.execute).not.toHaveBeenCalled();

    const eager = makeHarness(schema, 'eager');
    const eagerContext = fakeContext();
    wireDispatcher(eager, eagerContext);
    const eagerDetail = await eager.catalogTool.execute({ tool_id: eager.toolId });
    expect(recordToolCatalogSchemaRead(eager.view, eagerDetail.metadata)).toBe(true);
    eager.view.currentRound += 1;
    const eagerResult = await eager.invokeTool.execute({ tool_id: eager.toolId, arguments: { value: 'ok' } }, undefined, eagerContext);
    expect(eagerResult.metadata?.errorCode).toBe('TOOL_IS_EAGER');
    expect(eager.executor.execute).not.toHaveBeenCalled();

    const denied = makeHarness();
    const deniedContext = fakeContext();
    wireDispatcher(denied, deniedContext, 'deny');
    const deniedDetail = await denied.catalogTool.execute({ tool_id: denied.toolId });
    expect(recordToolCatalogSchemaRead(denied.view, deniedDetail.metadata)).toBe(true);
    denied.view.currentRound += 1;
    const deniedResult = await denied.invokeTool.execute({ tool_id: denied.toolId, arguments: { value: 'ok' } }, undefined, deniedContext);
    expect(deniedResult.metadata?.errorCode).toBe('TOOL_PERMISSION_DENIED');
    expect(denied.executor.execute).not.toHaveBeenCalled();
  });
});
