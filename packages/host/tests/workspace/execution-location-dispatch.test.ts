/** Real dispatch paths must reject an old context after an approval suspension. */
import { describe, expect, it, vi } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import * as path from 'node:path';
import { WriteTool } from '@duya/capabilities';
import type { ToolUseContext } from '../../src/worker-run-contracts.js';
import { ToolRegistry } from '../../src/worker-tool-registry.js';
import { ToolExecutionPipeline } from '../../src/worker-execution/tool-execution-pipeline.js';
import { createToolInvokeDispatcherFromRegistry } from '../../src/worker-execution/deferred-dispatcher.js';
import { ExecutionLocationFence } from '../../src/workspace/execution-location-fence.js';
import { tempDir } from './fixtures.js';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

function fixture() {
  const source = tempDir('duya-location-source-');
  const target = tempDir('duya-location-target-');
  let cwd = source;
  const fence = new ExecutionLocationFence(() => cwd);
  const move = (next = target) => {
    const transition = fence.beginSwitch(fence.capture().revision);
    transition.commit(() => { cwd = next; });
  };
  const context = (): ToolUseContext => ({
    executionLocation: fence.capture(),
    toolUseId: 'call-1',
    abortController: new AbortController(),
    options: { workingDirectory: cwd, sessionId: 'session' },
    getAppState: () => ({ toolPermissionContext: { mode: 'bypassPermissions' } }),
    setAppState: () => {},
  } as unknown as ToolUseContext);
  const registry = new ToolRegistry();
  const write = new WriteTool();
  registry.register(write.toTool(), write);
  return { source, target, fence, move, context, registry };
}

describe('execution location at production dispatch', () => {
  it('refuses a pipeline write approved after switching, then permits a fresh context', async () => {
    const f = fixture();
    const entered = deferred<void>();
    const approval = deferred<void>();
    const pipeline = new ToolExecutionPipeline(f.registry, async () => {
      entered.resolve();
      await approval.promise;
      return { allowed: true, behavior: 'allow', userApproved: true };
    }, f.context(), { enableRetry: false });
    pipeline.addTool({ id: 'call-1', name: 'write', input: { file_path: 'result.txt', content: 'stale' } });
    const drain = (async () => {
      const updates = [];
      for await (const update of pipeline.getRemainingResults()) updates.push(update);
      return updates;
    })();
    await entered.promise;
    f.move();
    approval.resolve();
    expect(JSON.stringify(await drain)).toContain('stale_execution_context');
    expect(existsSync(path.join(f.source, 'result.txt'))).toBe(false);
    expect(existsSync(path.join(f.target, 'result.txt'))).toBe(false);
    const result = await f.registry.execute('write', { file_path: 'result.txt', content: 'fresh' }, f.target, f.context());
    expect(result?.error).not.toBe(true);
    expect(readFileSync(path.join(f.target, 'result.txt'), 'utf8')).toBe('fresh');
  });

  it.each(['approval', 'beforeExecute'] as const)('refuses deferred execution after switching during %s', async (phase) => {
    const f = fixture();
    const ctx = f.context();
    const write = new WriteTool();
    f.registry.register(write.toTool(), write, { exposure: 'deferred' });
    const snapshot = f.registry.snapshot(new Map());
    const entry = snapshot.catalogEntries.find((item) => item.definition.name === 'write')!;
    const dispatcher = createToolInvokeDispatcherFromRegistry({
      registry: f.registry, getSnapshot: () => snapshot, workingDirectory: f.source,
      contextProvider: () => ctx,
      checkPermission: async () => {
        if (phase === 'approval') f.move();
        return { behavior: 'allow' };
      },
      beforeExecute: async () => {
        if (phase === 'beforeExecute') f.move();
        return undefined;
      },
    });
    const result = await dispatcher.dispatch({ tool_id: entry.toolId, arguments: { file_path: 'deferred.txt', content: 'stale' } });
    expect(result.errorCode).toBe('stale_execution_context');
    expect(existsSync(path.join(f.source, 'deferred.txt'))).toBe(false);
    expect(existsSync(path.join(f.target, 'deferred.txt'))).toBe(false);
  });

  it.each(['registry', 'deferred'] as const)('holds the switch barrier while a %s executor runs and releases it after failure', async (route) => {
    const f = fixture();
    const started = deferred<void>();
    const finish = deferred<void>();
    const execute = vi.fn(async () => {
      started.resolve();
      await finish.promise;
      throw new Error('executor failed');
    });
    const tool = { name: 'probe', description: 'probe', input_schema: { type: 'object' as const, properties: {} } };
    f.registry.register(tool, { execute }, { exposure: route === 'deferred' ? 'deferred' : 'eager' });
    const ctx = f.context();
    const snapshot = f.registry.snapshot(new Map());
    const entry = snapshot.catalogEntries.find((item) => item.definition.name === 'probe')!;
    const pending = route === 'registry'
      ? f.registry.execute('probe', {}, f.source, ctx)
      : createToolInvokeDispatcherFromRegistry({
        registry: f.registry, getSnapshot: () => snapshot, workingDirectory: f.source,
        contextProvider: () => ctx, checkPermission: async () => ({ behavior: 'allow' }),
      }).dispatch({ tool_id: entry.toolId, arguments: {} });
    await started.promise;
    expect(() => f.move()).toThrow(expect.objectContaining({ code: 'execution_context_busy' }));
    finish.resolve();
    expect((await pending)?.error).toBe(true);
    expect(() => f.move()).not.toThrow();
    expect(execute).toHaveBeenCalledTimes(1);
  });
});
