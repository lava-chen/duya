/**
 * The Runtime Session service.
 *
 * The cases below are about the ORDER and the OUTCOME vocabulary, not about
 * any particular Host. That is what makes the service testable at all: the
 * Host's storage, its control plane and its workers are exactly the things
 * the service is not allowed to know.
 */

import { describe, expect, it, vi } from 'vitest';
import {
  createRuntimeSessionService,
  SessionExecutionUnavailableError,
  type SessionAdmissionOutcome,
  type SessionRunRequest,
} from '../src/session/index.js';

function request(): SessionRunRequest {
  return {
    sessionId: 'session-1',
    workspace: { workspaceId: 'workspace-1', rootId: 'root-1', relativePath: 'src' },
    prompt: 'hello',
    requestId: 'request-1',
  };
}

describe('createRuntimeSessionService', () => {
  it('reports an admitted run with the identity the Host froze', async () => {
    const outcome: SessionAdmissionOutcome = {
      state: 'admitted',
      identity: { runId: 'run-1', manifestHash: 'hash-1' },
    };
    const admit = vi.fn(async () => outcome);
    const service = createRuntimeSessionService({ admission: { admit } });

    await expect(service.startRun(request())).resolves.toEqual(outcome);
    expect(admit).toHaveBeenCalledTimes(1);
  });

  it('keeps a policy refusal distinct from a transport failure', async () => {
    // The two lead to different next steps — retry or report — so a service
    // that flattened them into one answer would make the caller guess.
    const rejected = createRuntimeSessionService({
      admission: { admit: async () => ({ state: 'rejected', reason: 'session is busy' }) },
    });
    const failed = createRuntimeSessionService({
      admission: { admit: async () => ({ state: 'failed', reason: 'host unreachable' }) },
    });

    await expect(rejected.startRun(request())).resolves.toEqual({
      state: 'rejected',
      reason: 'session is busy',
    });
    await expect(failed.startRun(request())).resolves.toEqual({
      state: 'failed',
      reason: 'host unreachable',
    });
  });

  it('refuses to cancel when the host has no execution surface', async () => {
    // An empty implementation would return "cancelled" for a cancellation
    // that never happened. The failure has to be loud instead.
    const service = createRuntimeSessionService({
      admission: { admit: async () => ({ state: 'admitted', identity: { runId: 'r', manifestHash: 'h' } }) },
    });

    await expect(service.cancelRun('run-1')).rejects.toBeInstanceOf(SessionExecutionUnavailableError);
  });

  it('forwards a cancellation to the execution port when there is one', async () => {
    const cancel = vi.fn(async () => true);
    const service = createRuntimeSessionService({
      admission: { admit: async () => ({ state: 'admitted', identity: { runId: 'r', manifestHash: 'h' } }) },
      execution: { cancel },
    });

    await expect(service.cancelRun('run-1', 'user asked')).resolves.toBe(true);
    expect(cancel).toHaveBeenCalledWith('run-1', 'user asked');
  });

  it('restores history through the same ports the caller supplies', async () => {
    const service = createRuntimeSessionService({
      admission: { admit: async () => ({ state: 'admitted', identity: { runId: 'r', manifestHash: 'h' } }) },
    });

    const result = await service.restoreHistory('session-1', {
      load: async () => ({ messages: [{ id: 'message-1' }] }),
      loadAttachments: () => new Map(),
      toMessage: (row) => ({ id: row.id, body: 'text' }),
      validate: (messages) => messages,
      messageId: (message) => message.id,
      replace: async () => ({ success: true }),
      checkpointIdSuffix: ':checkpoint',
    });

    expect(result.messages).toEqual([{ id: 'message-1', body: 'text' }]);
    expect(result.repairAttempted).toBe(false);
  });
});
