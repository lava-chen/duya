/** Exercise the main-session tool, durable controller and next model-round assembly together. */
import { afterAll, describe, expect, it } from 'vitest';
import { readFileSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';
import { CoreDatabase } from '@duya/data/core-database';
import { SessionStore } from '@duya/data/session-store';
import { WriteTool } from '@duya/capabilities';
import { WorkerSession } from '../../src/worker-session-runtime.js';
import { ToolRegistry } from '../../src/worker-tool-registry.js';
import { WorktreeControlTool } from '../../src/worker-tools/worktree.js';
import { SessionCheckoutService } from '../../src/workspace/session-checkout-service.js';
import { getAgentsMdManager } from '../../src/worker-agents-md/index.js';
import type { ToolUseContext } from '../../src/worker-run-contracts.js';
import { git, makeRepo, tempDir, useIsolatedDataRoot } from './fixtures.js';

const restore = useIsolatedDataRoot();
afterAll(restore);

describe('main session worktree tool', () => {
  it('reassembles instructions and tool cwd on the next round and fences the old batch', async () => {
    const repo = makeRepo();
    writeFileSync(path.join(repo, 'AGENTS.md'), 'COMMITTED_TARGET_INSTRUCTIONS');
    git(repo, 'add', '.'); git(repo, 'commit', '-qm', 'instructions');
    writeFileSync(path.join(repo, 'AGENTS.md'), 'DIRTY_SOURCE_INSTRUCTIONS');
    const db = new CoreDatabase({ filename: path.join(tempDir('duya-tool-db-'), 'core.db'), migrations: SessionStore.migrations });
    const sessions = new SessionStore(db.db);
    sessions.create({ id: 'session', workingDirectory: repo });
    const service = new SessionCheckoutService({ sessions, runs: { listRunsBySession: () => [] }, validateActor: () => {} });
    const registry = new ToolRegistry();
    for (const tool of [new WorktreeControlTool('enter'), new WorktreeControlTool('exit'), new WriteTool()]) registry.register(tool.toTool(), tool);
    const session = new WorkerSession({ apiKey: 'test', provider: 'anthropic', model: 'claude-sonnet-4-5', sessionId: 'session', workingDirectory: repo, enableRetry: false }, {
      createRegistry: () => registry,
      checkoutControl: (id, command) => service.control(id, command, { sessionId: id }),
      refreshExecutionLocation: (cwd) => getAgentsMdManager().refreshForTask(cwd),
    });
    const options = { toolRegistry: registry, sessionId: 'session' };
    const run = await session.beginRun({ prompt: 'work', options });
    let context: ToolUseContext | undefined;
    const assembly = await session.beginTurnAssembly({ prompt: 'work', options, turnContext: run.turnContext, appliedProfile: run.appliedProfile, publisher: undefined });
    const pipeline = session.buildTurnPipeline({ turn: 1, messages: [], tools: assembly.tools, resolved: assembly.resolved, turnContext: run.turnContext,
      options, canUseTool: async () => true, toolInvokeDispatcher: { dispatch: async () => ({ result: '' }) }, publisher: undefined, bindToolUseContext: (value) => { context = value; } });
    try {
      const result = await registry.execute('enter_worktree', { name: 'main-tool' }, repo, context!);
      expect(result?.error, JSON.stringify(result)).not.toBe(true);
      const target = service.read('session').cwd;
      expect(session.readWorkingDirectory()).toBe(target);
      const stale = await registry.execute('write', { file_path: 'result.txt', content: 'stale' }, repo, context!);
      expect(JSON.stringify(stale)).toContain('stale_execution_context');
      await assembly.prepare?.();
      expect(assembly.turnContext.workingDirectory).toBe(target);
      expect(assembly.systemPrompt).toContain('COMMITTED_TARGET_INSTRUCTIONS');
      expect(assembly.systemPrompt).not.toContain('DIRTY_SOURCE_INSTRUCTIONS');
      const fresh = assembly.assemble({ turn: 2, messages: [], systemPrompt: assembly.systemPrompt, tools: assembly.tools });
      expect(fresh.systemPrompt).toContain('COMMITTED_TARGET_INSTRUCTIONS');
      expect(readFileSync(path.join(repo, 'AGENTS.md'), 'utf8')).toBe('DIRTY_SOURCE_INSTRUCTIONS');
    } finally { pipeline.dispose(); run.close(); db.close(); }
  }, 30_000);
});
