/** Exercise the production dispatch seams with real Git checkouts and file/shell tools. */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';
import { ApplyPatchTool, BashTool, EditTool, ReadTool, WriteTool } from '@duya/capabilities';
import type { ToolUseContext } from '../../src/worker-run-contracts.js';
import { ToolRegistry } from '../../src/worker-tool-registry.js';
import { ToolExecutionPipeline } from '../../src/worker-execution/tool-execution-pipeline.js';
import { createToolInvokeDispatcherFromRegistry } from '../../src/worker-execution/deferred-dispatcher.js';
import { createCheckoutProvider } from '../../src/workspace/checkout-provider.js';
import { git, makeRepo, tempDir, useIsolatedDataRoot } from './fixtures.js';

const worker = vi.hoisted(() => ({ executeTask: vi.fn(async (request: { id: string }) => ({ taskId: request.id, success: true, result: 'worker ran' })) }));
vi.mock('@duya/host/worker-tool-pool', () => ({ getWorkerPool: () => worker, WorkerPool: class {} }));

let restoreDataRoot: () => void;
beforeAll(() => { restoreDataRoot = useIsolatedDataRoot(); });
afterAll(() => { restoreDataRoot(); });

function context(cwd: string, sessionId = 'other-session'): ToolUseContext {
  return {
    abortController: new AbortController(),
    options: { workingDirectory: cwd, sessionId },
    getAppState: () => ({ toolPermissionContext: { mode: 'bypassPermissions' }, _approvedToolUses: { 'call-1': true } }),
    setAppState: () => {},
  } as unknown as ToolUseContext;
}

function registry() {
  const tools = new ToolRegistry();
  for (const tool of [new ReadTool(), new WriteTool(), new EditTool(), new ApplyPatchTool()]) {
    tools.register(tool.toTool(), tool);
  }
  const start = vi.fn(async (params) => {
    const text = execFileSync(params.shellPath, params.shellArgs, { cwd: params.cwd, env: params.env, encoding: 'utf8' });
    return {
      taskId: params.taskId, pid: process.pid, outputFile: '', promoteToBackground() {},
      settled: Promise.resolve({ taskId: params.taskId, status: 'completed' as const, exitCode: 0, text, durationMs: 1 }),
    };
  });
  const bash = new BashTool({ start, outputDirectory: () => tempDir('duya-gate-shell-') });
  tools.register(bash.toTool(), bash);
  return { tools, start };
}

async function checkout() {
  const repo = makeRepo();
  const provider = createCheckoutProvider();
  const created = await provider.create({ sourceCwd: repo, ownerSessionId: 'owner', label: 'write gate' });
  return { repo, provider, created };
}

describe('checkout ownership at actual tool dispatch', () => {
  it('denies real Edit/Write for another session despite bypass mode and preserves Read', async () => {
    const { created } = await checkout();
    const { tools } = registry();
    const ctx = context(created.cwd);
    for (const [name, input] of [
      ['write', { file_path: 'README.md', content: 'overwritten' }],
      ['edit', { file_path: 'README.md', old_string: 'fixture', new_string: 'overwritten' }],
    ] as const) {
      const result = await tools.execute(name, input, created.cwd, ctx);
      expect(result?.error).toBe(true);
      expect(result?.metadata?.errorCode).toBe('checkout_write_denied');
    }
    expect(readFileSync(path.join(created.root, 'README.md'), 'utf8')).toBe('# fixture\n');
    const read = await tools.execute('read', { file_path: 'README.md' }, created.cwd, ctx);
    expect(read?.error).not.toBe(true);
    expect(read?.result).toContain('fixture');
  });

  it('allows the owner to write and edit, then refuses writes after release', async () => {
    const { created, provider } = await checkout();
    const { tools } = registry();
    const ctx = context(created.cwd, 'owner');
    expect((await tools.execute('write', { file_path: 'new/file.txt', content: 'before' }, created.cwd, ctx))?.error).not.toBe(true);
    expect((await tools.execute('edit', { file_path: 'new/file.txt', old_string: 'before', new_string: 'after' }, created.cwd, ctx))?.error).not.toBe(true);
    expect(readFileSync(path.join(created.root, 'new/file.txt'), 'utf8')).toBe('after');
    await provider.release(created.root, 'owner');
    expect((await tools.execute('write', { file_path: 'new/file.txt', content: 'lost' }, created.cwd, ctx))?.metadata?.reason).toBe('unowned');
    expect(readFileSync(path.join(created.root, 'new/file.txt'), 'utf8')).toBe('after');
  });

  it('checks an absolute managed target even when cwd is the primary checkout', async () => {
    const { repo, created } = await checkout();
    const { tools } = registry();
    const target = path.join(created.root, 'missing', 'nested', 'new.txt');
    expect((await tools.execute('write', { file_path: target, content: 'denied' }, repo, context(repo)))?.error).toBe(true);
    expect(existsSync(target)).toBe(false);
    expect((await tools.execute('write', { file_path: target, content: 'allowed' }, repo, context(repo, 'owner')))?.error).not.toBe(true);
    expect(readFileSync(target, 'utf8')).toBe('allowed');
  });

  it('rejects every patch before changing any file when one target belongs to another owner', async () => {
    const { repo, created } = await checkout();
    const { tools } = registry();
    const patch = `*** Begin Patch\n*** Add File: first.txt\n+must not appear\n*** Add File: ${path.join(created.root, 'second.txt')}\n+denied\n*** End Patch`;
    const result = await tools.execute('apply_patch', { patch }, repo, context(repo));
    expect(result?.metadata?.errorCode).toBe('checkout_write_denied');
    expect(existsSync(path.join(repo, 'first.txt'))).toBe(false);
    expect(existsSync(path.join(created.root, 'second.txt'))).toBe(false);
  });

  it('rejects paths back to the primary checkout and missing descendants through a symlink', async () => {
    const { repo, created } = await checkout();
    const { tools } = registry();
    const ctx = context(created.cwd, 'owner');
    const target = path.join(repo, 'escaped.txt');
    expect((await tools.execute('write', { file_path: target, content: 'denied' }, created.cwd, ctx))?.metadata?.reason).toBe('outside_checkout');
    symlinkSync(repo, path.join(created.root, 'primary-link'), process.platform === 'win32' ? 'junction' : 'dir');
    expect((await tools.execute('write', { file_path: 'primary-link/missing/escaped.txt', content: 'denied' }, created.cwd, ctx))?.metadata?.reason).toBe('outside_checkout');
    expect(existsSync(target)).toBe(false);
    expect(existsSync(path.join(repo, 'missing'))).toBe(false);
  });

  it('keeps ordinary manual linked worktrees writable', async () => {
    const repo = makeRepo();
    const manual = path.join(tempDir('duya-manual-gate-'), 'checkout');
    git(repo, 'worktree', 'add', '--detach', manual, 'HEAD');
    const { tools } = registry();
    const result = await tools.execute('write', { file_path: 'new.txt', content: 'manual' }, manual, context(manual));
    expect(result?.error).not.toBe(true);
    expect(readFileSync(path.join(manual, 'new.txt'), 'utf8')).toBe('manual');
  });

  it('refuses an unreadable owner record instead of treating the checkout as unowned', async () => {
    const { created } = await checkout();
    const { tools } = registry();
    writeFileSync(git(created.root, 'rev-parse', '--path-format=absolute', '--git-path', 'codex-thread.json'), '{broken');
    const result = await tools.execute('write', { file_path: 'denied.txt', content: 'denied' }, created.cwd, context(created.cwd, 'owner'));
    expect(result?.metadata?.reason).toBe('unreadable');
    expect(existsSync(path.join(created.root, 'denied.txt'))).toBe(false);
  });

  it('refuses a missing target behind a dangling directory link', async () => {
    const { repo, created } = await checkout();
    const { tools } = registry();
    symlinkSync(path.join(repo, 'missing'), path.join(created.root, 'dangling'), process.platform === 'win32' ? 'junction' : 'dir');
    const result = await tools.execute('write', { file_path: 'dangling/new.txt', content: 'denied' }, created.cwd, context(created.cwd, 'owner'));
    expect(result?.metadata?.reason).toBe('unreadable');
    expect(existsSync(path.join(repo, 'missing'))).toBe(false);
  });

  it.skipIf(process.platform === 'win32')('denies a real Bash command before starting a process and allows the owner', async () => {
    const { created } = await checkout();
    const { tools, start } = registry();
    const input = { command: 'printf shell > shell.txt' };
    expect((await tools.execute('bash', input, created.cwd, context(created.cwd)))?.error).toBe(true);
    expect(start).not.toHaveBeenCalled();
    expect(existsSync(path.join(created.root, 'shell.txt'))).toBe(false);
    expect((await tools.execute('bash', input, created.cwd, context(created.cwd, 'owner')))?.error).not.toBe(true);
    expect(start).toHaveBeenCalledTimes(1);
    expect(readFileSync(path.join(created.root, 'shell.txt'), 'utf8')).toBe('shell');
  });

  it.each(['approval', 'beforeExecute'] as const)('checks ownership after deferred %s instead of invoking the captured executor directly', async (phase) => {
    const { created, provider } = await checkout();
    const { tools } = registry();
    const write = new WriteTool();
    tools.register(write.toTool(), write, { exposure: 'deferred' });
    const snapshot = tools.snapshot(new Map());
    const entry = snapshot.catalogEntries.find((item) => item.definition.name === 'write')!;
    const transfer = async () => {
      await provider.release(created.root, 'owner');
      await provider.bind(created.root, 'new-owner', 'explicit-release');
    };
    const dispatcher = createToolInvokeDispatcherFromRegistry({
      registry: tools, getSnapshot: () => snapshot, workingDirectory: created.cwd,
      contextProvider: () => context(created.cwd, 'owner'),
      checkPermission: async () => {
        if (phase === 'approval') await transfer();
        return { behavior: 'allow' };
      },
      beforeExecute: async () => {
        if (phase === 'beforeExecute') await transfer();
        return undefined;
      },
    });
    const result = await dispatcher.dispatch({ tool_id: entry.toolId, arguments: { file_path: 'deferred.txt', content: 'denied' } });
    expect(result.errorCode).toBe('checkout_write_denied');
    expect(existsSync(path.join(created.root, 'deferred.txt'))).toBe(false);
  });

  it('checks an already-approved shell worker invocation before worker-pool dispatch', async () => {
    const { created } = await checkout();
    const { tools } = registry();
    worker.executeTask.mockClear();
    const pipeline = new ToolExecutionPipeline(tools, async () => ({ allowed: true, behavior: 'allow' }), context(created.cwd), { workerTools: ['bash'], enableRetry: false });
    pipeline.addTool({ id: 'call-1', name: 'bash', input: { command: 'printf denied > worker.txt' } });
    const results = [];
    for await (const update of pipeline.getRemainingResults()) results.push(update);
    expect(JSON.stringify(results)).toContain('checkout_write_denied');
    expect(worker.executeTask).not.toHaveBeenCalled();
    expect(existsSync(path.join(created.root, 'worker.txt'))).toBe(false);
  });

  it('passes the owning session identity through to the shell worker', async () => {
    const { created } = await checkout();
    const { tools } = registry();
    worker.executeTask.mockClear();
    const pipeline = new ToolExecutionPipeline(tools, async () => ({ allowed: true, behavior: 'allow' }), context(created.cwd, 'owner'), { workerTools: ['bash'], enableRetry: false });
    pipeline.addTool({ id: 'call-1', name: 'bash', input: { command: 'printf owner' } });
    for await (const _update of pipeline.getRemainingResults()) { /* drain the real pipeline */ }
    expect(worker.executeTask).toHaveBeenCalledWith(expect.objectContaining({ sessionId: 'owner', workingDirectory: created.cwd }));
  });
});
