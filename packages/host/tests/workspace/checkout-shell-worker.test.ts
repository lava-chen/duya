/** Cross the real pipeline → WorkerPool → bundled BashWorker process boundary. */
import { afterAll, describe, expect, it, vi } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as workerPool from '../../src/worker-tool-pool.js';
import { BashTool } from '../../src/worker-tool-bindings/bash-tool.js';
import { ToolRegistry } from '../../src/worker-tool-registry.js';
import { ToolExecutionPipeline } from '../../src/worker-execution/tool-execution-pipeline.js';
import type { ToolUseContext } from '../../src/worker-run-contracts.js';
import { createCheckoutProvider } from '../../src/workspace/checkout-provider.js';
import { makeRepo, useIsolatedDataRoot } from './fixtures.js';

let pool: workerPool.WorkerPool | undefined;
let restoreDataRoot: (() => void) | undefined;
afterAll(() => {
  pool?.shutdown();
  vi.restoreAllMocks();
  restoreDataRoot?.();
});

describe('checkout ownership across the shell worker process', () => {
  it.skipIf(process.platform === 'win32')('executes only the owning session in the real bundled worker', async () => {
    restoreDataRoot = useIsolatedDataRoot();
    const script = fileURLToPath(new URL('../../bundle/BashTool/BashWorker.js', import.meta.url));
    expect(existsSync(script), 'run npm run bundle:worker before the worker integration suite').toBe(true);
    pool = new workerPool.WorkerPool({ workerScriptPath: script, maxWorkers: 1 });
    // Select the build from THIS checkout; execution and IPC remain real.
    vi.spyOn(workerPool, 'getWorkerPool').mockReturnValue(pool);
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
});
