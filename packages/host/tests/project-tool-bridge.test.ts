import { describe, expect, it, vi } from 'vitest';
import type { MainDatabase } from '@duya/data/main-database';
import type { MainSettingsStore } from '@duya/data/main-settings-store';
import type { SessionStore } from '@duya/data/session-store';
import type { RunRepository } from '../src/repository-port.js';
import { createHostWorkerDbBridge, WorkerDbBridgeError } from '../src/worker-db-bridge.js';
import type { ProjectToolService } from '../src/project/tool-service.js';

function bridge(projectToolApi?: ProjectToolService) {
  return createHostWorkerDbBridge({
    runs: {} as RunRepository,
    sessions: {} as SessionStore,
    settings: {} as MainSettingsStore,
    mainDatabase: { db: {} } as MainDatabase,
    ...(projectToolApi === undefined ? {} : { projectToolApi }),
  });
}

describe('the standalone Host project tool domain', () => {
  it('reads prompt context using only trusted attempt identity', async () => {
    const getSessionContext = vi.fn(async () => null);
    const hostBridge = bridge({ dispatch: vi.fn(), getSessionContext });
    await hostBridge.dispatch('project:session-context', { sessionId: 'forged', projectId: 'other' }, { sessionId: 'work-1', runId: 'run-1', epoch: 0 });
    expect(getSessionContext).toHaveBeenCalledWith('work-1');
    await expect(hostBridge.dispatch('project:session-context', { sessionId: 'work-1' })).rejects.toMatchObject({ code: 'invalid_payload' });
    expect(getSessionContext).toHaveBeenCalledTimes(1);
  });
  it('serves the tool from the trusted caller, not the payload', async () => {
    const dispatch = vi.fn(async () => ({ ok: true as const, snapshot: undefined }));
    const hostBridge = bridge({ dispatch, getSessionContext: vi.fn(async () => null) });

    const result = await hostBridge.dispatch(
      'project:tool',
      { action: 'get', payload: { limit: 5 } },
      { sessionId: 'coordinator-1', runId: 'run-1', epoch: 0 },
    );

    expect(dispatch).toHaveBeenCalledWith({
      action: 'get',
      payload: { limit: 5 },
      callerSessionId: 'coordinator-1',
    });
    expect(result).toEqual({ ok: true, snapshot: undefined });
  });

  it('refuses without a trusted caller', async () => {
    const dispatch = vi.fn();
    const hostBridge = bridge({ dispatch, getSessionContext: vi.fn(async () => null) });

    await expect(hostBridge.dispatch('project:tool', { action: 'get' }))
      .rejects.toMatchObject<Partial<WorkerDbBridgeError>>({ code: 'invalid_payload' });
    expect(dispatch).not.toHaveBeenCalled();
  });

  it('fails fast when the Host did not compose the project tool service', async () => {
    const hostBridge = bridge();

    await expect(hostBridge.dispatch('project:tool', { action: 'get' }, {
      sessionId: 'coordinator-1',
      runId: 'run-1',
      epoch: 0,
    })).rejects.toMatchObject<Partial<WorkerDbBridgeError>>({ code: 'unimplemented_domain' });
  });
});
