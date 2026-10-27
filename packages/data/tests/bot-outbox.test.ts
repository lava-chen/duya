import Database from 'better-sqlite3';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { BotInboxStore, BOT_INBOX_MIGRATIONS } from '../src/bot-inbox.js';
import { BotOutboxStore, BOT_OUTBOX_MIGRATIONS } from '../src/bot-outbox.js';

let db: Database.Database;
let inbox: BotInboxStore;
let outbox: BotOutboxStore;
const target = { ownerId: 'owner', botId: 'bot', bindingId: 'binding', platform: 'telegram', chatId: '123' };
beforeEach(() => {
  db = new Database(':memory:');
  db.exec('CREATE TABLE runs (id TEXT PRIMARY KEY, terminal TEXT)');
  for (const migration of [...BOT_INBOX_MIGRATIONS, ...BOT_OUTBOX_MIGRATIONS]) migration.up(db);
  inbox = new BotInboxStore(db);
  outbox = new BotOutboxStore(db);
});
afterEach(() => db.close());

function dispatched(terminal: string | null = 'completed') {
  const { entry } = inbox.accept({ ...target, source: 'channel:telegram', sourceEventId: '1',
    payloadJson: JSON.stringify({ channelTarget: target }) });
  inbox.claim('bot', 'lease', Date.now() + 60_000);
  inbox.reserve('dispatch', 'run');
  inbox.recordDispatch(entry.id, 'dispatch', 'run');
  db.prepare('INSERT INTO runs VALUES (?,?)').run('run', terminal);
  return entry;
}

it('commits one immutable delivery and input settlement together on terminal replay', () => {
  const entry = dispatched();
  const first = outbox.completeInput(entry.id, 'run', target, { kind: 'text', content: 'answer' });
  expect(inbox.getById(entry.id)?.status).toBe('settled');
  expect(outbox.completeInput(entry.id, 'run', target, { kind: 'text', content: 'different' })).toEqual(first);
  expect(outbox.list('owner')).toHaveLength(1);
  expect(outbox.list('another-owner')).toEqual([]);
});

it('rolls back settlement when creating the delivery fails', () => {
  const entry = dispatched();
  db.exec("CREATE TRIGGER fail_outbox BEFORE INSERT ON bot_outbox BEGIN SELECT RAISE(ABORT, 'disk_failure'); END");
  expect(() => outbox.completeInput(entry.id, 'run', target, { kind: 'text', content: 'answer' })).toThrow('disk_failure');
  expect(inbox.getById(entry.id)?.status).toBe('dispatched');
  expect(outbox.list('owner')).toEqual([]);
});

it('refuses live Runs, wrong Runs and cross-binding identities', () => {
  const entry = dispatched(null);
  const complete = (run = 'run', bindingId = 'binding') => outbox.completeInput(entry.id, run,
    { ...target, bindingId }, { kind: 'text', content: 'answer' });
  expect(() => complete()).toThrow('identity_conflict');
  db.exec("UPDATE runs SET terminal = 'completed'");
  expect(() => complete('another')).toThrow('identity_conflict');
  expect(() => complete('run', 'other-binding')).toThrow('identity_conflict');
  expect(inbox.getById(entry.id)?.status).toBe('dispatched');
});

it('fences a late acknowledgement and never reclaims an interrupted send', () => {
  const entry = dispatched();
  const row = outbox.completeInput(entry.id, 'run', target, { kind: 'text', content: 'answer' });
  const grant = outbox.claim(row.id, 200, 100)!;
  expect(outbox.claim(row.id, 200, 100)).toBeNull();
  outbox.recoverExpired('owner', 201);
  expect(outbox.record(grant, { state: 'delivered', remoteMessageId: 'remote' }, 202)).toBe(false);
  expect(outbox.get(row.id)?.status).toBe('unknown');
  expect(outbox.claim(row.id, 400, 300)).toBeNull();
  expect(outbox.reconcile(row.id, grant.leaseEpoch + 1, { state: 'delivered', remoteMessageId: 'remote' })).toBe(false);
  expect(outbox.reconcile(row.id, grant.leaseEpoch, { state: 'delivered', remoteMessageId: 'remote' })).toBe(true);
});

it('records failed Runs as blocked obligations and strips extra credential properties', () => {
  const entry = dispatched('failed');
  const row = outbox.completeInput(entry.id, 'run', { ...target, token: 'secret-token' } as typeof target,
    { kind: 'text', content: 'partial', token: 'secret-token' } as { kind: 'text'; content: string });
  expect(row.status).toBe('blocked');
  expect(JSON.stringify(row)).not.toContain('secret-token');
  expect(inbox.getById(entry.id)?.status).toBe('settled');
});
