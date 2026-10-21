import { afterEach, describe, expect, it } from 'vitest';

const existingListeners = new Set(process.listeners('message'));
const { sessionSpawnDb, setDbTransport } = await import('../src/worker-db-client.js');
const { withWorkerDbRunContext } = await import('../src/worker-db-context.js');
const receive = process.listeners('message').find((listener) => !existingListeners.has(listener)) as
  ((message: unknown) => void) | undefined;

afterEach(() => setDbTransport(null));

describe('worker session delegation authority', () => {
  it('preserves the legacy bridge without inventing authority for an unscoped request', async () => {
    const requests: Array<{ execution?: unknown }> = [];
    setDbTransport({ send(request) {
      requests.push(request);
      receive?.({ type: 'db:response', id: request.id, success: true, result: { ok: true } });
    } });

    await expect(sessionSpawnDb.list('claimed-parent')).resolves.toEqual({ ok: true });
    expect(requests).toHaveLength(1);
    expect(requests[0]).not.toHaveProperty('execution');
  });

  it('keeps captured attempts separate across interleaved asynchronous work', async () => {
    const requests: Array<{ execution?: unknown }> = [];
    setDbTransport({ send(request) {
      requests.push(request);
      receive?.({ type: 'db:response', id: request.id, success: true, result: { ok: true } });
    } });
    const previous = { sessionId: 'parent', runId: 'previous', epoch: 0 };
    const replacement = { sessionId: 'parent', runId: 'replacement', epoch: 1 };
    let resume!: () => void;
    const barrier = new Promise<void>((resolve) => { resume = resolve; });
    const late = withWorkerDbRunContext(previous, async () => {
      await barrier;
      await sessionSpawnDb.list('parent');
    });
    await withWorkerDbRunContext(replacement, () => sessionSpawnDb.list('parent'));
    resume();
    await late;
    expect(requests.map((request) => request.execution)).toEqual([replacement, previous]);
    await sessionSpawnDb.list('parent');
    expect(requests[2]).not.toHaveProperty('execution');
  });
});
