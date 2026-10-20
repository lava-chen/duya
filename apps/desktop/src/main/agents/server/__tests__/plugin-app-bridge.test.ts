import { EventEmitter } from 'node:events';
import type { ChildProcess } from 'node:child_process';
import { describe, expect, it, vi } from 'vitest';
import type { RunOrchestrator } from '@duya/host/run-orchestrator';
import type { WorkerManager } from '../worker-manager';
import { DesktopPluginAppServerBridge } from '../plugin-app-bridge';

function createBridge() {
  const child = Object.assign(new EventEmitter(), { killed: false, exitCode: null }) as unknown as ChildProcess;
  let currentWorker = child;
  const commands: Record<string, unknown>[] = [];
  const workers = {
    getWorker: () => currentWorker,
    sendCommand: vi.fn((_sessionId: string, command: Record<string, unknown>) => { commands.push(command); return true; }),
  } as unknown as WorkerManager;
  const orchestrator = {
    runForSession: vi.fn(() => 'run-1'),
    attemptFor: vi.fn(() => ({ epoch: 4, retired: false, superseded: null })),
  } as unknown as RunOrchestrator;
  const bridge = new DesktopPluginAppServerBridge(orchestrator, workers);
  return { bridge, child, commands, workers, replaceWorker: (worker: ChildProcess) => { currentWorker = worker; } };
}

describe('DesktopPluginAppServerBridge', () => {
  it('reports only a live orchestrator attempt and worker generation', async () => {
    const { bridge } = createBridge();
    const response = await bridge.handle({
      type: 'desktop-plugin-app:request', requestId: 'main-1', operation: 'current-attempt', sessionId: 'session-1',
    });
    expect(response).toMatchObject({
      type: 'desktop-plugin-app:response', requestId: 'main-1', success: true,
      result: { attempt: { runId: 'run-1', epoch: 4, workerGeneration: expect.any(String) } },
    });
  });

  it('routes a tool description through the captured worker and ignores foreign replies', async () => {
    const { bridge, child, commands } = createBridge();
    const pending = bridge.handle({
      type: 'desktop-plugin-app:request', requestId: 'main-2', operation: 'describe-tools',
      sessionId: 'session-1', runId: 'run-1', epoch: 4,
    });
    const command = commands[0]!;
    expect(command).toMatchObject({ type: 'plugin-app:describe-tools', sessionId: 'session-1', runId: 'run-1', epoch: 4 });
    expect(bridge.handleWorkerMessage('session-1', {
      type: 'plugin-app:tools', requestId: command.requestId, sessionId: 'session-1', runId: 'run-1', epoch: 4, tools: [],
    }, new EventEmitter() as unknown as ChildProcess)).toBe(true);
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
    replaceWorker(Object.assign(new EventEmitter(), { killed: false, exitCode: null }) as unknown as ChildProcess);
    const response = await bridge.handle({
      type: 'desktop-plugin-app:request', requestId: 'main-5', operation: 'invoke-tool',
      sessionId: 'session-1', runId: 'run-1', epoch: 4, workerGeneration: current.result.attempt.workerGeneration,
      bindingId: 'binding', nonce: 'nonce', toolId: 'tool', schemaRevision: 'rev', capabilityId: 'cap', arguments: {},
    });
    expect(response).toMatchObject({ success: false, error: { code: 'plugin_app_worker_replaced' } });
  });
});
