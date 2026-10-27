/**
 * Bot inbox + dispatch receipt storage contract (framework plan S3a).
 *
 * Every case pins one clause of the S3a contract: accept idempotency by the
 * composed dedup key, claim CAS with lane precedence, the reserve
 * three-state where a later candidate run id is discarded, recordDispatch's
 * replay/conflict split, the terminal transitions, the mechanical expiry
 * requeue, and the legacy pending-wakes import that never overwrites and
 * never fabricates a user message. What is NOT proven here is any Host
 * scheduling behavior — S3b owns that; this file only fixes what the data
 * layer promises under it.
 */

import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  BOT_INBOX_MIGRATIONS,
  BotInboxDispatchConflictError,
  BotInboxStore,
  composeBotInboxDedupKey,
  composeLegacyDedupKey,
} from '../src/bot-inbox.js';
import { collectCoreDataMigrations } from '../src/core-stores.js';
import type { PendingWakeRow } from '../src/pending-wakes.js';

let db: Database.Database;
let store: BotInboxStore;
let dir: string;

const PAST_DEADLINE = 1_000;
const FUTURE_DEADLINE = Date.now() + 60_000;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'duya-bot-inbox-'));
  db = new Database(join(dir, 'core.db'));
  for (const migration of [...BOT_INBOX_MIGRATIONS].sort((a, b) => a.id - b.id)) {
    migration.up(db);
  }
  store = new BotInboxStore(db);
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

interface AcceptOverrides {
  ownerId?: string;
  botId?: string;
  source?: string;
  sourceEventId?: string;
  bindingId?: string | null;
  lane?: 'user' | 'agent' | 'background';
  payloadJson?: string | null;
  title?: string | null;
}

function accept(overrides: AcceptOverrides = {}) {
  return store.accept({
    ownerId: overrides.ownerId ?? 'owner-1',
    botId: overrides.botId ?? 'bot-1',
    source: overrides.source ?? 'telegram',
    sourceEventId: overrides.sourceEventId ?? 'evt-1',
    ...(overrides.bindingId !== undefined ? { bindingId: overrides.bindingId } : {}),
    ...(overrides.lane !== undefined ? { lane: overrides.lane } : {}),
    ...(overrides.payloadJson !== undefined ? { payloadJson: overrides.payloadJson } : {}),
    ...(overrides.title !== undefined ? { title: overrides.title } : {}),
  });
}

function claimFirst(botId = 'bot-1', deadlineMs = FUTURE_DEADLINE, leaseOwner = 'dispatcher-a') {
  return store.claim(botId, leaseOwner, deadlineMs);
}

function legacyRow(overrides: Partial<PendingWakeRow> = {}): PendingWakeRow {
  return {
    kind: 'user.message',
    workId: 'work-1',
    agentId: 'bot:legacy',
    lane: 'background',
    markedAtMs: 1_700_000_000_000,
    title: 'old wake',
    quietOriginJson: null,
    ...overrides,
  };
}

describe('BotInboxStore accept', () => {
  it('inserts a pending row and composes the dedup key itself', () => {
    const result = accept({ bindingId: 'binding-9', payloadJson: '{"text":"hi"}' });

    expect(result.deduplicated).toBe(false);
    expect(result.entry.status).toBe('pending');
    expect(result.entry.attempt).toBe(0);
    expect(result.entry.lane).toBe('background');
    expect(result.entry.dedupKey).toBe(
      composeBotInboxDedupKey('owner-1', 'bot-1', 'telegram', 'binding-9', 'evt-1'),
    );
    // What accept returns is what is stored: the same row a fresh read sees.
    expect(store.getById(result.entry.id)).toEqual(result.entry);
  });

  it('answers a redelivery with the existing row and keeps the first payload', () => {
    const first = accept({ payloadJson: '{"text":"first"}' });
    const second = accept({ payloadJson: '{"text":"redelivered"}', title: 'different' });

    expect(second.deduplicated).toBe(true);
    expect(second.entry.id).toBe(first.entry.id);
    expect(second.entry.payloadJson).toBe('{"text":"first"}');
    expect(second.entry.title).toBeNull();
  });

  it('keeps two bots isolated on the same source event', () => {
    const forBotA = accept({ botId: 'bot-a' });
    const forBotB = accept({ botId: 'bot-b' });

    expect(forBotA.deduplicated).toBe(false);
    expect(forBotB.deduplicated).toBe(false);
    expect(forBotA.entry.id).not.toBe(forBotB.entry.id);
  });
});

describe('BotInboxStore claim', () => {
  it('answers null when the bot has nothing pending', () => {
    expect(claimFirst()).toBeNull();
  });

  it('skips a claimed row and never re-grants it', () => {
    accept();
    const granted = claimFirst();
    expect(granted).not.toBeNull();
    expect(claimFirst()).toBeNull();
    expect(store.getById((granted as NonNullable<typeof granted>).entry.id)?.status).toBe('claimed');
  });

  it('claims user lane before agent and background regardless of age', () => {
    const background = accept({ sourceEventId: 'evt-bg', lane: 'background' });
    const agent = accept({ sourceEventId: 'evt-agent', lane: 'agent' });
    accept({ sourceEventId: 'evt-user', lane: 'user' });
    // Force the background row to be the oldest.
    db.prepare('UPDATE bot_inbox SET created_ms = ? WHERE id = ?').run(1, background.entry.id);
    db.prepare('UPDATE bot_inbox SET created_ms = ? WHERE id = ?').run(2, agent.entry.id);

    const granted = claimFirst();
    expect(granted?.entry.lane).toBe('user');
  });

  it('orders same-lane claims oldest first and writes the lease', () => {
    const older = accept({ sourceEventId: 'evt-old' });
    const newer = accept({ sourceEventId: 'evt-new' });
    // Pin created_ms: two accepts can land in the same millisecond, and the
    // tie-break is the random id.
    db.prepare('UPDATE bot_inbox SET created_ms = ? WHERE id = ?').run(1, older.entry.id);
    db.prepare('UPDATE bot_inbox SET created_ms = ? WHERE id = ?').run(2, newer.entry.id);

    const first = claimFirst('bot-1', FUTURE_DEADLINE, 'dispatcher-1');
    expect(first?.entry.id).toBe(older.entry.id);
    expect(first?.leaseOwner).toBe('dispatcher-1');
    expect(first?.leaseEpoch).toBe(1);
    expect(first?.deadlineMs).toBe(FUTURE_DEADLINE);
    expect(first?.entry.leaseOwner).toBe('dispatcher-1');
    expect(first?.entry.claimedAtMs).not.toBeNull();

    const second = claimFirst('bot-1', FUTURE_DEADLINE, 'dispatcher-2');
    expect(second?.entry.id).toBe(newer.entry.id);
    expect(second?.leaseEpoch).toBe(1);
  });

  it('raises the lease epoch across a requeue so a stale holder is distinguishable', () => {
    accept();
    const first = claimFirst('bot-1', PAST_DEADLINE, 'dispatcher-1');
    expect(first?.leaseEpoch).toBe(1);

    store.requeueExpired(Date.now());

    const second = claimFirst('bot-1', FUTURE_DEADLINE, 'dispatcher-2');
    expect(second?.entry.id).toBe(first?.entry.id);
    expect(second?.leaseEpoch).toBe(2);
    expect(second?.leaseOwner).toBe('dispatcher-2');
  });
});

describe('BotInboxStore reserve', () => {
  it('binds an unseen dispatch key to the candidate run as fresh + reserved', () => {
    const outcome = store.reserve('dispatch-1', 'run-candidate');

    expect(outcome.state).toBe('fresh');
    expect(outcome.runId).toBe('run-candidate');
    expect(outcome.receipt).toMatchObject({
      dispatchKey: 'dispatch-1',
      runId: 'run-candidate',
      state: 'reserved',
      botInboxId: null,
    });
    expect(store.lookupReceipt('dispatch-1')).toEqual(outcome.receipt);
  });

  it('returns the stored run id and discards a later candidate', () => {
    store.reserve('dispatch-1', 'run-first');

    const retry = store.reserve('dispatch-1', 'run-second');
    expect(retry.state).toBe('reserved');
    expect(retry.runId).toBe('run-first');
    expect(store.lookupReceipt('dispatch-1')?.runId).toBe('run-first');
  });

  it('answers opened for a key whose receipt already landed', () => {
    const accepted = accept();
    const granted = claimFirst();
    store.reserve('dispatch-1', 'run-first');
    store.recordDispatch((granted as NonNullable<typeof granted>).entry.id, 'dispatch-1', 'run-first');

    const after = store.reserve('dispatch-1', 'run-late');
    expect(after.state).toBe('opened');
    expect(after.runId).toBe('run-first');
    expect(after.receipt.botInboxId).toBe(accepted.entry.id);
  });
});

describe('BotInboxStore recordDispatch', () => {
  it('moves claimed → dispatched and opens the receipt in one step', () => {
    const accepted = accept();
    const granted = claimFirst();
    const inboxId = (granted as NonNullable<typeof granted>).entry.id;
    store.reserve('dispatch-1', 'run-1');

    const outcome = store.recordDispatch(inboxId, 'dispatch-1', 'run-1');

    expect(outcome.state).toBe('applied');
    expect(outcome.entry.status).toBe('dispatched');
    expect(outcome.entry.dispatchKey).toBe('dispatch-1');
    expect(outcome.entry.dispatchedAtMs).not.toBeNull();
    expect(outcome.receipt).toMatchObject({
      dispatchKey: 'dispatch-1',
      runId: 'run-1',
      state: 'opened',
      botInboxId: accepted.entry.id,
    });
  });

  it('creates the receipt when reserve was never called', () => {
    accept();
    const granted = claimFirst();
    const inboxId = (granted as NonNullable<typeof granted>).entry.id;

    const outcome = store.recordDispatch(inboxId, 'dispatch-1', 'run-1');

    expect(outcome.state).toBe('applied');
    expect(outcome.receipt.state).toBe('opened');
    expect(store.lookupReceipt('dispatch-1')?.runId).toBe('run-1');
  });

  it('replays an identical dispatch without rewriting history', () => {
    accept();
    const granted = claimFirst();
    const inboxId = (granted as NonNullable<typeof granted>).entry.id;
    const first = store.recordDispatch(inboxId, 'dispatch-1', 'run-1');
    expect(first.state).toBe('applied');

    const second = store.recordDispatch(inboxId, 'dispatch-1', 'run-1');

    expect(second.state).toBe('replayed');
    expect(second.entry.dispatchedAtMs).toBe(first.entry.dispatchedAtMs);
    expect(second.receipt).toEqual(first.receipt);
  });

  it('throws and writes nothing when the key is bound to a different run', () => {
    accept();
    const granted = claimFirst();
    const inboxId = (granted as NonNullable<typeof granted>).entry.id;
    store.reserve('dispatch-1', 'run-original');

    let caught: unknown;
    try {
      store.recordDispatch(inboxId, 'dispatch-1', 'run-imposter');
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(BotInboxDispatchConflictError);
    expect((caught as BotInboxDispatchConflictError).storedRunId).toBe('run-original');
    expect((caught as BotInboxDispatchConflictError).offeredRunId).toBe('run-imposter');
    // Nothing moved: the input is still claimed, the receipt still original.
    expect(store.getById(inboxId)?.status).toBe('claimed');
    expect(store.lookupReceipt('dispatch-1')?.runId).toBe('run-original');
  });

  it('refuses an input that was never claimed', () => {
    const accepted = accept();

    const outcome = store.recordDispatch(accepted.entry.id, 'dispatch-1', 'run-1');

    expect(outcome.state).toBe('not_claimed');
    expect(store.getById(accepted.entry.id)?.status).toBe('pending');
    expect(store.lookupReceipt('dispatch-1')).toBeNull();
  });

  it('answers absent for an unknown inbox id', () => {
    expect(store.recordDispatch('no-such-row', 'dispatch-1', 'run-1')).toEqual({ state: 'absent' });
  });
});

describe('BotInboxStore settle', () => {
  it('settles a dispatched input once and replays a repeat', () => {
    accept();
    const granted = claimFirst();
    const inboxId = (granted as NonNullable<typeof granted>).entry.id;
    store.recordDispatch(inboxId, 'dispatch-1', 'run-1');

    const first = store.settle(inboxId);
    expect(first.state).toBe('applied');
    expect(first.entry.status).toBe('settled');
    expect(first.entry.settledAtMs).not.toBeNull();

    const second = store.settle(inboxId);
    expect(second.state).toBe('replayed');
    expect(second.entry.settledAtMs).toBe(first.entry.settledAtMs);
  });

  it('refuses an input that never dispatched', () => {
    const accepted = accept();
    const outcome = store.settle(accepted.entry.id);
    expect(outcome.state).toBe('not_dispatched');
    expect(store.getById(accepted.entry.id)?.status).toBe('pending');
  });

  it('answers absent for an unknown inbox id', () => {
    expect(store.settle('no-such-row')).toEqual({ state: 'absent' });
  });
});

describe('BotInboxStore deadLetter', () => {
  it('dead-letters a claimed input and keeps the first reason', () => {
    accept();
    const granted = claimFirst();
    const inboxId = (granted as NonNullable<typeof granted>).entry.id;

    const first = store.deadLetter(inboxId, 'lease expired three times');
    expect(first.state).toBe('applied');
    expect(first.entry.status).toBe('dead_letter');
    expect(first.entry.deadLetterReason).toBe('lease expired three times');

    const second = store.deadLetter(inboxId, 'a different opinion');
    expect(second.state).toBe('replayed');
    expect(store.getById(inboxId)?.deadLetterReason).toBe('lease expired three times');
  });

  it('dead-letters a pending input directly', () => {
    const accepted = accept();
    const outcome = store.deadLetter(accepted.entry.id, 'unroutable');
    expect(outcome.state).toBe('applied');
    expect(store.getById(accepted.entry.id)?.status).toBe('dead_letter');
  });

  it('answers already_settled for a settled input', () => {
    accept();
    const granted = claimFirst();
    const inboxId = (granted as NonNullable<typeof granted>).entry.id;
    store.recordDispatch(inboxId, 'dispatch-1', 'run-1');
    store.settle(inboxId);

    const outcome = store.deadLetter(inboxId, 'too late');
    expect(outcome.state).toBe('already_settled');
    expect(store.getById(inboxId)?.status).toBe('settled');
  });
});

describe('BotInboxStore requeueExpired', () => {
  it('requeues only expired claimed rows and bumps their attempt', () => {
    // Four rows with pinned created_ms so the claim order is deterministic:
    // 1 expires, 2 stays live, 3 gets dispatched (deadline still in the past),
    // 4 is never claimed.
    const rowIds = [
      accept({ sourceEventId: 'evt-1' }),
      accept({ sourceEventId: 'evt-2' }),
      accept({ sourceEventId: 'evt-3' }),
      accept({ sourceEventId: 'evt-4' }),
    ].map((result) => result.entry.id);
    rowIds.forEach((id, index) => {
      db.prepare('UPDATE bot_inbox SET created_ms = ? WHERE id = ?').run(index + 1, id);
    });

    store.claim('bot-1', 'dispatcher', PAST_DEADLINE); // row 1: expired claim
    store.claim('bot-1', 'dispatcher', FUTURE_DEADLINE); // row 2: live claim
    const third = store.claim('bot-1', 'dispatcher', PAST_DEADLINE); // row 3
    const thirdId = (third as NonNullable<typeof third>).entry.id;
    store.recordDispatch(thirdId, 'dispatch-1', 'run-1');

    const requeued = store.requeueExpired(Date.now());

    expect(requeued).toBe(1);
    const expiredEntry = store.getById(rowIds[0] as string);
    expect(expiredEntry?.status).toBe('pending');
    expect(expiredEntry?.attempt).toBe(1);
    expect(expiredEntry?.leaseOwner).toBeNull();
    expect(expiredEntry?.deadlineMs).toBeNull();
    expect(store.getById(rowIds[1] as string)?.status).toBe('claimed');
    expect(store.getById(rowIds[2] as string)?.status).toBe('dispatched');
    expect(store.getById(rowIds[3] as string)).toMatchObject({ status: 'pending', attempt: 0 });
  });

  it('never expires a claim that carries no deadline', () => {
    accept();
    const granted = claimFirst();
    const inboxId = (granted as NonNullable<typeof granted>).entry.id;
    db.prepare('UPDATE bot_inbox SET deadline_ms = NULL WHERE id = ?').run(inboxId);

    expect(store.requeueExpired(Date.now())).toBe(0);
    expect(store.getById(inboxId)?.status).toBe('claimed');
  });
});

describe('BotInboxStore importLegacyPendingWakes', () => {
  it('dry-run classifies and writes nothing', () => {
    const rows = [
      legacyRow(),
      legacyRow({ workId: '', kind: '' }),
      legacyRow({ workId: '' }),
    ];

    const report = store.importLegacyPendingWakes(rows, { dryRun: true });

    expect(report).toEqual({ imported: 1, conflicts: 0, notReconstructible: 2 });
    expect(store.listByBot('bot:legacy')).toEqual([]);
  });

  it('imports a marker as a legacy review obligation, not a user message', () => {
    const report = store.importLegacyPendingWakes([legacyRow()], { dryRun: false });

    expect(report).toEqual({ imported: 1, conflicts: 0, notReconstructible: 0 });
    const entries = store.listByBot('bot:legacy');
    expect(entries).toHaveLength(1);
    const entry = entries[0] as NonNullable<(typeof entries)[number]>;
    expect(entry.source).toBe('legacy');
    expect(entry.dedupKey).toBe(composeLegacyDedupKey('user.message', 'work-1'));
    expect(entry.botId).toBe('bot:legacy');
    expect(entry.ownerId).toBe('');
    expect(entry.status).toBe('pending');
    expect(entry.lane).toBe('background');
    expect(entry.title).toBe('old wake');
    expect(entry.createdAtMs).toBe(1_700_000_000_000);
    const payload = JSON.parse(entry.payloadJson ?? '{}') as Record<string, unknown>;
    expect(payload).toMatchObject({ legacyKind: 'user.message', legacyWorkId: 'work-1' });
    expect(typeof payload.scopeNote).toBe('string');
  });

  it('reports a re-import as conflicts and never overwrites', () => {
    const rows = [legacyRow()];
    store.importLegacyPendingWakes(rows, { dryRun: false });
    const before = store.listByBot('bot:legacy');

    const report = store.importLegacyPendingWakes(rows, { dryRun: false });

    expect(report).toEqual({ imported: 0, conflicts: 1, notReconstructible: 0 });
    expect(store.listByBot('bot:legacy')).toEqual(before);
  });

  it('never overwrites an imported row even when the marker changed', () => {
    const rows = [legacyRow()];
    store.importLegacyPendingWakes(rows, { dryRun: false });

    // Same legacy identity re-offered with different metadata: reported as a
    // conflict, the stored row keeps its original shape.
    const report = store.importLegacyPendingWakes(
      [legacyRow({ lane: 'user', title: 'changed shape' })],
      { dryRun: false },
    );
    expect(report).toEqual({ imported: 0, conflicts: 1, notReconstructible: 0 });
    expect(store.listByBot('bot:legacy')[0]?.title).toBe('old wake');
  });
});

describe('bot inbox migration wiring', () => {
  it('registers migration 45 exactly once with no duplicate core ids', () => {
    const core = collectCoreDataMigrations();
    const botMigrations = core.filter((migration) => migration.name === 'create_bot_inbox');
    expect(botMigrations).toHaveLength(1);
    expect(botMigrations[0]?.id).toBe(45);

    const seen = new Set<number>();
    for (const migration of core) {
      expect(seen.has(migration.id)).toBe(false);
      seen.add(migration.id);
    }
  });
});
