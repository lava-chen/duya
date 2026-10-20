import { afterEach, describe, expect, it } from 'vitest';
import { DesktopPluginAppServerBridge } from '../plugin-app-bridge';
import {
  cleanupTempDirs,
  openPluginAppHarness,
  type PluginAppHarness,
} from './plugin-app-harness';

/**
 * The Agent Server bridge, driven by a real worker process.
 *
 * ## What is real here
 *
 * Real: the bridge, the host `WorkerManager`, the host `RunOrchestrator` over
 * a real SQLite `RunStore`, and the worker — a real forked process that reads
 * its commands on stdin and answers on its IPC channel. The wiring is the
 * production wiring: the supervisor's message handler is the one the Agent
 * Server installs, and the supervisor's exit handler is the one that reports
 * a dead worker.
 *
 * What is NOT real: the Electron main process and the browser. The boundary
 * under test is the one between the bridge and the worker, and both ends of
 * it are here.
 *
 * ## Why a real worker matters
 *
 * A synthetic double would answer whatever the test told it to answer, which
 * is exactly the assumption this bridge must not make. A real worker answers
 * with its own facts, dies when it is killed, and is replaced by a process
 * the supervisor counts as a new generation.
 */

const harnesses: PluginAppHarness[] = [];

afterEach(() => {
  for (const harness of harnesses.splice(0)) {
    try {
      harness.workers.killWorker(harness.sessionId);
    } catch {
      // A worker that is already gone is not a test failure.
    }
    harness.close();
  }
  cleanupTempDirs();
});

async function openBridge(): Promise<{
  harness: PluginAppHarness;
  bridge: DesktopPluginAppServerBridge;
}> {
  const harness = await openPluginAppHarness();
  harnesses.push(harness);
  const bridge = new DesktopPluginAppServerBridge(harness.orchestrator, harness.workers);
  // The production wiring, verbatim: the supervisor's message handler is the
  // bridge's, and the supervisor's exit handler reports the dead worker.
  harness.workers.setMessageHandler((sessionId, msg, child) => {
    bridge.handleWorkerMessage(sessionId, msg, child);
  });
  harness.workers.setWorkerExitHandler((_sessionId, child) => {
    bridge.workerExited(child);
  });
  return { harness, bridge };
}

describe('the Desktop Plugin App bridge, with a real worker', () => {
  it('describes the tools of the live worker and settles with what it answered', async () => {
    const { harness, bridge } = await openBridge();
    const child = harness.workers.spawnWorker(harness.sessionId);

    const response = await bridge.handle({
      type: 'desktop-plugin-app:request', requestId: 'main-1', operation: 'describe-tools',
      sessionId: harness.sessionId, runId: harness.runId, epoch: harness.epoch,
    });

    expect(response).toMatchObject({
      type: 'desktop-plugin-app:response',
      requestId: 'main-1',
      success: true,
      result: {
        tools: [{ toolId: 'mcp:dashboard/read', schemaRevision: 'rev-1' }],
        workerGeneration: harness.workers.workerGeneration(harness.sessionId),
      },
    });
    // The generation the bridge reports is the supervisor's own counter for
    // the process it actually talked to.
    expect(harness.workers.workerGeneration(harness.sessionId)).toBeGreaterThan(0);
    expect(harness.workers.getWorker(harness.sessionId)).toBe(child);
  });

  it('invokes a tool on the live worker and settles with its answer', async () => {
    const { harness, bridge } = await openBridge();
    harness.workers.spawnWorker(harness.sessionId);
    const generation = harness.workers.workerGeneration(harness.sessionId) as number;

    const response = await bridge.handle({
      type: 'desktop-plugin-app:request', requestId: 'main-2', operation: 'invoke-tool',
      sessionId: harness.sessionId, runId: harness.runId, epoch: harness.epoch, workerGeneration: generation,
      bindingId: 'binding-1', nonce: 'nonce-1', toolId: 'mcp:dashboard/read', schemaRevision: 'rev-1',
      capabilityId: 'mcp:dashboard.read', arguments: {},
    });

    expect(response).toMatchObject({
      requestId: 'main-2',
      success: true,
      result: { result: { ok: true, result: { value: 'answered' } } },
    });
  });

  it('settles the in-flight request when the worker under it is replaced', async () => {
    const { harness, bridge } = await openBridge();
    harness.workers.spawnWorker(harness.sessionId);
    const generation = harness.workers.workerGeneration(harness.sessionId) as number;

    // The slow tool answers two seconds later, so the request is still open
    // when the worker underneath it is replaced.
    const pending = bridge.handle({
      type: 'desktop-plugin-app:request', requestId: 'main-3', operation: 'invoke-tool',
      sessionId: harness.sessionId, runId: harness.runId, epoch: harness.epoch, workerGeneration: generation,
      bindingId: 'binding-1', nonce: 'nonce-1', toolId: 'slow', schemaRevision: 'rev-1',
      capabilityId: 'mcp:dashboard.read', arguments: {},
    });

    // The supervisor replaces the session's worker. The old one dies, and
    // the request bound to it has to be settled rather than left to time out.
    harness.workers.spawnWorker(harness.sessionId);

    const response = await pending;
    expect(response).toMatchObject({
      requestId: 'main-3',
      success: false,
      error: { code: 'plugin_app_worker_unavailable' },
    });
  });

  it('reports no live attempt once the worker is gone', async () => {
    const { harness, bridge } = await openBridge();
    harness.workers.spawnWorker(harness.sessionId);

    const before = await bridge.handle({
      type: 'desktop-plugin-app:request', requestId: 'main-4', operation: 'current-attempt', sessionId: harness.sessionId,
    });
    expect(before).toMatchObject({ success: true, result: { attempt: { runId: harness.runId, epoch: harness.epoch } } });

    harness.workers.killWorker(harness.sessionId);
    await new Promise((resolve) => setTimeout(resolve, 200));

    const after = await bridge.handle({
      type: 'desktop-plugin-app:request', requestId: 'main-5', operation: 'current-attempt', sessionId: harness.sessionId,
    });
    expect(after).toMatchObject({ success: true, result: { attempt: null } });
  });

  it('refuses an invocation bound to a worker generation that is no longer live', async () => {
    const { harness, bridge } = await openBridge();
    harness.workers.spawnWorker(harness.sessionId);
    const generation = harness.workers.workerGeneration(harness.sessionId) as number;

    // The supervisor replaces the worker, so the generation the binding was
    // minted under is no longer the live one.
    harness.workers.spawnWorker(harness.sessionId);

    const response = await bridge.handle({
      type: 'desktop-plugin-app:request', requestId: 'main-6', operation: 'invoke-tool',
      sessionId: harness.sessionId, runId: harness.runId, epoch: harness.epoch, workerGeneration: generation,
      bindingId: 'binding-1', nonce: 'nonce-1', toolId: 'mcp:dashboard/read', schemaRevision: 'rev-1',
      capabilityId: 'mcp:dashboard.read', arguments: {},
    });

    expect(response).toMatchObject({ success: false, error: { code: 'plugin_app_worker_replaced' } });
  });

  it('keeps two concurrent invocations apart, and each settles with its own answer', async () => {
    const { harness, bridge } = await openBridge();
    harness.workers.spawnWorker(harness.sessionId);
    const generation = harness.workers.workerGeneration(harness.sessionId) as number;

    const first = bridge.handle({
      type: 'desktop-plugin-app:request', requestId: 'main-7a', operation: 'invoke-tool',
      sessionId: harness.sessionId, runId: harness.runId, epoch: harness.epoch, workerGeneration: generation,
      bindingId: 'binding-1', nonce: 'nonce-1', toolId: 'mcp:dashboard/read', schemaRevision: 'rev-1',
      capabilityId: 'mcp:dashboard.read', arguments: { n: 1 },
    });
    const second = bridge.handle({
      type: 'desktop-plugin-app:request', requestId: 'main-7b', operation: 'invoke-tool',
      sessionId: harness.sessionId, runId: harness.runId, epoch: harness.epoch, workerGeneration: generation,
      bindingId: 'binding-1', nonce: 'nonce-1', toolId: 'mcp:dashboard/read', schemaRevision: 'rev-1',
      capabilityId: 'mcp:dashboard.read', arguments: { n: 2 },
    });

    const [a, b] = await Promise.all([first, second]);
    expect(a).toMatchObject({ requestId: 'main-7a', success: true });
    expect(b).toMatchObject({ requestId: 'main-7b', success: true });
  });

  it('consumes a late answer without settling anything twice', async () => {
    const { harness, bridge } = await openBridge();
    const child = harness.workers.spawnWorker(harness.sessionId);

    const response = await bridge.handle({
      type: 'desktop-plugin-app:request', requestId: 'main-8', operation: 'describe-tools',
      sessionId: harness.sessionId, runId: harness.runId, epoch: harness.epoch,
    });
    expect(response).toMatchObject({ success: true });

    // The worker answers again after the request is already settled. The
    // answer is consumed so it cannot reach another handler, and it settles
    // nothing.
    expect(bridge.handleWorkerMessage(harness.sessionId, {
      type: 'plugin-app:tools', requestId: 'main-8', sessionId: harness.sessionId,
      runId: harness.runId, epoch: harness.epoch, tools: [],
    }, child)).toBe(true);
  });
});
