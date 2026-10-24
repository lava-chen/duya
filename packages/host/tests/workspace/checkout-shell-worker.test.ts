/** Cross the real pipeline → WorkerPool → bundled BashWorker process boundary. */
import { afterAll, describe, expect, it, vi } from 'vitest';
import { existsSync, readFileSync, watch, writeFileSync } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as workerPool from '../../src/worker-tool-pool.js';
import { BashTool } from '../../src/worker-tool-bindings/bash-tool.js';
import { ToolRegistry } from '../../src/worker-tool-registry.js';
import { ToolExecutionPipeline } from '../../src/worker-execution/tool-execution-pipeline.js';
import { createAgentToolExecutionPorts } from '../../src/worker-execution/streaming-tool-executor.js';
import type { ToolUseContext } from '../../src/worker-run-contracts.js';
import { createCheckoutProvider } from '../../src/workspace/checkout-provider.js';
import { ExecutionLocationFence } from '../../src/workspace/execution-location-fence.js';
import { makeRepo, useIsolatedDataRoot } from './fixtures.js';

let pool: workerPool.WorkerPool | undefined;
let restoreDataRoot: (() => void) | undefined;
function realPool(): workerPool.WorkerPool {
  if (pool) return pool;
  restoreDataRoot = useIsolatedDataRoot();
  const script = workerPool.resolveBashWorkerPath(fileURLToPath(new URL('../../bundle/', import.meta.url)));
  expect(existsSync(script), 'run npm run bundle:worker before the worker integration suite').toBe(true);
  pool = new workerPool.WorkerPool({ workerScriptPath: script, maxWorkers: 1 });
  vi.spyOn(workerPool, 'getWorkerPool').mockReturnValue(pool);
  return pool;
}
afterAll(() => {
  pool?.shutdown();
  vi.restoreAllMocks();
  restoreDataRoot?.();
});

describe('checkout ownership across the shell worker process', () => {
  it.skipIf(process.platform === 'win32')('executes only the owning session in the real bundled worker', async () => {
    // Select the build from THIS checkout; execution and IPC remain real.
    realPool();
    const repo = makeRepo();
    const checkout = await createCheckoutProvider().create({ sourceCwd: repo, ownerSessionId: 'owner', label: 'real worker' });
    const registry = new ToolRegistry();
    const bash = new BashTool();
    registry.register(bash.toTool(), bash);

    for (const sessionId of ['owner', 'other-session']) {
      const filename = `${sessionId}.txt`;
      const context = {
        abortController: new AbortController(),
        options: { sessionId, workingDirectory: checkout.cwd },
        getAppState: () => ({ toolPermissionContext: { mode: 'bypassPermissions' }, _approvedToolUses: { 'shell-1': true } }),
        setAppState: () => {},
      } as unknown as ToolUseContext;
      const pipeline = new ToolExecutionPipeline(registry, async () => ({ allowed: true, behavior: 'allow' }), context, { workerTools: ['bash'], enableRetry: false });
      pipeline.addTool({ id: 'shell-1', name: 'bash', input: { command: `printf real-worker > ${filename}` } });
      const updates = [];
      for await (const update of pipeline.getRemainingResults()) updates.push(update);
      if (sessionId === 'owner') {
        expect(JSON.stringify(updates)).not.toContain('checkout_write_denied');
        expect(readFileSync(path.join(checkout.root, filename), 'utf8')).toBe('real-worker');
      } else {
        expect(JSON.stringify(updates)).toContain('checkout_write_denied');
        expect(existsSync(path.join(checkout.root, filename))).toBe(false);
      }
    }
  }, 30_000);

  it.skipIf(process.platform === 'win32')('rejects an old shell context and executes a new one only in the new directory', async () => {
    realPool();
    const source = makeRepo();
    const target = makeRepo();
    let cwd = source;
    const fence = new ExecutionLocationFence(() => cwd);
    const context = (): ToolUseContext => ({
      executionLocation: fence.capture(),
      abortController: new AbortController(),
      options: { sessionId: 'session', workingDirectory: cwd },
      getAppState: () => ({ toolPermissionContext: { mode: 'bypassPermissions' }, _approvedToolUses: { 'shell-location': true } }),
      setAppState: () => {},
    } as unknown as ToolUseContext);
    const old = context();
    const transition = fence.beginSwitch(old.executionLocation!.revision);
    transition.commit(() => { cwd = target; });
    const registry = new ToolRegistry();
    const bash = new BashTool();
    registry.register(bash.toTool(), bash);
    for (const ctx of [old, context()]) {
      const pipeline = new ToolExecutionPipeline(registry, async () => ({ allowed: true, behavior: 'allow' }), ctx, { workerTools: ['bash'], enableRetry: false });
      pipeline.addTool({ id: 'shell-location', name: 'bash', input: { command: 'printf fresh > location.txt' } });
      const updates = [];
      for await (const update of pipeline.getRemainingResults()) updates.push(update);
      if (ctx === old) expect(JSON.stringify(updates)).toContain('stale_execution_context');
      else expect(JSON.stringify(updates)).not.toContain('stale_execution_context');
      expect(existsSync(path.join(source, 'location.txt'))).toBe(false);
      if (ctx === old) expect(existsSync(path.join(target, 'location.txt'))).toBe(false);
    }
    expect(readFileSync(path.join(target, 'location.txt'), 'utf8')).toBe('fresh');
  }, 30_000);

  it.skipIf(process.platform === 'win32')('holds admission until the real shell worker settles', async () => {
    realPool();
    const source = makeRepo();
    const fence = new ExecutionLocationFence(() => source);
    const ctx = {
      executionLocation: fence.capture(),
      abortController: new AbortController(),
      options: { sessionId: 'session', workingDirectory: source },
      getAppState: () => ({}), setAppState: () => {},
    } as unknown as ToolUseContext;
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => { markStarted = resolve; });
    const watcher = watch(source, () => { if (existsSync(path.join(source, 'ready.flag'))) markStarted(); });
    const worker = createAgentToolExecutionPorts(ctx, { workerTools: ['bash'] }).worker!;
    const pending = worker.executeTask({
      id: 'held-shell', toolName: 'bash', workingDirectory: source, sessionId: 'session',
      abortController: ctx.abortController, timeoutMs: 10_000,
      input: { command: 'printf worker-started > ready.flag; while [ ! -f release.flag ]; do sleep 0.01; done; printf worker-finished', timeout: 10_000 },
    });
    try {
      await Promise.race([started, pending.then((result) => { throw new Error(`Worker settled before the file handshake: ${JSON.stringify(result)}`); })]);
      expect(() => fence.beginSwitch(0)).toThrow(expect.objectContaining({ code: 'execution_context_busy' }));
    } finally {
      watcher.close();
      writeFileSync(path.join(source, 'release.flag'), 'release');
    }
    expect((await pending).success).toBe(true);
    expect(() => fence.beginSwitch(0).cancel()).not.toThrow();
  }, 30_000);
});
