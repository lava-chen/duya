import { describe, expect, it } from 'vitest';
import type { RunManifest } from '@duya/agent-protocol';
import { verifyRunManifestBinding } from '@duya/agent-core/run-manifest-verification';

const { RunOrchestrator, createWorkerExecutionChannel } = await import('../../src/run-orchestrator.js');
const { writeRunReceiptOnWire } = await import('../../src/run-receipt.js');

interface DispatchedStart {
  readonly sessionId: string;
  readonly prompt: string;
  readonly options: Readonly<Record<string, unknown>>;
  readonly manifest: RunManifest;
  readonly manifestHash: string;
  readonly inputRevision: string;
}

describe('worker input binding', () => {
  it('dispatches manifest budget options that verify and still rejects option tampering', async () => {
    let command: DispatchedStart | undefined;
    const orchestrator = new RunOrchestrator({
      dbRequest: async (action, payload) => {
        const runId = String(payload['runId'] ?? '');
        if (action === 'run:create') return writeRunReceiptOnWire({ state: 'created', runId });
        if (action === 'run:append') {
          const events = payload['events'];
          return writeRunReceiptOnWire(
            { state: 'applied', runId },
            { written: Array.isArray(events) ? events.length : 0 },
          );
        }
        if (action === 'run:complete') {
          return writeRunReceiptOnWire({ state: 'applied', runId }, { applied: true });
        }
        return { ok: false, state: 'invalid', runId, reason: `unexpected action ${action}` };
      },
      nativeWriter: {
        currentEpoch: () => 0,
        append: (_runId, envelopes) => ({ state: 'written', written: envelopes.length }),
      },
      channel: createWorkerExecutionChannel({
        dispatch: (received) => {
          command = received;
          return true;
        },
        interrupt: () => null,
      }),
    });

    const accepted = await orchestrator.openRun('session-binding', {
      prompt: 'answer the question',
      options: { language: 'zh' },
      workingDirectory: process.cwd(),
      model: 'test-model',
      providerId: 'test-provider',
      maxTurns: 3,
    });

    expect(accepted.accepted).toBe(true);
    expect(command).toBeDefined();
    const dispatched = command;
    if (dispatched === undefined) throw new Error('openRun did not dispatch chat:start');
    expect(dispatched.options['maxTurns']).toBe(3);

    const worker = { available: [], catalogRevision: 'test', manifestVersion: 1 } as const;
    const binding = {
      manifest: dispatched.manifest,
      manifestHash: dispatched.manifestHash,
      inputRevision: dispatched.inputRevision,
      worker,
    };
    const received = {
      sessionId: dispatched.sessionId,
      prompt: dispatched.prompt,
      options: dispatched.options,
    };
    expect(verifyRunManifestBinding({ ...binding, received }).ok).toBe(true);

    const tampered = {
      ...received,
      options: { ...received.options, language: 'en' },
    };
    expect(verifyRunManifestBinding({ ...binding, received: tampered })).toMatchObject({
      ok: false,
      code: 'input_binding_mismatch',
    });
  });
});
