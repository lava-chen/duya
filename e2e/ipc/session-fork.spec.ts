/**
 * IPC e2e: session fork (Plan 506 B1 + Plan 582 G3).
 *
 * This file exists because of a channel-name stranding. `preload.ts` invoked
 * `db:session:forkAt` while the handler was registered as `session:forkAt`, so
 * every call rejected with `No handler registered` — the fork feature had
 * never been reachable, despite the core logic being complete and unit-tested
 * against real stores.
 *
 * The unit tests in `electron/db/core/__tests__/session-fork.test.ts` call
 * `forkSession()` directly, so by construction they can never see a channel
 * name. Only a real bridge can. That is the same lesson as
 * `session-archive.spec.ts`, which caught the `db:session:unarchive` variant
 * of this exact bug.
 *
 * `electron/ipc/__tests__/ipc-channel-contract.test.ts` now guards the class
 * statically; this file guards the behaviour.
 */
import { test, expect } from '@playwright/test';
import { launchDuya, closeDuya, invokeApi, type DuyaApp } from '../helpers';

let dua: DuyaApp;

interface ForkResult {
  ok: boolean;
  reason?: 'source_not_found' | 'message_not_found' | 'source_archived';
  sessionId?: string;
  seedCount?: number;
}

/** A `db:session:get` row. */
interface SessionRow {
  id: string;
  title: string;
  status: string;
  parent_id: string | null;
}

/** A `db:message:getBySession` row, reduced to what this file asserts on. */
interface MessageRow {
  id: string;
  content: string;
}

async function createSession(id: string, title: string): Promise<void> {
  await invokeApi(dua.page, 'thread.create', { id, title });
}

/**
 * `db:message:add` takes ONE object with snake_case keys, and its id becomes
 * the message id the fork point is addressed by.
 */
async function appendMessage(sessionId: string, id: string, content: string): Promise<void> {
  await invokeApi(dua.page, 'message.add', {
    id,
    session_id: sessionId,
    role: 'user',
    content,
  });
}

async function messagesOf(sessionId: string): Promise<MessageRow[]> {
  const rows = await invokeApi<MessageRow[]>(dua.page, 'message.getBySession', sessionId);
  return rows.map((r) => ({ id: r.id, content: r.content }));
}

async function sessionOf(id: string): Promise<SessionRow> {
  return invokeApi<SessionRow>(dua.page, 'thread.get', id);
}

/** The core stores are opened lazily; a too-early call gets a rejected invoke. */
async function waitForCoreStores(): Promise<void> {
  const deadline = Date.now() + 30_000;
  for (;;) {
    try {
      await invokeApi(dua.page, 'thread.list');
      return;
    } catch (err) {
      if (Date.now() > deadline) throw err;
      await dua.page.waitForTimeout(200);
    }
  }
}

test.describe('session fork (Plan 506 B1 / 582 G3)', () => {
  test.beforeAll(async () => {
    dua = await launchDuya({ namespace: 'ipc-fork' });
    await waitForCoreStores();
  });

  test.afterAll(async () => {
    if (dua) await closeDuya(dua.app);
  });

  test('the fork channel resolves over the real bridge', async () => {
    // The regression itself. Before the rename this rejected with
    // "No handler registered for 'db:session:forkAt'"; the assertion is that we
    // get a structured refusal instead of an invoke error.
    const source = `fork-reach-${Date.now()}`;
    await createSession(source, 'fork reachability');
    await appendMessage(source, `${source}-m1`, 'hello');

    const result = await invokeApi<ForkResult>(dua.page, 'session.forkAt', {
      sourceSessionId: source,
      // A non-existent fork point is the cheapest way to prove the channel
      // resolved: `ok: false` comes FROM the handler, not from the bridge.
      throughMessageId: 'no-such-message',
    });

    expect(result.reason).toBe('message_not_found');
  });

  test('forks the timeline up to and including the chosen message', async () => {
    const stamp = Date.now();
    const source = `fork-seed-${stamp}`;
    await createSession(source, 'fork seed source');
    await appendMessage(source, `${source}-m1`, 'first');
    await appendMessage(source, `${source}-m2`, 'second — the fork point');
    await appendMessage(source, `${source}-m3`, 'third — after the fork');

    const before = await messagesOf(source);
    expect(before.map((m) => m.content)).toEqual(['first', 'second — the fork point', 'third — after the fork']);

    const result = await invokeApi<ForkResult>(dua.page, 'session.forkAt', {
      sourceSessionId: source,
      throughMessageId: `${source}-m2`,
      title: 'forked branch',
    });

    expect(result.ok).toBe(true);
    expect(result.seedCount).toBe(2);
    expect(result.sessionId).toBeTruthy();

    // The fork carries the prefix INCLUDING the fork point, and nothing after.
    const seeded = await messagesOf(result.sessionId!);
    expect(seeded.map((m) => m.content)).toEqual(['first', 'second — the fork point']);

    // `message_index.id` is a GLOBAL primary key, so the seed must NOT reuse
    // the source ids. Reusing them is what makes a fork silently overwrite the
    // original history.
    const sourceIds = new Set(before.map((m) => m.id));
    for (const m of seeded) {
      expect(sourceIds.has(m.id)).toBe(false);
    }

    // Lineage: the fork records where it came from.
    const forked = await sessionOf(result.sessionId!);
    expect(forked.parent_id).toBe(source);
    expect(forked.status).toBe('active');

    // The source is untouched.
    const after = await messagesOf(source);
    expect(after.map((m) => m.content)).toEqual(before.map((m) => m.content));
  });

  test('refuses a missing source and leaves nothing behind', async () => {
    const result = await invokeApi<ForkResult>(dua.page, 'session.forkAt', {
      sourceSessionId: `ghost-${Date.now()}`,
      throughMessageId: 'whatever',
    });

    expect(result.ok).toBe(false);
    expect(result.reason).toBe('source_not_found');
    expect(result.sessionId).toBeUndefined();
  });

  test('G3: refuses to fork an archived source', async () => {
    // Plan 582 closed the hole where an archived session could still be forked
    // and thereby re-materialised as a live session. The refusal has to hold
    // over the real bridge, not just in the unit test.
    const stamp = Date.now();
    const source = `fork-archived-${stamp}`;
    await createSession(source, 'archived fork source');
    await appendMessage(source, `${source}-m1`, 'history behind the archive');

    const archived = await invokeApi<{ ok: boolean }>(dua.page, 'session.archive', source);
    expect(archived.ok).toBe(true);

    const result = await invokeApi<ForkResult>(dua.page, 'session.forkAt', {
      sourceSessionId: source,
      throughMessageId: `${source}-m1`,
    });

    expect(result.ok).toBe(false);
    expect(result.reason).toBe('source_archived');
    expect(result.sessionId).toBeUndefined();
  });
});
