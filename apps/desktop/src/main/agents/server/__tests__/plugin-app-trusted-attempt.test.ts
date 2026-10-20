import { afterEach, describe, expect, it } from 'vitest';
import type { ChildProcess } from 'node:child_process';
import { forwardWorkerDbRequest } from '../router';
import {
  cleanupTempDirs,
  openPluginAppHarness,
  type PluginAppHarness,
} from './plugin-app-harness';

/**
 * The Agent Server side of the Plugin App trust boundary.
 *
 * ## What is real here
 *
 * Real: the router's own `forwardWorkerDbRequest`, a real `RunOrchestrator`
 * over a real SQLite `RunStore` with the real migrations, a real
 * `WorkerManager` from the host package, and a real forked worker process.
 * The worker is a real child: the supervisor forks it, the supervisor owns
 * the generation counter, and the supervisor is what decides whether a
 * process is still the live worker of a session.
 *
 * The property under test is the one a worker would have to break to make a
 * side effect it was not granted: the trusted attempt the Main process acts
 * on is derived by the TRANSPORT from the orchestrator's live attempt and the
 * supervisor's live worker, never read out of the body the worker sent.
 */

const SESSION_ID = 's-plugin-app-router';
const OTHER_SESSION_ID = 's-plugin-app-other';

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

async function openHarness(): Promise<PluginAppHarness> {
  const harness = await openPluginAppHarness({ sessionId: SESSION_ID });
  harnesses.push(harness);
  return harness;
}

/** The `db:request` a worker sends for the final side-effect fence. */
function bindingCurrentRequest(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    type: 'db:request',
    id: 'req-1',
    action: 'plugin-app:binding-current',
    payload: { bindingId: 'binding-1', nonce: 'nonce-1', toolId: 'mcp:dashboard/read' },
    execution: { sessionId: SESSION_ID, runId: 'run-1', epoch: 0 },
    ...overrides,
  };
}

function forward(
  harness: PluginAppHarness,
  sessionId: string,
  child: ChildProcess,
  message: Record<string, unknown>,
): void {
  forwardWorkerDbRequest(sessionId, child, message, {
    workerManager: harness.workers,
    runOrchestrator: harness.orchestrator,
  }, harness.workerDbRequests);
}

describe('the Agent Server router — the trusted attempt it announces', () => {
  it('announces the attempt the transport derived, and strips the one the worker claimed', async () => {
    const harness = await openHarness();
    const child = harness.workers.spawnWorker(SESSION_ID);
    const attempt = harness.orchestrator.attemptFor(harness.runId);

    // The worker puts its own claim about its identity in the body. That is
    // the worker's own claim, and the router strips it.
    const forged = {
      ...bindingCurrentRequest({
        execution: { sessionId: SESSION_ID, runId: harness.runId, epoch: attempt?.epoch },
      }),
      trustedAttempt: { sessionId: 'session-1', runId: 'run-1', epoch: 99 },
      trustedPluginAppCaller: { sessionId: 'session-1', runId: 'run-1', epoch: 99 },
    };

    forward(harness, SESSION_ID, child, forged);

    const sideband = harness.sent.find((message) => message.type === 'desktop-plugin-app:trusted-attempt');
    const forwarded = harness.sent.find((message) => message.type === 'db:request');

    // The correlation is announced, and it carries the TRANSPORT's facts.
    expect(sideband).toMatchObject({
      type: 'desktop-plugin-app:trusted-attempt',
      id: 'req-1',
      sessionId: SESSION_ID,
      runId: harness.runId,
      epoch: attempt?.epoch,
    });

    // The body keeps only the body. The forged claims are gone.
    expect(forwarded).toBeDefined();
    expect(forwarded).not.toHaveProperty('trustedAttempt');
    expect(forwarded).not.toHaveProperty('trustedPluginAppCaller');
    expect(forwarded).toMatchObject({
      type: 'db:request',
      id: 'req-1',
      action: 'plugin-app:binding-current',
      payload: { bindingId: 'binding-1', nonce: 'nonce-1', toolId: 'mcp:dashboard/read' },
    });
  });

  it('announces the correlation before the request it belongs to', async () => {
    const harness = await openHarness();
    const child = harness.workers.spawnWorker(SESSION_ID);
    const attempt = harness.orchestrator.attemptFor(harness.runId);

    forward(harness, SESSION_ID, child, bindingCurrentRequest({
      execution: { sessionId: SESSION_ID, runId: harness.runId, epoch: attempt?.epoch },
    }));

    // Main consumes the correlation with the request, so it has to be there
    // first. An announcement that arrived after its request would be a
    // correlation nobody can use.
    expect(harness.sent.map((message) => message.type)).toEqual([
      'desktop-plugin-app:trusted-attempt',
      'db:request',
    ]);
  });

  it('announces nothing for a worker that is not the live worker of the session', async () => {
    const harness = await openHarness();
    const attempt = harness.orchestrator.attemptFor(harness.runId);

    // A real worker of ANOTHER session. It is a real process, it really
    // belongs to the supervisor, and it is not this session's worker.
    const foreign = harness.workers.spawnWorker(OTHER_SESSION_ID);

    forward(harness, SESSION_ID, foreign, bindingCurrentRequest({
      execution: { sessionId: SESSION_ID, runId: harness.runId, epoch: attempt?.epoch },
    }));

    expect(harness.sent.some((message) => message.type === 'desktop-plugin-app:trusted-attempt')).toBe(false);
    // The request is still forwarded; it is simply not trusted, and the
    // Main side refuses it for want of a correlation.
    expect(harness.sent.some((message) => message.type === 'db:request')).toBe(true);
  });

  it('announces nothing for a worker that was already replaced', async () => {
    const harness = await openHarness();
    const attempt = harness.orchestrator.attemptFor(harness.runId);
    const replaced = harness.workers.spawnWorker(SESSION_ID);
    // The supervisor replaces the session's worker, so the handle above is
    // now a handle to a process that is not the live one.
    harness.workers.spawnWorker(SESSION_ID);

    forward(harness, SESSION_ID, replaced, bindingCurrentRequest({
      execution: { sessionId: SESSION_ID, runId: harness.runId, epoch: attempt?.epoch },
    }));

    expect(harness.sent.some((message) => message.type === 'desktop-plugin-app:trusted-attempt')).toBe(false);
  });

  it('announces nothing for a worker that claims an epoch the run has moved past', async () => {
    const harness = await openHarness();
    const child = harness.workers.spawnWorker(SESSION_ID);
    const attempt = harness.orchestrator.attemptFor(harness.runId);

    forward(harness, SESSION_ID, child, bindingCurrentRequest({
      execution: { sessionId: SESSION_ID, runId: harness.runId, epoch: (attempt?.epoch ?? 0) + 1 },
    }));

    expect(harness.sent.some((message) => message.type === 'desktop-plugin-app:trusted-attempt')).toBe(false);
  });

  it('announces nothing for a worker that names another session or another run', async () => {
    const harness = await openHarness();
    const child = harness.workers.spawnWorker(SESSION_ID);
    const attempt = harness.orchestrator.attemptFor(harness.runId);

    for (const execution of [
      { sessionId: 'session-elsewhere', runId: harness.runId, epoch: attempt?.epoch },
      { sessionId: SESSION_ID, runId: 'run-elsewhere', epoch: attempt?.epoch },
    ]) {
      harness.sent.length = 0;
      forward(harness, SESSION_ID, child, bindingCurrentRequest({ execution }));
      expect(harness.sent.some((message) => message.type === 'desktop-plugin-app:trusted-attempt')).toBe(false);
    }
  });

  it('announces nothing once the attempt has been retired', async () => {
    const harness = await openHarness();
    const child = harness.workers.spawnWorker(SESSION_ID);
    const attempt = harness.orchestrator.attemptFor(harness.runId);

    // The run ends. Its attempt is released, and a released attempt is not a
    // live one: it may no longer establish itself for a new turn.
    harness.orchestrator.observe(SESSION_ID, { type: 'done', reason: 'end_turn' });
    await harness.orchestrator.settleSession(SESSION_ID);
    expect(harness.orchestrator.attemptFor(harness.runId)).toBeNull();

    forward(harness, SESSION_ID, child, bindingCurrentRequest({
      execution: { sessionId: SESSION_ID, runId: harness.runId, epoch: attempt?.epoch },
    }));

    expect(harness.sent.some((message) => message.type === 'desktop-plugin-app:trusted-attempt')).toBe(false);
  });

  it('announces nothing for an action that is not the binding check', async () => {
    const harness = await openHarness();
    const child = harness.workers.spawnWorker(SESSION_ID);
    const attempt = harness.orchestrator.attemptFor(harness.runId);

    forward(harness, SESSION_ID, child, bindingCurrentRequest({
      action: 'session:create',
      payload: { id: 'session-new' },
      execution: { sessionId: SESSION_ID, runId: harness.runId, epoch: attempt?.epoch },
    }));

    expect(harness.sent.some((message) => message.type === 'desktop-plugin-app:trusted-attempt')).toBe(false);
  });
});
