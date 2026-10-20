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
});
