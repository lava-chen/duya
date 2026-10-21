import { afterEach, describe, expect, it, vi } from 'vitest';
import type { HostPermissionRequest, HostPermissionRequestApiV1 } from '@duya/agent-protocol';
import { WorkerPermissionRequests } from '../src/worker-permission-requests.js';

function fixture() {
  const requests = new Map<string, HostPermissionRequest>();
  const records: HostPermissionRequestApiV1 = {
    async createPermissionRequest(input) {
      const request: HostPermissionRequest = { ...input, sessionId: input.sessionId ?? null,
        toolInput: input.toolInput ?? null, status: 'pending', decision: null, message: null,
        updatedPermissions: null, updatedInput: null, createdAt: Date.now(), resolvedAt: null };
      requests.set(input.id, request);
      return request;
    },
    async getPermissionRequest(id) { return requests.get(id) ?? null; },
    async listPendingPermissionRequests() { return [...requests.values()].filter((p) => p.status === 'pending'); },
    async resolvePermissionRequest(id, input) {
      const old = requests.get(id);
      if (old === undefined) return null;
      const request = { ...old, ...input, resolvedAt: Date.now() };
      requests.set(id, request);
      return request;
    },
  };
  let live = true;
  const send = vi.fn(() => true);
  const broker = new WorkerPermissionRequests(records, send, () => live);
  const request = () => broker.request('s', 'r', { id: 'p', toolName: 'bash', toolInput: { command: 'echo ok' }, expiresAt: Date.now() + 1000 });
  return { broker, send, request, requests, stop: () => { live = false; } };
}

describe('worker permission lifecycle', () => {
  afterEach(() => vi.useRealTimers());
  it('expires with a denial and never grants a late reply', async () => {
    vi.useFakeTimers();
    const f = fixture();
    await f.request();
    await vi.advanceTimersByTimeAsync(1001);
    expect(f.requests.get('p')?.status).toBe('timeout');
    expect(f.send).toHaveBeenCalledWith('s', expect.objectContaining({ decision: 'deny' }));
    expect(await f.broker.resolvePermissionRequest('p', { status: 'allow' })).toBeNull();
  });
  it('aborts pending requests on cancellation', async () => {
    const f = fixture();
    await f.request();
    await f.broker.closeSession('s');
    expect(f.requests.get('p')?.status).toBe('aborted');
    expect(f.send).toHaveBeenCalledWith('s', expect.objectContaining({ decision: 'deny' }));
    expect(await f.broker.listPendingPermissionRequests()).toEqual([]);
  });
  it('rejects an approval for a run that is no longer live', async () => {
    const f = fixture();
    await f.request();
    f.stop();
    await f.broker.resolvePermissionRequest('p', { status: 'allow', decision: 'allow_for_session' });
    expect(f.requests.get('p')?.status).toBe('aborted');
    expect(f.send).not.toHaveBeenCalled();
  });
  it('delivers answers and session grants once under concurrent replies', async () => {
    const f = fixture();
    await f.request();
    const results = await Promise.all([1, 2].map(() => f.broker.resolvePermissionRequest('p', {
      status: 'allow', decision: 'allow_for_session', updatedInput: { answers: { choice: 'yes' } },
    })));
    expect(results.filter((r) => r !== null)).toHaveLength(1);
    expect(f.send).toHaveBeenCalledTimes(1);
    expect(f.send).toHaveBeenCalledWith('s', expect.objectContaining({
      decision: 'allow_for_session', updatedInput: { answers: { choice: 'yes' } },
    }));
  });
});
