import { EventEmitter } from 'node:events';
import type { ChildProcess } from 'node:child_process';
import { describe, expect, it, vi } from 'vitest';
import type { RunOrchestrator } from '@duya/host/run-orchestrator';
import type { WorkerManager } from '../worker-manager';
import { DesktopPluginAppServerBridge } from '../plugin-app-bridge';

function createWorker(): ChildProcess {
  return Object.assign(new EventEmitter(), { killed: false, exitCode: null }) as unknown as ChildProcess;
}

function createBridge(options: { epoch?: number; retired?: boolean } = {}) {
  const child = createWorker();
  let currentWorker: ChildProcess | undefined = child;
  let currentGeneration = 1;
  const commands: Record<string, unknown>[] = [];
  const workers = {
    getWorker: () => currentWorker,
    workerGeneration: () => (currentWorker ? currentGeneration : null),
    sendCommand: vi.fn((_sessionId: string, command: Record<string, unknown>) => {
      commands.push(command);
      return true;
    }),
  } as unknown as WorkerManager;
  const orchestrator = {
    runForSession: vi.fn(() => 'run-1'),
    attemptFor: vi.fn(() => ({ epoch: options.epoch ?? 4, retired: options.retired ?? false, superseded: null })),
  } as unknown as RunOrchestrator;
  const bridge = new DesktopPluginAppServerBridge(orchestrator, workers);
  return {
    bridge,
    child,
    commands,
    workers,
    replaceWorker: (worker: ChildProcess) => {
      currentWorker = worker;
      currentGeneration += 1;
    },
    bumpGeneration: () => {
      currentGeneration += 1;
    },
    removeWorker: () => {
      currentWorker = undefined;
    },
  };
}

describe('DesktopPluginAppServerBridge', () => {
  it('reports only a live orchestrator attempt and the supervisor worker generation', async () => {
    const { bridge } = createBridge();
    const response = await bridge.handle({
      type: 'desktop-plugin-app:request', requestId: 'main-1', operation: 'current-attempt', sessionId: 'session-1',
    });
    expect(response).toMatchObject({
      type: 'desktop-plugin-app:response', requestId: 'main-1', success: true,
      result: { attempt: { runId: 'run-1', epoch: 4, workerGeneration: 1 } },
    });
  });

  it('refuses a retired orchestrator attempt', async () => {
    const { bridge } = createBridge({ retired: true });
    const response = await bridge.handle({
      type: 'desktop-plugin-app:request', requestId: 'main-retired', operation: 'current-attempt', sessionId: 'session-1',
    });
    expect(response).toMatchObject({ success: true, result: { attempt: null } });
  });

  it('routes a tool description through the captured worker and ignores foreign replies', async () => {
    const { bridge, child, commands } = createBridge();
    const pending = bridge.handle({
      type: 'desktop-plugin-app:request', requestId: 'main-2', operation: 'describe-tools',
      sessionId: 'session-1', runId: 'run-1', epoch: 4,
    });
    const command = commands[0]!;
    expect(command).toMatchObject({ type: 'plugin-app:describe-tools', sessionId: 'session-1', runId: 'run-1', epoch: 4 });
    // A reply from a different child carries a foreign request correlation and
    // must not settle the pending request.
    expect(bridge.handleWorkerMessage('session-1', {
      type: 'plugin-app:tools', requestId: command.requestId, sessionId: 'session-1', runId: 'run-1', epoch: 4, tools: [],
    }, createWorker())).toBe(true);
    bridge.handleWorkerMessage('session-1', {
      type: 'plugin-app:tools', requestId: command.requestId, sessionId: 'session-1', runId: 'run-1', epoch: 4, tools: [],
    }, child);
    expect(await pending).toMatchObject({ success: true, result: { tools: [] } });
  });

  it('drops a reply whose epoch does not match the request', async () => {
    const { bridge, child, commands } = createBridge();
    const pending = bridge.handle({
      type: 'desktop-plugin-app:request', requestId: 'main-epoch', operation: 'describe-tools',
      sessionId: 'session-1', runId: 'run-1', epoch: 4,
    });
    const command = commands[0]!;
    bridge.handleWorkerMessage('session-1', {
      type: 'plugin-app:tools', requestId: command.requestId, sessionId: 'session-1', runId: 'run-1', epoch: 99, tools: [],
    }, child);
    // The mismatched reply settled nothing; the matching one still does.
    bridge.handleWorkerMessage('session-1', {
      type: 'plugin-app:tools', requestId: command.requestId, sessionId: 'session-1', runId: 'run-1', epoch: 4, tools: [],
    }, child);
    expect(await pending).toMatchObject({ success: true, result: { tools: [] } });
  });

  it('refuses invocation when the worker instance changed after binding', async () => {
    const { bridge, replaceWorker } = createBridge();
    const current = await bridge.handle({
      type: 'desktop-plugin-app:request', requestId: 'main-4', operation: 'current-attempt', sessionId: 'session-1',
    });
    if (!current.success || !('attempt' in current.result) || !current.result.attempt) throw new Error('expected active attempt');
    replaceWorker(createWorker());
    const response = await bridge.handle({
      type: 'desktop-plugin-app:request', requestId: 'main-5', operation: 'invoke-tool',
      sessionId: 'session-1', runId: 'run-1', epoch: 4, workerGeneration: current.result.attempt.workerGeneration,
      bindingId: 'binding', nonce: 'nonce', toolId: 'tool', schemaRevision: 'rev', capabilityId: 'cap', arguments: {},
    });
    expect(response).toMatchObject({ success: false, error: { code: 'plugin_app_worker_replaced' } });
  });

  it('fails an in-flight request when its worker exits', async () => {
    const { bridge, child, commands } = createBridge();
    const pending = bridge.handle({
      type: 'desktop-plugin-app:request', requestId: 'main-exit', operation: 'describe-tools',
      sessionId: 'session-1', runId: 'run-1', epoch: 4,
    });
    const command = commands[0]!;
    void command;
    bridge.workerExited(child);
    const response = await pending;
    expect(response).toMatchObject({ success: false, error: { code: 'plugin_app_worker_unavailable' } });
  });

  it('settles nothing for a late reply to a request that already finished', async () => {
    const { bridge, child, commands } = createBridge();
    const pending = bridge.handle({
      type: 'desktop-plugin-app:request', requestId: 'main-late', operation: 'describe-tools',
      sessionId: 'session-1', runId: 'run-1', epoch: 4,
    });
    const command = commands[0]!;
    bridge.handleWorkerMessage('session-1', {
      type: 'plugin-app:tools', requestId: command.requestId, sessionId: 'session-1', runId: 'run-1', epoch: 4, tools: [],
    }, child);
    expect(await pending).toMatchObject({ success: true });
    // The second, late reply is consumed but settles nothing.
    expect(bridge.handleWorkerMessage('session-1', {
      type: 'plugin-app:tools', requestId: command.requestId, sessionId: 'session-1', runId: 'run-1', epoch: 4, tools: [],
    }, child)).toBe(true);
  });

  it('leaks no pending request across many repeated calls', async () => {
    const { bridge, child, commands } = createBridge();
    for (let index = 0; index < 25; index += 1) {
      const pending = bridge.handle({
        type: 'desktop-plugin-app:request', requestId: `main-loop-${index}`, operation: 'describe-tools',
        sessionId: 'session-1', runId: 'run-1', epoch: 4,
      });
      const command = commands[index]!;
      bridge.handleWorkerMessage('session-1', {
        type: 'plugin-app:tools', requestId: command.requestId, sessionId: 'session-1', runId: 'run-1', epoch: 4, tools: [],
      }, child);
      expect(await pending).toMatchObject({ success: true });
    }
    // Every request settled, so the bridge holds no pending entry, and a late
    // reply for any of them is still harmless.
    expect(bridge.handleWorkerMessage('session-1', {
      type: 'plugin-app:tools', requestId: 'main-loop-0', sessionId: 'session-1', runId: 'run-1', epoch: 4, tools: [],
    }, child)).toBe(true);
  });

  it('routes an invocation through the captured worker and settles with its answer', async () => {
    const { bridge, child, commands } = createBridge();
    const pending = bridge.handle({
      type: 'desktop-plugin-app:request', requestId: 'main-invoke', operation: 'invoke-tool',
      sessionId: 'session-1', runId: 'run-1', epoch: 4, workerGeneration: 1,
      bindingId: 'binding', nonce: 'nonce', toolId: 'tool', schemaRevision: 'rev', capabilityId: 'cap', arguments: {},
    });
    const command = commands[0]!;
    expect(command).toMatchObject({
      type: 'plugin-app:invoke', sessionId: 'session-1', runId: 'run-1', epoch: 4,
      bindingId: 'binding', nonce: 'nonce', toolId: 'tool', schemaRevision: 'rev', capabilityId: 'cap',
    });
    bridge.handleWorkerMessage('session-1', {
      type: 'plugin-app:result', requestId: command.requestId, sessionId: 'session-1', runId: 'run-1', epoch: 4,
      result: { ok: true, result: 'done' },
    }, child);
    expect(await pending).toMatchObject({
      success: true,
      result: { result: { ok: true, result: 'done' } },
    });
  });

  it('drops a reply from the live worker once its generation moved on', async () => {
    const { bridge, child, commands, bumpGeneration } = createBridge();
    const pending = bridge.handle({
      type: 'desktop-plugin-app:request', requestId: 'main-generation', operation: 'describe-tools',
      sessionId: 'session-1', runId: 'run-1', epoch: 4,
    });
    const command = commands[0]!;
    // The worker process is the same one, but the supervisor counted a
    // replacement, so the generation the request was bound to is no longer
    // the live one.
    bumpGeneration();
    bridge.handleWorkerMessage('session-1', {
      type: 'plugin-app:tools', requestId: command.requestId, sessionId: 'session-1', runId: 'run-1', epoch: 4, tools: [],
    }, child);
    // The stale reply settled nothing; the request is still open.
    expect(bridge.handleWorkerMessage('session-1', {
      type: 'plugin-app:tools', requestId: command.requestId, sessionId: 'session-1', runId: 'run-1', epoch: 4, tools: [],
    }, child)).toBe(true);
  });

  it('rejects a reply that does not answer the operation it was sent for', async () => {
    const { bridge, child, commands } = createBridge();
    const pending = bridge.handle({
      type: 'desktop-plugin-app:request', requestId: 'main-mismatch', operation: 'describe-tools',
      sessionId: 'session-1', runId: 'run-1', epoch: 4,
    });
    const command = commands[0]!;
    // An invocation answer to a catalog request is not an answer to it.
    bridge.handleWorkerMessage('session-1', {
      type: 'plugin-app:result', requestId: command.requestId, sessionId: 'session-1', runId: 'run-1', epoch: 4,
      result: { ok: true, result: 'done' },
    }, child);
    expect(await pending).toMatchObject({ success: false, error: { code: 'plugin_app_worker_response_invalid' } });
  });

  it('drops the pending request when the worker never answers', async () => {
    vi.useFakeTimers();
    try {
      const { bridge, child, commands } = createBridge();
      const pending = bridge.handle({
        type: 'desktop-plugin-app:request', requestId: 'main-timeout', operation: 'describe-tools',
        sessionId: 'session-1', runId: 'run-1', epoch: 4,
      });
      const command = commands[0]!;
      await vi.advanceTimersByTimeAsync(30_000);

      const response = await pending;
      expect(response).toMatchObject({ success: false, error: { code: 'plugin_app_worker_timeout' } });

      // The request is gone from the pending table, so a late answer is
      // consumed and settles nothing.
      expect(bridge.handleWorkerMessage('session-1', {
        type: 'plugin-app:tools', requestId: command.requestId, sessionId: 'session-1', runId: 'run-1', epoch: 4, tools: [],
      }, child)).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps two concurrent invocations apart, and each settles with its own answer', async () => {
    const { bridge, child, commands } = createBridge();
    const first = bridge.handle({
      type: 'desktop-plugin-app:request', requestId: 'main-a', operation: 'invoke-tool',
      sessionId: 'session-1', runId: 'run-1', epoch: 4, workerGeneration: 1,
      bindingId: 'binding', nonce: 'nonce', toolId: 'tool', schemaRevision: 'rev', capabilityId: 'cap', arguments: { n: 1 },
    });
    const second = bridge.handle({
      type: 'desktop-plugin-app:request', requestId: 'main-b', operation: 'invoke-tool',
      sessionId: 'session-1', runId: 'run-1', epoch: 4, workerGeneration: 1,
      bindingId: 'binding', nonce: 'nonce', toolId: 'tool', schemaRevision: 'rev', capabilityId: 'cap', arguments: { n: 2 },
    });
    // Two calls, two request ids: the bridge never reuses a correlation.
    expect(commands[0]!.requestId).not.toBe(commands[1]!.requestId);

    bridge.handleWorkerMessage('session-1', {
      type: 'plugin-app:result', requestId: commands[1]!.requestId, sessionId: 'session-1', runId: 'run-1', epoch: 4,
      result: { ok: true, result: 'second' },
    }, child);
    bridge.handleWorkerMessage('session-1', {
      type: 'plugin-app:result', requestId: commands[0]!.requestId, sessionId: 'session-1', runId: 'run-1', epoch: 4,
      result: { ok: true, result: 'first' },
    }, child);

    const [a, b] = await Promise.all([first, second]);
    expect(a).toMatchObject({ requestId: 'main-a', success: true, result: { result: { result: 'first' } } });
    expect(b).toMatchObject({ requestId: 'main-b', success: true, result: { result: { result: 'second' } } });
  });
});
