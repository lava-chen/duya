/** Exercise the session's real context construction, not just the fence helper. */
import { describe, expect, it } from 'vitest';
import type { ResolvedTurnTools } from '../../src/worker-run-session-port.js';
import type { ToolUseContext } from '../../src/worker-run-contracts.js';
import { WorkerSession } from '../../src/worker-session-runtime.js';
import { ToolRegistry } from '../../src/worker-tool-registry.js';
import { tempDir } from './fixtures.js';

describe('WorkerSession execution location binding', () => {
  it('binds contexts per session, invalidates them on idle relocation, and refuses relocation during a run', async () => {
    const source = tempDir('duya-session-source-');
    const target = tempDir('duya-session-target-');
    const registry = new ToolRegistry();
    const makeSession = () => new WorkerSession({
      apiKey: 'test', provider: 'anthropic', model: 'claude-sonnet-4-5',
      workingDirectory: source, enableRetry: false,
    }, { createRegistry: () => registry });
    const session = makeSession();
    const other = makeSession();
    const resolved = {
      registry, catalogTool: { setContextView() {} }, toolInvokeExecutor: { setDispatcherForContext() {} },
      agentDefinitions: [],
    } as unknown as ResolvedTurnTools;
    const bind = async (current: WorkerSession) => {
      const run = await current.beginRun({ options: undefined, prompt: 'test' });
      let context: ToolUseContext | undefined;
      const pipeline = current.buildTurnPipeline({
        turn: 1, messages: [], tools: [], resolved, turnContext: run.turnContext,
        options: undefined, canUseTool: async () => true,
        toolInvokeDispatcher: { dispatch: async () => ({ result: '' }) }, publisher: undefined,
        bindToolUseContext: (value) => { context = value; },
      });
      return { run, context: context!, pipeline };
    };
    const first = await bind(session);
    const independent = await bind(other);
    expect(() => session.setWorkingDirectory(target)).toThrow(expect.objectContaining({ code: 'execution_context_run_active' }));
    expect(session.readWorkingDirectory()).toBe(source);
    first.run.close();
    first.pipeline.dispose();
    session.setWorkingDirectory(target);
    expect(first.context.executionLocation!.acquire()).toMatchObject({ ok: false, code: 'stale_execution_context' });
    const lease = independent.context.executionLocation!.acquire();
    expect(lease.ok).toBe(true);
    if (lease.ok) lease.release();
    const second = await bind(session);
    expect(second.context.options.workingDirectory).toBe(target);
    expect(second.context.executionLocation!.revision).toBeGreaterThan(first.context.executionLocation!.revision);
    const fresh = second.context.executionLocation!.acquire();
    expect(fresh.ok).toBe(true);
    if (fresh.ok) fresh.release();
    second.run.close();
    second.pipeline.dispose();
    independent.run.close();
    independent.pipeline.dispose();
  });
});
