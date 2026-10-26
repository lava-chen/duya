import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { BotInboxStore, BOT_INBOX_MIGRATIONS, BotOutboxStore, BOT_OUTBOX_MIGRATIONS } from '@duya/data';
import { BotChannels, type BotChannelAdapter } from '../src/bot-channels.js';
import { createBotTelegramAdapter } from '../src/bot-telegram-adapter.js';
import type { ChannelInboundEnvelope } from '@duya/agent-protocol/channels';
import type { RunRepository } from '../src/repository-port.js';

let db: Database.Database;
let inbox: BotInboxStore;
let outbox: BotOutboxStore;
let dir: string;
const target = { ownerId: 'owner', botId: 'bot', bindingId: 'binding', platform: 'telegram', chatId: '123' };
const envelope: ChannelInboundEnvelope = { sourceEventId: '12', address: { platform: 'telegram', chat: '123' },
  sender: 'external', text: 'hello', reaction: null };
const runs: Pick<RunRepository, 'listEvents'> = {
  listEvents: () => [{ run_id: 'run', seq: 1, epoch: 0, event_type: 'assistant.text_block', created_at: 1,
    envelope_json: JSON.stringify({ payload: { type: 'assistant.text_block', messageId: 'msg', text: 'answer' } }) }],
};
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'duya-s4-channel-'));
  db = new Database(join(dir, 'core.db'));
  db.exec('CREATE TABLE runs (id TEXT PRIMARY KEY, terminal TEXT)');
  for (const m of [...BOT_INBOX_MIGRATIONS, ...BOT_OUTBOX_MIGRATIONS]) m.up(db);
  inbox = new BotInboxStore(db); outbox = new BotOutboxStore(db);
});
afterEach(() => { db.close(); rmSync(dir, { recursive: true, force: true }); });
function runtime(adapter: BotChannelAdapter, binding = target) {
  return new BotChannels({ ownerId: 'owner', outbox, runs,
    accept: async (command) => inbox.accept(command),
    resolveTarget: () => binding, adapters: [adapter] });
}
async function completed(channels: BotChannels) {
  const accepted = await channels.acceptInbound('bot', envelope);
  inbox.claim('bot', 'lease', Date.now() + 60_000);
  inbox.reserve('dispatch', 'run'); inbox.recordDispatch(accepted.entry.id, 'dispatch', 'run');
  db.exec("INSERT INTO runs VALUES ('run','completed')");
  channels.complete(inbox.getById(accepted.entry.id)!, 'run');
  return accepted;
}

it('replays inbound to the same durable receipt and rejects cross-Bot and cross-chat routing', async () => {
  const channels = runtime({ platform: 'telegram', send: vi.fn() });
  const a = await channels.acceptInbound('bot', envelope);
  expect((await channels.acceptInbound('bot', envelope)).entry.id).toBe(a.entry.id);
  await expect(channels.acceptInbound('other', envelope)).rejects.toThrow('binding_rejected');
  await expect(channels.acceptInbound('bot', { ...envelope, address: { platform: 'telegram', chat: 'other' } })).rejects.toThrow('binding_rejected');
  await expect(channels.acceptInbound('bot', { ...envelope, sourceEventId: undefined })).rejects.toThrow('invalid_channel_event');
});

it('a real DB reopen redrives an unsent terminal obligation exactly once', async () => {
  const send = vi.fn(async () => ({ state: 'delivered' as const, remoteMessageId: 'remote-1' }));
  await completed(runtime({ platform: 'telegram', send }));
  db.close(); db = new Database(join(dir, 'core.db'));
  inbox = new BotInboxStore(db); outbox = new BotOutboxStore(db);
  const restarted = runtime({ platform: 'telegram', send });
  await restarted.poll(); await restarted.poll();
  expect(send).toHaveBeenCalledTimes(1);
  expect(outbox.list('owner')[0]).toMatchObject({ status: 'delivered', remoteMessageId: 'remote-1' });
});

it('a successful remote send followed by connection loss stays unknown across restart and poll', async () => {
  const send = vi.fn(async () => { throw new Error('token-secret in transport error'); });
  await completed(runtime({ platform: 'telegram', send }));
  await runtime({ platform: 'telegram', send }).poll();
  await runtime({ platform: 'telegram', send }).poll();
  expect(send).toHaveBeenCalledTimes(1);
  expect(outbox.list('owner')[0]?.status).toBe('unknown');
  expect(JSON.stringify(outbox.list('owner'))).not.toContain('token-secret');
});

it('revocation prevents network calls, and provider evidence can reconcile unknown', async () => {
  const send = vi.fn(async () => ({ state: 'unknown' as const }));
  await completed(runtime({ platform: 'telegram', send }));
  await runtime({ platform: 'telegram', send }, { ...target, bindingId: 'rebound' }).poll();
  expect(send).not.toHaveBeenCalled();
  expect(outbox.list('owner')[0]?.status).toBe('blocked');
});

it('the Telegram adapter validates receipt bodies and sanitizes failures', async () => {
  const request = vi.fn(async () => new Response(JSON.stringify({ ok: true, result: { message_id: 55 } }), { status: 200 }));
  await completed(runtime(createBotTelegramAdapter({ token: () => 'private-token', fetch: request as typeof fetch })));
  await runtime(createBotTelegramAdapter({ token: () => 'private-token', fetch: request as typeof fetch })).poll();
  expect(outbox.list('owner')[0]).toMatchObject({ status: 'delivered', remoteMessageId: '55' });
  expect(JSON.parse(request.mock.calls[0]![1]!.body as string)).toEqual({ chat_id: '123', text: 'answer' });
  expect(JSON.stringify(outbox.list('owner'))).not.toContain('private-token');
});
