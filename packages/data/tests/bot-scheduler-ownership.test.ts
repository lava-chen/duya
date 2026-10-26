import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { BotDispatchTicket } from '@duya/agent-protocol/bot-inbox-api';
import { BotInboxStore } from '../src/bot-inbox';
import { BotDispatchStore } from '../src/bot-dispatch-store';
import { BotSchedulerStore, BOT_SCHEDULER_MIGRATIONS, LOCAL_BOT_OWNER } from '../src/bot-scheduler-store';
import { RunStore, RUN_STORE_MIGRATIONS } from '../src/run-store';

let db: Database.Database;
let dir: string;
let inbox: BotInboxStore;
let dispatch: BotDispatchStore;
let scheduler: BotSchedulerStore;
let runs: RunStore;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'duya-bot-owner-'));
  db = new Database(join(dir, 'core.db'));
  for (const migration of [...RUN_STORE_MIGRATIONS, ...BotInboxStore.migrations, ...BOT_SCHEDULER_MIGRATIONS]
    .sort((a, b) => a.id - b.id)) migration.up(db);
  inbox = new BotInboxStore(db);
  dispatch = new BotDispatchStore(db);
  scheduler = new BotSchedulerStore(db);
  runs = new RunStore(db);
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

function createRun(runId: string, botScheduler?: BotDispatchTicket['scheduler'], ticket?: BotDispatchTicket) {
  return runs.createRun({
    runId, sessionId: 'bot:alpha', manifest: { v: 1 }, manifestHash: 'a'.repeat(64), inputHash: 'b'.repeat(64),
    ...(botScheduler ? { botScheduler } : {}), ...(ticket ? { botDispatchTicket: ticket } : {}),
  });
}

describe('per-Bot scheduler ownership', () => {
  it('defaults to legacy and transfers only with the expected epoch and no active run', () => {
    expect(scheduler.get('alpha')).toEqual({ ownerId: LOCAL_BOT_OWNER, botId: 'alpha', mode: 'legacy', epoch: 0 });
    createRun('legacy-run');
    expect(() => scheduler.switch('alpha', 'host', 0)).toThrow('bot_scheduler_busy');
    runs.completeRun('legacy-run', { status: 'completed' });
    expect(scheduler.switch('alpha', 'host', 0)).toEqual({ ownerId: LOCAL_BOT_OWNER, botId: 'alpha', mode: 'host', epoch: 1 });
    expect(() => scheduler.switch('alpha', 'legacy', 0)).toThrow('bot_scheduler_revision_conflict');
  });

  it('refuses renderer and forged-ticket Runs, then admits only the reserved current input', () => {
    const owner = scheduler.switch('alpha', 'host', 0);
    expect(() => createRun('renderer-run')).toThrow('bot_scheduler_fenced');
    const receipt = inbox.accept({
      ownerId: LOCAL_BOT_OWNER, botId: 'alpha', source: 'user.message', sourceEventId: 'msg-1',
      lane: 'user', payloadJson: JSON.stringify({ prompt: 'hello' }),
    });
    const grant = dispatch.claim(LOCAL_BOT_OWNER, 'alpha', 'lease-1', Date.now() + 30_000)!;
    const ticket: BotDispatchTicket = {
      inboxId: receipt.entry.id, leaseOwner: grant.leaseOwner, leaseEpoch: grant.leaseEpoch, scheduler: owner,
    };
    expect(() => createRun('forged-run', owner, ticket)).toThrow('bot_dispatch_ticket_fenced');
    const reserved = dispatch.reserve(grant, `bot-inbox:${receipt.entry.id}`, 'canonical-run');
    expect(reserved?.state).toBe('fresh');
    expect(createRun('canonical-run', owner, ticket)).toEqual({ state: 'created', runId: 'canonical-run' });
    expect(() => createRun('second-run', { ...owner, epoch: owner.epoch + 1 }, ticket)).toThrow('bot_scheduler_fenced');
  });

  it('blocks ownership transfer while inbox work is pending, claimed, or reserved', () => {
    scheduler.switch('alpha', 'host', 0);
    inbox.accept({ ownerId: LOCAL_BOT_OWNER, botId: 'alpha', source: 'channel', sourceEventId: 'evt-1', payloadJson: '{"prompt":"x"}' });
    expect(() => scheduler.switch('alpha', 'legacy', 1)).toThrow('bot_scheduler_busy');
  });

  it('keeps ownership fenced until a durable preemption intent is reconciled', () => {
    scheduler.switch('alpha', 'host', 0);
    const intent = scheduler.requestPreemption({
      ownerId: LOCAL_BOT_OWNER, botId: 'alpha', sourceInboxId: 'inbox-1', sourceRunId: 'run-1', redriveCount: 0,
    });
    expect(scheduler.pendingPreemptions(LOCAL_BOT_OWNER)).toHaveLength(1);
    expect(() => scheduler.switch('alpha', 'legacy', 1)).toThrow('bot_scheduler_busy');
    expect(scheduler.updatePreemption(intent.id, 'cancel_requested')).toBe(true);
    expect(scheduler.updatePreemption(intent.id, 'redriven', 'inbox-2')).toBe(true);
    expect(scheduler.pendingPreemptions(LOCAL_BOT_OWNER)).toHaveLength(0);
    expect(scheduler.switch('alpha', 'legacy', 1).epoch).toBe(2);
  });
});
