import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { BotInboxStore, BOT_INBOX_MIGRATIONS, BotOutboxStore, BOT_OUTBOX_MIGRATIONS } from '@duya/data';
import { BotChannels, type BotChannelAdapter } from '../src/bot-channels.js';
import { createBotTelegramAdapter } from '../src/bot-telegram-adapter.js';
import { createBotFeishuAdapter } from '../src/bot-feishu-adapter.js';
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
  db.exec('CREATE TABLE runs (id TEXT PRIMARY KEY, terminal TEXT, epoch INTEGER NOT NULL DEFAULT 0)');
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
  const key = `bot-inbox:${accepted.entry.id}`;
  inbox.reserve(key, 'run'); inbox.recordDispatch(accepted.entry.id, key, 'run');
  db.exec("INSERT INTO runs (id,terminal) VALUES ('run',NULL)");
  channels.queueReply(inbox.getById(accepted.entry.id)!, 'run', 0, `${envelope.address.platform}:${envelope.address.chat}`,
    { kind: 'text', content: 'answer' });
  db.exec("UPDATE runs SET terminal = 'completed'");
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

it('does not persist internal credential fields returned by a binding adapter', async () => {
  const channels = runtime({ platform: 'telegram', send: vi.fn() }, { ...target, token: 'vault-secret' } as typeof target);
  const accepted = await channels.acceptInbound('bot', envelope);
  expect(accepted.entry.payloadJson).not.toContain('vault-secret');
});

it('never turns private assistant text into an external reply when SendMessage was not submitted', async () => {
  const send = vi.fn(async () => ({ state: 'delivered' as const, remoteMessageId: 'remote' }));
  const channels = runtime({ platform: 'telegram', send });
  const accepted = await channels.acceptInbound('bot', envelope);
  inbox.claim('bot', 'lease', Date.now() + 60_000);
  const key = `bot-inbox:${accepted.entry.id}`;
  inbox.reserve(key, 'run'); inbox.recordDispatch(accepted.entry.id, key, 'run');
  db.exec("INSERT INTO runs (id,terminal) VALUES ('run','completed')");
  channels.complete(inbox.getById(accepted.entry.id)!, 'run');
  await channels.poll();
  expect(send).not.toHaveBeenCalled();
  expect(outbox.list('owner')[0]).toMatchObject({ status: 'blocked', reason: 'missing_channel_reply', outbound: { kind: 'text', content: '' } });
});

it('fences SendMessage submissions and releases distinct explicit replies only with terminal settlement', async () => {
  const send = vi.fn(async () => ({ state: 'delivered' as const, remoteMessageId: 'remote' }));
  const channels = runtime({ platform: 'telegram', send });
  const accepted = await channels.acceptInbound('bot', envelope);
  inbox.claim('bot', 'lease', Date.now() + 60_000);
  const key = `bot-inbox:${accepted.entry.id}`;
  inbox.reserve(key, 'run'); inbox.recordDispatch(accepted.entry.id, key, 'run');
  db.exec("INSERT INTO runs (id,terminal) VALUES ('run',NULL)");
  const entry = inbox.getById(accepted.entry.id)!;
  const first = channels.queueReply(entry, 'run', 0, 'telegram:123', { kind: 'text', content: 'first' });
  expect(channels.queueReply(entry, 'run', 0, 'telegram:123', { kind: 'text', content: 'first' }).id).toBe(first.id);
  expect(() => channels.queueReply(entry, 'run', 1, 'telegram:123', { kind: 'text', content: 'stale' })).toThrow('attempt_fenced');
  expect(() => channels.queueReply(entry, 'run', 0, 'telegram:other', { kind: 'text', content: 'cross-binding' })).toThrow('binding_rejected');
  channels.queueReply(entry, 'run', 0, 'telegram:123', { kind: 'text', content: 'second' });
  await channels.poll();
  expect(send).not.toHaveBeenCalled();
  db.exec("UPDATE runs SET terminal = 'completed'");
  channels.complete(entry, 'run');
  await channels.poll();
  expect(send.mock.calls.map((call) => call[0].outbound.content)).toEqual(['first', 'second']);
});

it('policy revisions fence queued output without changing inbound event dedup identity', async () => {
  let revision = 'v1';
  const send = vi.fn(async () => ({ state: 'delivered' as const, remoteMessageId: 'remote' }));
  const channels = new BotChannels({ ownerId: 'owner', outbox, runs,
    accept: async (command) => inbox.accept(command),
    resolveTarget: () => ({ ...target, authorizationRevision: revision }), adapters: [{ platform: 'telegram', send }] });
  const accepted = await completed(channels);
  revision = 'v2';
  expect((await channels.acceptInbound('bot', envelope)).entry.id).toBe(accepted.entry.id);
  await channels.poll();
  expect(send).not.toHaveBeenCalled();
  expect(outbox.list('owner')[0]?.status).toBe('blocked');
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
  const request = vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) => new Response(JSON.stringify({ ok: true, result: { message_id: 55 } }), { status: 200 }));
  await completed(runtime(createBotTelegramAdapter({ token: () => 'private-token', fetch: request as typeof fetch })));
  await runtime(createBotTelegramAdapter({ token: () => 'private-token', fetch: request as typeof fetch })).poll();
  expect(outbox.list('owner')[0]).toMatchObject({ status: 'delivered', remoteMessageId: '55' });
  expect(JSON.parse(request.mock.calls[0]![1]!.body as string)).toEqual({ chat_id: '123', text: 'answer' });
  expect(JSON.stringify(outbox.list('owner'))).not.toContain('private-token');
});

it('a second platform uses the same admission, settlement and receipt flow without scheduler changes', async () => {
  const request = vi.fn(async (url: RequestInfo | URL, _init?: RequestInit) => new Response(JSON.stringify(
    String(url).includes('/auth/') ? { code: 0, tenant_access_token: 'private-access-token' }
      : { code: 0, data: { message_id: 'om_reply' } }), { status: 200 }));
  const channels = runtime(createBotFeishuAdapter({ credentials: () => ({ appId: 'private-app', appSecret: 'private-secret' }),
    fetch: request as typeof fetch }), { ...target, platform: 'feishu' });
  const accepted = await channels.acceptInbound('bot', { ...envelope, address: { platform: 'feishu', chat: '123' } });
  inbox.claim('bot', 'lease', Date.now() + 60_000);
  const key = `bot-inbox:${accepted.entry.id}`;
  inbox.reserve(key, 'run'); inbox.recordDispatch(accepted.entry.id, key, 'run');
  db.exec("INSERT INTO runs (id,terminal) VALUES ('run',NULL)");
  channels.queueReply(inbox.getById(accepted.entry.id)!, 'run', 0, 'feishu:123', { kind: 'text', content: 'answer' });
  db.exec("UPDATE runs SET terminal = 'completed'");
  channels.complete(inbox.getById(accepted.entry.id)!, 'run');
  await channels.poll(); await channels.poll();
  expect(request).toHaveBeenCalledTimes(2);
  expect(outbox.list('owner')[0]).toMatchObject({ status: 'delivered', remoteMessageId: 'om_reply' });
  const body = JSON.parse(request.mock.calls[1]![1]!.body as string);
  expect(body).toMatchObject({ receive_id: '123', msg_type: 'text', content: JSON.stringify({ text: 'answer' }) });
  expect(body.uuid).toHaveLength(32);
  expect(JSON.stringify(outbox.list('owner'))).not.toContain('private-');
});

it('Feishu token failures prove not-sent; a lost message response remains unknown', async () => {
  await completed(runtime({ platform: 'telegram', send: async () => ({ state: 'unknown' }) }));
  const delivery = { ...outbox.list('owner')[0]!, target: { ...target, platform: 'feishu' } };
  const tokenFailure = vi.fn(async () => { throw new Error('secret-token'); });
  expect(await createBotFeishuAdapter({ credentials: () => ({ appId: 'app', appSecret: 'secret' }),
    fetch: tokenFailure as typeof fetch }).send(delivery)).toEqual({ state: 'not_sent', reason: 'authorization_unavailable' });
  expect(tokenFailure).toHaveBeenCalledTimes(1);
  const lostResponse = vi.fn(async (url: RequestInfo | URL) => {
    if (String(url).includes('/auth/')) return new Response(JSON.stringify({ code: 0, tenant_access_token: 'token' }));
    throw new Error('secret-token in failed request URL');
  });
  expect(await createBotFeishuAdapter({ credentials: () => ({ appId: 'app', appSecret: 'secret' }),
    fetch: lostResponse as typeof fetch }).send(delivery)).toEqual({ state: 'unknown' });
});
