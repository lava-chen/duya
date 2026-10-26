import { test, expect } from '@playwright/test';
import { launchDuya, closeDuya, invokeApi, type DuyaApp } from '../helpers';
interface DeliveryProjection {
  id: string;
  status: string;
  attempt: number;
  outbound: { kind: string; content: string };
}

let instance: DuyaApp | undefined;
test.afterEach(async () => { if (instance) await closeDuya(instance.app); instance = undefined; });

test('delivery IPC reads durable unknown receipts without retrying or crossing Bot scope', async () => {
  instance = await launchDuya({ namespace: `ipc-bot-delivery-s4-${Date.now()}` });
  const a = await invokeApi<{ id: string }>(instance.page, 'configAgents.create', 'delivery-a', { name: 'Delivery A' });
  const b = await invokeApi<{ id: string }>(instance.page, 'configAgents.create', 'delivery-b', { name: 'Delivery B' });
  await expect.poll(async () => {
    try { return (await invokeApi<DeliveryProjection[]>(instance!.page, 'botTurn.listDeliveries', { botId: a.id })).length; }
    catch { return -1; }
  }).toBe(0);

  // Seed a lost-send fixture in the actual migrated Desktop database.
  await instance.app.evaluate(({ app }, botId) => {
    const requireFromApp = process.getBuiltinModule('node:module').createRequire(`${process.cwd()}/package.json`);
    const path = requireFromApp('node:path');
    const Database = requireFromApp('better-sqlite3');
    const db = new Database(path.join(app.getPath('userData'), 'databases', 'duya-core.db'));
    try {
      const target = { ownerId: 'local', botId, bindingId: 'fixture-binding', platform: 'telegram', chatId: 'fixture-chat' };
      db.prepare(`INSERT INTO bot_outbox
        (id,inbox_id,run_id,owner_id,bot_id,target_json,outbound_json,status,attempt,lease_epoch,reason,created_ms)
        VALUES (?,?,?,?,?,?,?,'unknown',1,1,'send_interrupted',?)`).run('fixture-delivery',
        'fixture-inbox', 'fixture-run', 'local', botId, JSON.stringify(target),
        JSON.stringify({ kind: 'text', content: 'durable fixture reply' }), Date.now());
    } finally { db.close(); }
  }, a.id);

  for (let i = 0; i < 2; i++) {
    const rows = await invokeApi<DeliveryProjection[]>(instance.page, 'botTurn.listDeliveries', { botId: a.id });
    expect(rows).toEqual([expect.objectContaining({ id: 'fixture-delivery', status: 'unknown', attempt: 1,
      outbound: { kind: 'text', content: 'durable fixture reply' } })]);
  }
  expect(await invokeApi(instance.page, 'botTurn.listDeliveries', { botId: b.id })).toEqual([]);
});
