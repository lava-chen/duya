/**
 * IPC e2e: db-handlers
 *
 * Exercises the real ipcMain handlers for settings + thread CRUD through
 * the renderer's window.electronAPI surface. Each test gets an isolated
 * userData namespace so the SQLite DB starts fresh.
 *
 * Channels covered:
 *   db:setting:get / set / getJson / setJson
 *   db:session:list / create / get / delete
 */
import { test, expect } from '@playwright/test';
import { launchDuya, closeDuya, invokeApi, type DuyaApp } from '../helpers';

let dua: DuyaApp;

test.afterEach(async () => {
  if (dua) await closeDuya(dua.app);
});

test.describe('settingsDb IPC', () => {
  test('set then get returns the same string value', async () => {
    dua = await launchDuya({ namespace: 'ipc-db-settings' });

    const key = `test-key-${Date.now()}`;
    const value = 'hello-duya';

    await invokeApi(dua.page, 'settingsDb.set', key, value);
    const got = await invokeApi<string>(dua.page, 'settingsDb.get', key);
    expect(got).toBe(value);
  });

  test('getJson returns default when key is absent', async () => {
    dua = await launchDuya({ namespace: 'ipc-db-getjson' });

    const result = await invokeApi<{ count: number }>(
      dua.page,
      'settingsDb.getJson',
      `absent-${Date.now()}`,
      { count: 42 },
    );
    expect(result).toEqual({ count: 42 });
  });

  test('setJson then getJson round-trips an object', async () => {
    dua = await launchDuya({ namespace: 'ipc-db-setjson' });

    const key = `json-key-${Date.now()}`;
    const payload = { name: 'duya', nested: { ok: true }, list: [1, 2, 3] };

    await invokeApi(dua.page, 'settingsDb.setJson', key, payload);
    const got = await invokeApi<typeof payload>(dua.page, 'settingsDb.getJson', key, null);
    expect(got).toEqual(payload);
  });
});

test.describe('thread (db:session) IPC', () => {
  test('create, list, get, delete roundtrip', async () => {
    dua = await launchDuya({ namespace: 'ipc-db-thread' });

    // Start with an empty list (fresh namespace)
    const initialList = await invokeApi<unknown[]>(dua.page, 'thread.list');
    expect(Array.isArray(initialList)).toBe(true);

    // Create a thread — `id` is the only required field
    const threadId = `e2e-${Date.now()}`;
    const created = await invokeApi<{ id: string; title: string }>(
      dua.page,
      'thread.create',
      { id: threadId, title: 'e2e test thread' },
    );
    expect(created).toBeTruthy();
    expect(created.id).toBe(threadId);
    expect(created.title).toBe('e2e test thread');

    // List should now contain the new thread
    const afterCreate = await invokeApi<{ id: string }[]>(dua.page, 'thread.list');
    expect(afterCreate.length).toBe(initialList.length + 1);
    expect(afterCreate.some((t) => t.id === threadId)).toBe(true);

    // Get the thread by id
    const got = await invokeApi<{ id: string; title: string }>(
      dua.page,
      'thread.get',
      threadId,
    );
    expect(got.id).toBe(threadId);
    expect(got.title).toBe('e2e test thread');

    // Delete the thread — returns true if a row was deleted
    const deleted = await invokeApi<boolean>(dua.page, 'thread.delete', threadId);
    expect(deleted).toBe(true);
    const afterDelete = await invokeApi<unknown[]>(dua.page, 'thread.list');
    expect(afterDelete.length).toBe(initialList.length);
  });
});
