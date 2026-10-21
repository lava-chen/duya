/**
 * run-permission-respond.test.ts --- plan 587 R2.4.
 *
 * The controller half of the approval round trip: `RunHandle.respondToPermission`
 * used to be an unconditional `throw`, so the runtime had no way to answer a
 * prompt at all. It now delegates to the host's decision path, which is where
 * the durable record and the deadline live.
 *
 * Offline: a scripted executor, no worker, no Electron, no provider.
 */

import { describe, it, expect, vi } from 'vitest';

import { RunController, type PermissionResponder } from '@duya/agent-runtime';
import type {
  ExecutionChannel,
  ExecutionHandle,
  RunManifest,
  RunMetrics,
  RunPersistence,
  RunEventEnvelope,
  RunTerminalState,
  StopReceipt,
  TranslateContext,
} from '@duya/agent-runtime';
import type { PermissionAck, PermissionResponse } from '@duya/agent-protocol';

class NoopPersistence implements RunPersistence {
  async append(_envelopes: readonly RunEventEnvelope[]): Promise<void> {}
  async complete(_terminal: RunTerminalState, _metrics: RunMetrics): Promise<void> {}
}

function contextFor(): TranslateContext {
  return {
    messageId: 'msg-1',
    permission: {
      classify: () => 'tool_use',
      mode: 'generic',
      expiresInMs: 300_000,
      now: () => Date.now(),
    },
    nextTurn: (() => {
      let n = 0;
      return () => {
        n += 1;
        return { turnId: `turn-${n}`, index: n };
      };
    })(),
    model: { model: 'test-model', providerId: 'test-provider', apiFormat: 'anthropic' },
  };
}

function buildManifest(runId: string): RunManifest {
  return {
    version: 1,
    runId,
    projectId: null,
    workspaceId: 'ws-1',
    roots: ['/tmp/workspace'],
    cwd: '/tmp/workspace',
    permissionPolicy: {
      mode: 'default' as RunManifest['permissionPolicy']['mode'],
      hostSwitch: 'ask' as const,
      defaultTimeoutMs: 300_000,
    },
    capabilities: { profiles: [], modes: ['general'], tools: ['Read'] },
    connectorBindings: [],
    env: { ref: 'env:session-1', hash: 'e3b0c44298fc1c149afbf4c8996fb924' },
    budget: {},
    deterministic: false,
  };
}

/** An executor that does nothing at all: the run simply sits there. */
function idleExecutor(onStop?: () => void): ExecutionChannel {
  return {
    async start(): Promise<ExecutionHandle> {
      return {
        stop: async (): Promise<StopReceipt> => {
          onStop?.();
          return { requested: true, disposition: 'cooperative', waitedMs: 0, reason: 'test' };
        },
      };
    },
  };
}

/** A decision path that records what it was asked, and can be told to refuse. */
function makeResponder(
  reply: PermissionAck = { accepted: true },
): { responder: PermissionResponder; calls: Array<{ runId: string; requestId: string; response: PermissionResponse }> } {
  const calls: Array<{ runId: string; requestId: string; response: PermissionResponse }> = [];
  return {
    calls,
    responder: async (input) => {
      calls.push(input);
      return reply;
    },
  };
}

function buildController(options: {
  responder?: PermissionResponder;
  closer?: (runId: string, reason: string) => void;
  onStop?: () => void;
}): RunController {
  return new RunController({
    channel: idleExecutor(options.onStop),
    identity: { name: 'duya-agent-runtime', version: '0.1.0', pid: 4242 },
    protocol: { major: 1, minor: 0 },
    contextFor,
    persistenceFor: () => new NoopPersistence(),
    ...(options.responder ? { permissionResponder: options.responder } : {}),
    ...(options.closer ? { permissionCloser: options.closer } : {}),
  });
}

async function openRun(controller: RunController, runId = 'run-perm') {
  return controller.start(buildManifest(runId), { prompt: 'p', sessionId: 'session-1' });
}

describe('the controller answers a permission through the host decision path', () => {
  it('reaches the real path instead of throwing', async () => {
    // Before R2.4 this threw unconditionally: the runtime could not answer a
    // prompt, so every `ask` became a timeout five minutes later.
    const { responder, calls } = makeResponder();
    const controller = buildController({ responder });
    const handle = await openRun(controller);

    const ack = await handle.respondToPermission('req-1', { action: 'allow' });

    expect(ack).toEqual({ accepted: true });
    expect(calls).toHaveLength(1);
  });

  it('carries the runId the handle was opened with, and the requestId verbatim', async () => {
    // A response that lost its run identity could not be matched to the
    // request it was answering.
    const { responder, calls } = makeResponder();
    const controller = buildController({ responder });
    const handle = await openRun(controller);

    await handle.respondToPermission('req-77', { action: 'deny', reason: 'not this project' });

    expect(calls[0]).toEqual({
      runId: 'run-perm',
      requestId: 'req-77',
      response: { action: 'deny', reason: 'not this project' },
    });
  });

  it('passes an updated input through as data, not as an action', async () => {
    const { responder, calls } = makeResponder();
    const controller = buildController({ responder });
    const handle = await openRun(controller);

    await handle.respondToPermission('req-1', {
      action: 'allow',
      updatedInput: { title: 'edited' },
      userModified: true,
    });

    expect(calls[0].response).toMatchObject({ action: 'allow', userModified: true });
  });

  it('reports a late or duplicate answer from the host instead of throwing', async () => {
    // A late answer is normal, not exceptional: the receipt is the answer.
    const { responder } = makeResponder({ accepted: false, reason: 'permission_expired' });
    const controller = buildController({ responder });
    const handle = await openRun(controller);

    const ack = await handle.respondToPermission('req-1', { action: 'allow' });

    expect(ack).toEqual({ accepted: false, reason: 'permission_expired' });
  });

  it('refuses rather than guessing when the host wired no decision path', async () => {
    // No `throw`, because a caller needs the REASON. And no invented allow:
    // a runtime with no decision path must not authorise a tool call.
    const controller = buildController({});
    const handle = await openRun(controller);

    const ack = await handle.respondToPermission('req-1', { action: 'allow' });

    expect(ack.accepted).toBe(false);
  });

  it('does not advertise a permission deadline it cannot enforce', () => {
    // The capability line and the wired behaviour must agree. A host that
    // renders a countdown for a deadline nobody enforces is the bug
    // `permission_expiry` is gated on.
    const controller = buildController({});
    expect(controller.capabilities.run.permissionExpiryClock).toBe('absent');
    expect(controller.capabilities.permissions.actions).toEqual([
      'allow', 'allow_always', 'deny', 'defer',
    ]);
  });
});

describe('cancel closes the run\'s open permission prompts', () => {
  it('closes pending requests with the reason that is about to be recorded', async () => {
    const closer = vi.fn<(runId: string, reason: string) => void>();
    const controller = buildController({ closer });
    const handle = await openRun(controller);

    await handle.cancel('user', { reason: 'user pressed stop' });

    // Without this a cancelled turn keeps a live prompt, and the answer to it
    // lands on whatever the recycled worker runs next.
    expect(closer).toHaveBeenCalledWith('run-perm', 'run cancelled: user pressed stop');
  });

  it('closes before the stop is issued, so no answer can arrive mid-teardown', async () => {
    const order: string[] = [];
    const controller = buildController({
      closer: () => order.push('close'),
      onStop: () => order.push('stop'),
    });
    const handle = await openRun(controller);

    await handle.cancel('user');

    expect(order).toEqual(['close', 'stop']);
  });

  it('a run with no closer is unaffected: cancel still reports what it did', async () => {
    const controller = buildController({});
    const handle = await openRun(controller);

    const outcome = await handle.cancel('user');

    expect(outcome.requested).toBe(true);
    expect(outcome.applied).toBe(true);
  });
});
