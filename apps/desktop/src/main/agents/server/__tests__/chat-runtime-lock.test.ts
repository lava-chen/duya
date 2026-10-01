import { describe, expect, it, vi } from 'vitest';
import {
  acquireChatLock,
  releaseChatLock,
} from '../chat-runtime-lock';

type DbRequest = (
  action: string,
  payload: Record<string, unknown>,
) => Promise<unknown>;

function mockDbRequest(overrides?: Partial<Record<string, unknown>>): {
  dbRequest: DbRequest;
  calls: Array<{ action: string; payload: Record<string, unknown> }>;
} {
  const calls: Array<{ action: string; payload: Record<string, unknown> }> = [];
  const dbRequest: DbRequest = (action, payload) => {
    calls.push({ action, payload });
    const value = overrides?.[action];
    return Promise.resolve(value ?? true);
  };
  return { dbRequest, calls };
}

describe('chat-runtime-lock', () => {
  it('acquire mirrors the session as busy with owner agent-server and a TTL', async () => {
    const { dbRequest, calls } = mockDbRequest();
    await acquireChatLock(dbRequest, 'session-1');
    const acquire = calls.find((c) => c.action === 'lock:acquire')!;
    expect(acquire).toBeDefined();
    expect(acquire.payload).toMatchObject({
      sessionId: 'session-1',
      owner: 'agent-server',
      ttlSec: 300,
    });
    expect(String(acquire.payload.lockId)).toMatch(/^chat:/);
  });

  it('release sends the same lockId that acquire used', async () => {
    const { dbRequest, calls } = mockDbRequest();
    await acquireChatLock(dbRequest, 'session-1');
    const acquire = calls.find((c) => c.action === 'lock:acquire')!;
    const lockId = acquire.payload.lockId as string;

    await releaseChatLock(dbRequest, 'session-1');
    const release = calls.find((c) => c.action === 'lock:release')!;
    expect(release).toBeDefined();
    expect(release.payload).toEqual({
      sessionId: 'session-1',
      lockId,
    });
  });

  it('release without a prior acquire is a silent no-op', async () => {
    const { dbRequest, calls } = mockDbRequest();
    await releaseChatLock(dbRequest, 'never-acquired');
    expect(calls.some((c) => c.action === 'lock:release')).toBe(false);
  });

  it('double release only sends one lock:release', async () => {
    const { dbRequest, calls } = mockDbRequest();
    await acquireChatLock(dbRequest, 'session-1');
    await releaseChatLock(dbRequest, 'session-1');
    await releaseChatLock(dbRequest, 'session-1');
    expect(calls.filter((c) => c.action === 'lock:release')).toHaveLength(1);
  });

  it('a second acquire on the same session after release sends a fresh lockId', async () => {
    const { dbRequest, calls } = mockDbRequest();
    await acquireChatLock(dbRequest, 'session-1');
    await releaseChatLock(dbRequest, 'session-1');
    await acquireChatLock(dbRequest, 'session-1');
    const acquires = calls.filter((c) => c.action === 'lock:acquire');
    expect(acquires).toHaveLength(2);
    expect(acquires[0]!.payload.lockId).not.toBe(acquires[1]!.payload.lockId);
  });

  it('acquire survives a db error (best-effort, never throws)', async () => {
    const dbRequest = vi.fn<DbRequest>().mockRejectedValue(new Error('db down'));
    await expect(acquireChatLock(dbRequest, 'session-1')).resolves.toBeUndefined();
  });

  it('release survives a db error (best-effort)', async () => {
    const dbRequest = vi.fn<DbRequest>().mockRejectedValue(new Error('db down'));
    await acquireChatLock(dbRequest, 'session-1'); // lockId recorded despite failure
    await expect(releaseChatLock(dbRequest, 'session-1')).resolves.toBeUndefined();
  });
});
