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

// ============================================================================
// D9: which half of the permission lifecycle reaches the durable ledger
// ============================================================================
//
// `permission.resolved` has no producer anywhere in this repository, which is
// why a refused tool call leaves nothing behind (D9). Before implementing one,
// the question that decides the fix's shape is: does the REQUEST already reach
// the run's ledger by another route? If it does, the engine only has to publish
// the resolution and the ledger's pairing rule is satisfied. If it does not, the
// engine must publish BOTH, because `permission_resolved_without_request` will
// otherwise drop the resolution exactly the way `tool.timed_out` is dropped today.
//
// The answer is measured here rather than argued, because the two candidates
// look identical from the outside: `RunController` mints the engine's events and
// the legacy frames through the SAME emitter (`controller.ts:537` builds it,
// `:554` stores it, `observeFrame` at `:832` emits through it), so "same ledger"
// is not something a reader can confirm by looking at either side alone.

describe('the legacy surface reaches the ledger for a REQUEST and not for a resolution (D9)', () => {
  it('mints permission.requested from the legacy frame, carrying the link back to the call', async () => {
    const controller = buildController({});
    await openRun(controller);

    // EXACTLY the production shape, and the shape matters here. The worker sends
    // `sendToMain({ type: 'chat:permission', request: { id, toolName, toolInput,
    // mode, expiresAt } })` and the router normalises it to
    // `{ type: 'permission', data: event.request }`
    // (`worker-frames.ts:98-102`). The translator unwraps `.data` (`payload()`)
    // and reads `requestId` from `requestId ?? id` (`chat-event-translator.ts:455`).
    //
    // So the link from a recorded permission back to the refused tool call rides
    // in `requestId` -- because `worker-process-entry.ts:2317` passes
    // `id: approval.callId`. An earlier version of this test fed a synthetic
    // `toolCallId` and asserted on THAT, which is true of the translator's
    // optional field and false of production, which never sends it.
    const outcome = controller.observeFrame('run-perm', {
      type: 'permission',
      data: {
        id: 'call-1',
        toolName: 'Bash',
        toolInput: { command: 'rm -rf build' },
        mode: 'generic',
        expiresAt: 1_700_000_300_000,
      },
    });

    // It produced a protocol envelope, not a forward-only passthrough.
    expect(outcome.forwardOnly).toBe(false);
    expect(outcome.envelope?.payload.type).toBe('permission.requested');

    // A real seq is the evidence that the LEDGER minted it. An envelope built
    // but never numbered would not satisfy the pairing rule the fix depends on.
    expect(Number.isSafeInteger(outcome.envelope?.seq)).toBe(true);

    // The link back to the refused call, in the field production actually fills.
    const payload = outcome.envelope?.payload as {
      requestId?: string;
      toolName?: string;
      toolCallId?: string;
    };
    expect(payload.requestId).toBe('call-1');
    expect(payload.toolName).toBe('Bash');
    // Pinned because a future fix may reach for the wrong one: nothing in the
    // legacy request carries this, so a `permission.resolved` that links by
    // `toolCallId` would find nothing to link to.
    expect(payload.toolCallId).toBeUndefined();
  });

  it('has no legacy route for a RESOLUTION, which is the gap the event was declared for', async () => {
    const controller = buildController({});
    await openRun(controller);

    // The asymmetry, pinned. The protocol states the reason in its own words at
    // `legacy/sse-event.ts`: "The legacy surface had permission_request and no
    // resolution event, so an answered or timed-out permission left no audit
    // trail." This is the half of that sentence that is still true today.
    const outcome = controller.observeFrame('run-perm', {
      type: 'permission_resolved',
      requestId: 'req-1',
      action: 'deny',
    });

    expect(outcome.envelope).toBeNull();
    expect(outcome.violation).toBeUndefined();
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
