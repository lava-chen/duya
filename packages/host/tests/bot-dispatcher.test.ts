import Database from 'better-sqlite3';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BOT_INBOX_MIGRATIONS, BOT_SCHEDULER_MIGRATIONS, BotDispatchStore, BotSchedulerStore, RUN_STORE_MIGRATIONS, RunStore } from '@duya/data';
import type { SessionId, StartAgentRunResult } from '@duya/agent-protocol';
import { BotDispatcher, type BotDispatcherOptions } from '../src/bot-dispatcher.js';
import { RunOrchestrator, createWorkerExecutionChannel } from '../src/run-orchestrator.js';
import type { ChatStartCommand } from '../src/run-orchestrator.js';
import { createRunControlPlaneActions } from '../src/run-control-plane.js';

const databases: Database.Database[] = [];
afterEach(() => { for (const db of databases.splice(0)) db.close(); vi.useRealTimers(); });

function harness() {
  const db = new Database(':memory:');
  databases.push(db);
  for (const migration of [...RUN_STORE_MIGRATIONS, ...BOT_INBOX_MIGRATIONS, ...BOT_SCHEDULER_MIGRATIONS]) migration.up(db);
  const store = new BotDispatchStore(db);
  const scheduler = new BotSchedulerStore(db);
  const runs = new RunStore(db);
  const control = createRunControlPlaneActions({ runs });
  const dispatch = vi.fn((_command: ChatStartCommand) => true);
  const logger = { error: vi.fn() };
  const orchestrator = new RunOrchestrator({
    dbRequest: async (action, payload) => control.dispatchControlPlaneAction(action, payload),
    channel: createWorkerExecutionChannel({ dispatch, interrupt: () => null }),
  });
  const execution = {
    async startBotRun(input: Parameters<BotDispatcher['options']['execution']['startBotRun']>[0],
      admission: Parameters<BotDispatcher['options']['execution']['startBotRun']>[1]): Promise<StartAgentRunResult> {
      const result = await orchestrator.openRun(input.sessionId, {
        prompt: input.prompt, options: {}, model: 'test-model', providerId: 'test-provider', workingDirectory: process.cwd(),
      }, admission);
      return result.accepted
        ? { accepted: true, stage: 'dispatched', runId: result.runId as import('@duya/agent-protocol').RunId }
        : { accepted: false, stage: 'refused_run_open_failed', reason: result.reason };
    },
    isRunLive: (id: string) => { const row = runs.getRun(id); return row !== null && orchestrator.ownsRun(id, row.session_id); },
    isSessionBusy: (id: string) => orchestrator.isSessionBusy(id),
    cancelBotRun: async (id: string) => {
      runs.settleRun(id, { status: 'cancelled' }, undefined, 0);
      return true;
    },
  };
  const resolveInput = vi.fn(async (entry: { botId: string; payloadJson: string | null }) => ({
    sessionId: `bot:${entry.botId}` as SessionId,
    prompt: (JSON.parse(entry.payloadJson!) as { prompt: string }).prompt,
  }));
  const options: BotDispatcherOptions = { ownerId: 'owner', store, scheduler: undefined, runs, execution, resolveInput, validateBot: async () => {}, logger };
  const dispatcher = new BotDispatcher(options);
  const accept = (sourceEventId = 'event', botId = 'helper', lane: 'user' | 'agent' | 'background' = 'user') =>
    dispatcher.accept({ ownerId: 'owner', botId, source: 'test', sourceEventId, lane, payloadJson: JSON.stringify({ prompt: sourceEventId }) });
  return { db, store, scheduler, runs, orchestrator, dispatch, execution, options, dispatcher, accept, resolveInput };
}

describe('Bot durable dispatch', () => {
  it('retains a refused unreserved start instead of retrying it forever', async () => {
    const h = harness();
    vi.spyOn(h.execution, 'startBotRun').mockResolvedValue({ accepted: false, stage: 'refused_invalid_input', reason: 'invalid model settings' });
    const accepted = await h.accept();
    await h.dispatcher.tick();
    await h.dispatcher.tick();
    expect(h.dispatcher.get(accepted.entry.id)?.deadLetterReason).toBe('start_refused: refused_invalid_input');
    expect(h.execution.startBotRun).toHaveBeenCalledTimes(1);
    expect(h.dispatcher.hasWork()).toBe(false);
  });

  it('deduplicates input, reserves the Host-minted run and settles only its durable terminal', async () => {
    const h = harness();
    const accepted = await h.accept();
    expect((await h.accept()).entry.id).toBe(accepted.entry.id);
    await h.dispatcher.tick();
    const row = h.dispatcher.get(accepted.entry.id)!;
    const receipt = h.store.inbox.lookupReceipt(row.dispatchKey!)!;
    expect(h.runs.getRun(receipt.runId)?.session_id).toBe('bot:helper');
    expect(h.dispatch).toHaveBeenCalledTimes(1);
    expect(row.status).toBe('dispatched');
    h.runs.settleRun(receipt.runId, { status: 'completed' }, undefined, 0);
    await h.dispatcher.tick();
    expect(h.dispatcher.get(row.id)?.status).toBe('settled');
    expect(h.dispatcher.hasWork()).toBe(false);
  });

  it('reconciles a lost start response without a second execution', async () => {
    const h = harness();
    const start = h.execution.startBotRun;
    vi.spyOn(h.execution, 'startBotRun').mockImplementation(async (...args) => {
      await start(...args);
      throw new Error('response lost after dispatch');
    });
    const accepted = await h.accept();
    await h.dispatcher.tick();
    await h.dispatcher.tick();
    expect(h.dispatch).toHaveBeenCalledTimes(1);
    expect(h.dispatcher.get(accepted.entry.id)?.status).toBe('dispatched');
  });

  it('openRun replays the canonical run even while its first execution is active', async () => {
    const h = harness();
    await h.accept();
    const grant = h.store.claim('owner', 'helper', 'first', Date.now() + 60_000)!;
    const key = `bot-inbox:${grant.entry.id}`;
    const admission = {
      lookup: () => h.store.inbox.lookupReceipt(key),
      reserve: (candidate: string) => h.store.reserve(grant, key, candidate),
      isCurrent: () => h.store.isCurrent(grant),
    };
    const intent = { prompt: 'same', options: {}, model: 'model', workingDirectory: process.cwd() };
    const first = await h.orchestrator.openRun('bot:helper', intent, admission);
    const replay = await h.orchestrator.openRun('bot:helper', intent, admission);
    expect(first.accepted).toBe(true);
    expect(replay).toMatchObject({ accepted: false, runId: first.runId, stage: 'run_already_exists' });
    expect(h.dispatch).toHaveBeenCalledTimes(1);
  });

  it('redrives a background obligation after a durable user preemption', async () => {
    const h = harness();
    h.scheduler.switch('helper', 'host', 0);
    const dispatcher = new BotDispatcher({ ...h.options, ownerId: 'local', scheduler: h.scheduler });
    const background = await dispatcher.accept({
      ownerId: 'local', botId: 'helper', source: 'test', sourceEventId: 'background-event',
      lane: 'background', payloadJson: JSON.stringify({ prompt: 'background-event' }),
    });
    await dispatcher.tick();
    const receipt = h.store.inbox.lookupReceipt(dispatcher.get(background.entry.id)!.dispatchKey!)!;
    h.store.inbox.accept({
      ownerId: 'local', botId: 'helper', source: 'user.message', sourceEventId: 'user-event',
      lane: 'user', payloadJson: JSON.stringify({ prompt: 'new user turn' }),
    });
    h.scheduler.requestPreemption({
      ownerId: 'local', botId: 'helper', sourceInboxId: background.entry.id,
      sourceRunId: receipt.runId, redriveCount: 0,
    });
    await dispatcher.tick();
    await dispatcher.tick();
    const redrive = h.store.outstanding('local').find((entry) => entry.sourceEventId === 'background-event:redrive:1');
    expect(redrive).toMatchObject({ status: 'pending', lane: 'background' });
    expect(JSON.parse(redrive!.payloadJson!) as { prompt: string }).toEqual({ prompt: 'background-event' });
    expect(h.store.inbox.lookupReceipt(`bot-inbox:${background.entry.id}`)?.runId).toBe(receipt.runId);
    expect(h.scheduler.pendingPreemptions('local')).toHaveLength(0);
  });

  it('does not reserve a second input while a session is opening', async () => {
    const h = harness();
    const intent = { prompt: 'same', options: {}, model: 'model', workingDirectory: process.cwd() };
    const first = h.orchestrator.openRun('bot:helper', intent);
    const reserve = vi.fn();
    const second = await h.orchestrator.openRun('bot:helper', intent, { lookup: () => null, reserve, isCurrent: () => true });
    expect(second).toMatchObject({ accepted: false, stage: 'run_active' });
    await first;
    expect(reserve).not.toHaveBeenCalled();
    expect(h.dispatch).toHaveBeenCalledTimes(1);
  });

  it('retains an ambiguous pre-create reservation as recovery_required after restart', async () => {
    const h = harness();
    const accepted = await h.accept();
    const grant = h.store.claim('owner', 'helper', 'crashed', 1)!;
    h.store.inbox.reserve(`bot-inbox:${grant.entry.id}`, 'canonical-reserved-run');
    const restarted = new BotDispatcher(h.options);
    await restarted.tick();
    const row = restarted.get(accepted.entry.id)!;
    expect(row.status).toBe('dead_letter');
    expect(row.deadLetterReason).toContain('recovery_required');
    expect(h.dispatch).not.toHaveBeenCalled();
    expect(h.store.inbox.lookupReceipt(`bot-inbox:${row.id}`)?.runId).toBe('canonical-reserved-run');
  });

  it('repairs a terminal run whose inbox dispatch recording was lost', async () => {
    const h = harness();
    const accepted = await h.accept();
    await h.dispatcher.tick();
    const row = h.dispatcher.get(accepted.entry.id)!;
    const runId = h.store.inbox.lookupReceipt(row.dispatchKey!)!.runId;
    h.runs.settleRun(runId, { status: 'failed', error: { code: 'internal', message: 'worker failed' } }, undefined, 0);
    h.db.prepare("UPDATE bot_inbox SET status = 'claimed', deadline_ms = 1, dispatch_key = NULL WHERE id = ?").run(row.id);
    const restarted = new BotDispatcher({ ...h.options, execution: { ...h.execution, isRunLive: () => false, isSessionBusy: () => false } });
    await restarted.tick();
    expect(restarted.get(row.id)?.status).toBe('settled');
    expect(h.dispatch).toHaveBeenCalledTimes(1);
  });

  it('keeps a stranded running run as recovery_required instead of starting it again', async () => {
    const h = harness();
    const accepted = await h.accept();
    await h.dispatcher.tick();
    const restarted = new BotDispatcher({ ...h.options, execution: { ...h.execution, isRunLive: () => false } });
    await restarted.tick();
    expect(restarted.get(accepted.entry.id)?.deadLetterReason).toContain('recovery_required');
    expect(h.dispatch).toHaveBeenCalledTimes(1);
  });

  it('claims user work before background work and isolates owners and bots', async () => {
    const h = harness();
    await h.accept('background', 'helper', 'background');
    await h.accept('user', 'helper', 'user');
    await h.accept('other-bot', 'other');
    const foreign = h.store.inbox.accept({ ownerId: 'foreign', botId: 'helper', source: 'test', sourceEventId: 'foreign' });
    await h.dispatcher.tick();
    const commands = h.dispatch.mock.calls.map(([command]) => command);
    expect(commands.filter((command) => command.sessionId === 'bot:helper').map((command) => command.prompt)).toEqual(['user']);
    expect(commands.filter((command) => command.sessionId === 'bot:other').map((command) => command.prompt)).toEqual(['other-bot']);
    expect(h.store.inbox.getById(foreign.entry.id)?.status).toBe('pending');
  });

  it('coalesces overlapping polls and refuses scope errors before acceptance', async () => {
    const h = harness();
    await expect(h.dispatcher.accept({ ownerId: 'foreign', botId: 'helper', source: 'x', sourceEventId: 'x', payloadJson: '{}' })).rejects.toThrow('owner mismatch');
    await expect(h.dispatcher.accept({ ownerId: 'owner', botId: 'helper', source: 'x', sourceEventId: 'x', payloadJson: '{}' })).rejects.toThrow('prompt');
    await h.accept();
    const first = h.dispatcher.tick();
    expect(h.dispatcher.tick()).toBe(first);
    await first;
    expect(h.dispatch).toHaveBeenCalledTimes(1);
  });
});

describe('Bot claim fence', () => {
  it('rejects an old holder at reserve, dispatch-record, release and dead-letter', async () => {
    const h = harness();
    await h.accept();
    const old = h.store.claim('owner', 'helper', 'old', 1)!;
    h.store.requeueExpired('owner', Date.now());
    const current = h.store.claim('owner', 'helper', 'new', Date.now() + 60_000)!;
    expect(current.leaseEpoch).toBeGreaterThan(old.leaseEpoch);
    expect(h.store.reserve(old, 'key', 'run')).toBeNull();
    expect(h.store.record(old, 'key', 'run')).toBe(false);
    expect(h.store.release(old, 'key')).toBe(false);
    expect(h.store.deadLetter(old, 'stale')).toBe(false);
    expect(h.store.inbox.getById(old.entry.id)?.leaseOwner).toBe('new');
  });

  it('checks the claim again after run creation and before the execution channel starts', async () => {
    const h = harness();
    const accepted = await h.accept();
    const control = createRunControlPlaneActions({ runs: h.runs });
    const old = h.store.claim('owner', 'helper', 'old', Date.now() + 60_000)!;
    const key = `bot-inbox:${old.entry.id}`;
    const orchestrator = new RunOrchestrator({
      dbRequest: async (action, payload) => {
        const result = await control.dispatchControlPlaneAction(action, payload);
        if (action === 'run:create') {
          h.store.requeueExpired('owner', Date.now() + 120_000);
          h.store.claim('owner', 'helper', 'new', Date.now() + 180_000);
        }
        return result;
      },
      channel: createWorkerExecutionChannel({ dispatch: h.dispatch, interrupt: () => null }),
    });
    const result = await orchestrator.openRun('bot:helper', { prompt: 'hello', options: {}, workingDirectory: process.cwd() }, {
      lookup: () => h.store.inbox.lookupReceipt(key), reserve: (id) => h.store.reserve(old, key, id), isCurrent: () => h.store.isCurrent(old),
    });
    expect(result.accepted).toBe(false);
    expect(h.dispatch).not.toHaveBeenCalled();
    expect(h.store.inbox.getById(accepted.entry.id)?.leaseOwner).toBe('new');
    expect(h.store.record(old, key, result.runId!)).toBe(false);
  });
});
