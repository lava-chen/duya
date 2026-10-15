import { describe, expect, it, vi } from 'vitest';
import { PermissionRequiredError } from '@duya/capabilities/BaseTool';
import path from 'node:path';
import { ToolRegistry, type RuntimeToolDefinition, type RuntimeToolResult, type ToolExecutor } from '../../../src/tools/catalog/index.js';

const tool = (name: string): RuntimeToolDefinition => ({
  name,
  description: `${name} description`,
  input_schema: { type: 'object', properties: { value: { type: 'string' } } },
});

const result = (name: string, extra: Partial<RuntimeToolResult> = {}): RuntimeToolResult => ({
  id: `result-${name}`,
  name,
  result: 'ok',
  ...extra,
});

describe('Runtime tool catalog snapshots and identity', () => {
  it('pins tools, executors, rows, exposure, and revision in a per-turn snapshot', () => {
    const registry = new ToolRegistry();
    const firstTool = tool('first');
    const firstExecutor: ToolExecutor = { execute: async () => result('first') };
    registry.register(firstTool, firstExecutor, {
      exposure: 'hidden',
      catalogDescription: 'Full catalog description.',
      catalogInputSchema: { type: 'object', properties: { full: { type: 'boolean' } } },
      discovery: { namespace: 'private', conciseHint: 'Hidden but resolvable.', tags: ['internal'] },
    });
    const aliasMap = new Map([['provider_first', 'first']]);
    const snapshot = registry.snapshot(aliasMap);
    const row = snapshot.getCatalogEntry('builtin:first:first');

    expect(Object.isFrozen(snapshot.tools)).toBe(true);
    expect(snapshot.tools).toEqual([firstTool]);
    expect(snapshot.providerNameToInternalKey).toBe(aliasMap);
    expect(snapshot.catalogRevision).toBe(registry.getCatalogRevision());
    expect(snapshot.catalogEntries).toEqual([]);
    expect(snapshot.getCatalogEntry('builtin:first:first')).toMatchObject({
      internalName: 'first',
      definition: firstTool,
      executor: firstExecutor,
      exposure: 'hidden',
      description: 'Full catalog description.',
      inputSchema: { properties: { full: { type: 'boolean' } }, type: 'object' },
    });
    expect(snapshot.getExposure('first')).toBe('hidden');
    expect(snapshot.getExecutor('first')).toBe(firstExecutor);
    expect(row?.schemaRevision).toMatch(/^sha256:[a-f0-9]{64}$/);

    registry.unregister('first');
    expect(snapshot.tools).toEqual([firstTool]);
    expect(snapshot.getCatalogEntry('builtin:first:first')?.executor).toBe(firstExecutor);
    expect(registry.snapshot(new Map()).tools).toEqual([]);
  });

  it('keeps stable schema and source IDs independent of object key order', () => {
    const first = new ToolRegistry();
    const second = new ToolRegistry();
    const source = { kind: 'mcp' as const, id: 'connection-7' };
    first.register(tool('query'), { execute: async () => result('query') }, {
      source,
      catalogInputSchema: { type: 'object', properties: { q: { type: 'string' }, n: { type: 'number' } } },
    });
    second.register(tool('query'), { execute: async () => result('query') }, {
      source: { id: 'connection-7', kind: 'mcp' },
      catalogInputSchema: { properties: { n: { type: 'number' }, q: { type: 'string' } }, type: 'object' },
    });

    const left = first.snapshot(new Map()).catalogEntries[0];
    const right = second.snapshot(new Map()).catalogEntries[0];
    expect(left?.toolId).toBe('mcp:connection-7:query');
    expect(left?.toolId).toBe(right?.toolId);
    expect(left?.schemaRevision).toBe(right?.schemaRevision);
  });

  it('captures the new catalog revision only after replace-set commits', () => {
    const registry = new ToolRegistry();
    registry.register(tool('builtin'), { execute: async () => result('builtin') });
    const before = registry.snapshot(new Map());
    const added = tool('provider_query');
    const executor: ToolExecutor = { execute: async () => result('provider_query') };

    const outcome = registry.replaceByOwner('mcp', [
      { key: 'mcp__server__query', definition: added, executor, meta: { exposure: 'deferred' } },
    ]);
    const after = registry.snapshot(new Map());

    expect(outcome).toEqual({ removedKeys: [], addedKeys: ['mcp__server__query'], keptKeys: [] });
    expect(after.catalogRevision).toBe(before.catalogRevision + 1);
    expect(before.catalogEntries).toHaveLength(1);
    expect(after.catalogEntries.map((entry) => entry.definition.name)).toEqual(['builtin', 'provider_query']);
    expect(after.getExposure('provider_query')).toBe('deferred');
  });
});

describe('Runtime tool catalog execution boundary', () => {
  it('forwards input, working directory, and opaque run context to the executor', async () => {
    const registry = new ToolRegistry();
    const context = { requestPermission: vi.fn() };
    const execute = vi.fn(async () => result('echo'));
    registry.register(tool('echo'), { execute });

    await expect(registry.execute('echo', { value: 'x' }, 'C:/workspace', context)).resolves.toMatchObject({ name: 'echo' });
    expect(execute).toHaveBeenCalledWith({ value: 'x' }, 'C:/workspace', context);
  });

  it('preserves permission-required errors and translates ordinary executor failures into results', async () => {
    const permissionError = new PermissionRequiredError({
      id: 'approval-1',
      toolName: 'guarded',
      toolInput: { value: 'x' },
      mode: 'generic',
      expiresAt: Date.now() + 60_000,
    });
    const registry = new ToolRegistry();
    registry.register(tool('guarded'), { execute: async () => { throw permissionError; } });
    registry.register(tool('broken'), { execute: async () => { throw new Error('offline'); } });

    await expect(registry.execute('guarded', {})).rejects.toBe(permissionError);
    await expect(registry.execute('broken', {})).resolves.toEqual({
      id: '', name: 'broken', result: 'offline', error: true,
    });
    await expect(registry.execute('missing', {})).resolves.toBeNull();
  });

  it('uses injected path-gated skill effects without owning Host or Agent imports', async () => {
    const workingDirectory = path.resolve('catalog-workspace');
    const existingPendingContext = Promise.resolve('executor supplied context');
    const activate = vi.fn(() => ['docker-deploy']);
    const registry = new ToolRegistry({
      conditionalSkillEffects: {
        getPendingCount: () => 1,
        activate,
      },
    });
    registry.register(tool('read'), { execute: async () => result('read', { pendingContext: existingPendingContext }) });

    const callResult = await registry.execute('read', {
      file_path: './Dockerfile',
      path: 'Dockerfile',
      notebook_path: 'notes.ipynb',
      command: 'ignored',
    }, workingDirectory, {});

    expect(activate).toHaveBeenCalledWith([
      path.resolve(workingDirectory, 'Dockerfile'),
      path.resolve(workingDirectory, 'notes.ipynb'),
    ], workingDirectory);
    expect(callResult?.pendingContext).toBe(existingPendingContext);
  });

  it('does not activate on failed results and attaches context after a successful activation', async () => {
    const activate = vi.fn(() => ['docker-deploy']);
    const registry = new ToolRegistry({ conditionalSkillEffects: { getPendingCount: () => 1, activate } });
    registry.register(tool('read'), { execute: async () => result('read') });
    registry.register(tool('failed'), { execute: async () => result('failed', { error: true }) });

    await registry.execute('failed', { file_path: 'Dockerfile' }, 'C:/work', {});
    expect(activate).not.toHaveBeenCalled();
    const activated = await registry.execute('read', { file_path: 'Dockerfile' }, 'C:/work', {});
    expect(activated?.pendingContext).toBeInstanceOf(Promise);
    expect(await activated?.pendingContext).toContain('docker-deploy');
  });
});
