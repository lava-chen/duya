/**
 * The identity journal's pure state machine (framework plan S2).
 *
 * These pin the bookkeeping semantics the S1 fs journal owned, now that the
 * bytes are a Host adapter: record validation feeds or counts corrupt lines,
 * applied markers close intents, seq allocation continues the loaded file,
 * and the requestId dedup answers only from APPLIED create intents.
 */

import { describe, expect, it } from 'vitest';

import {
  BOT_IDENTITY_JOURNAL_FILENAME,
  BotIdentityJournalState,
  InMemoryBotIdentityJournal,
  isJournalRecord,
} from '../src/index.js';

function createRecord(seq: number, overrides: Record<string, unknown> = {}) {
  return {
    v: 1,
    seq,
    kind: 'create',
    requestId: null,
    id: `bot-${seq}`,
    entry: { name: `Bot ${seq}` },
    nextRevision: 1,
    recordedAt: 1,
    ...overrides,
  };
}

describe('journal state — load semantics', () => {
  it('keeps the S1 filename for the fs adapter to join', () => {
    expect(BOT_IDENTITY_JOURNAL_FILENAME).toBe('.identity-journal.jsonl');
  });

  it('counts a malformed record as a corrupt line instead of throwing', () => {
    const state = new BotIdentityJournalState();
    state.ingestCorruptLine(); // JSON.parse failure in the adapter
    state.ingestRecord({ v: 2, seq: 1, kind: 'create' }); // wrong version
    state.ingestRecord('not an object');
    expect(state.corruptLines).toBe(3);
    expect(state.report().pending).toEqual([]);
  });

  it('collects unmarked intents as pending, ordered by seq', () => {
    const state = new BotIdentityJournalState();
    state.ingestRecord(createRecord(2));
    state.ingestRecord(createRecord(1));
    state.ingestRecord({ v: 1, ref: 2, kind: 'applied', appliedAt: 2 });
    const report = state.report();
    expect(report.pending.map((i) => i.seq)).toEqual([1]);
    expect(report.corruptLines).toBe(0);
  });

  it('ignores a duplicate seq (the first stored record wins)', () => {
    const state = new BotIdentityJournalState();
    state.ingestRecord(createRecord(1, { id: 'first' }));
    state.ingestRecord(createRecord(1, { id: 'second' }));
    expect(state.report().pending).toHaveLength(1);
    expect(state.report().pending[0]?.id).toBe('first');
    // The seq counter still advanced past the loaded maximum.
    const created = state.createIntent({ requestId: null, id: 'next', entry: { name: 'N' }, nextRevision: 1 });
    expect(created.seq).toBe(2);
  });

  it('continues seq allocation from the loaded file maximum', () => {
    const state = new BotIdentityJournalState();
    state.ingestRecord(createRecord(7));
    const created = state.createIntent({ requestId: null, id: 'next', entry: { name: 'N' }, nextRevision: 1 });
    expect(created.seq).toBe(8);
    expect(created.v).toBe(1);
    expect(created.recordedAt).toBeGreaterThan(0);
  });
});

describe('journal state — requestId dedup', () => {
  it('answers a retried create only once the intent is APPLIED', () => {
    const state = new BotIdentityJournalState();
    const intent = state.createIntent({ requestId: 'req-1', id: 'researcher', entry: { name: 'Researcher' }, nextRevision: 1 });
    expect(state.lookupCreate('req-1')).toBeNull();

    state.markApplied(intent.seq);
    expect(state.lookupCreate('req-1')).toEqual({ id: 'researcher', name: 'Researcher', revision: 1 });
  });

  it('prefers the entry name, falling back to the id in the receipt', () => {
    const state = new BotIdentityJournalState();
    const intent = state.createIntent({ requestId: 'req-2', id: 'no-name', entry: {}, nextRevision: 4 });
    state.markApplied(intent.seq);
    expect(state.lookupCreate('req-2')).toEqual({ id: 'no-name', name: 'no-name', revision: 4 });
  });

  it('exposes the applied receipts through report()', () => {
    const journal = new InMemoryBotIdentityJournal();
    const intent = journal.appendCreate({ requestId: 'req-3', id: 'a-bot', entry: { name: 'A' }, nextRevision: 1 });
    journal.appendUpdate({ id: 'a-bot', patch: { name: 'B' }, nextRevision: 2 });
    expect(journal.report().appliedCreates.size).toBe(0);
    journal.markApplied(intent.seq);
    expect(journal.report().appliedCreates.get('req-3')).toEqual({ id: 'a-bot', name: 'A', revision: 1 });
    expect(journal.lookupCreate('req-3')).not.toBeNull();
  });
});

describe('journal record validation', () => {
  it('accepts the S1 shapes and rejects everything else', () => {
    expect(isJournalRecord(createRecord(1))).toBe(true);
    expect(isJournalRecord({ v: 1, ref: 1, kind: 'applied', appliedAt: 1 })).toBe(true);
    expect(isJournalRecord({ v: 1, seq: 1, kind: 'update', id: 'x', patch: {}, nextRevision: 2, recordedAt: 1 })).toBe(true);
    expect(isJournalRecord(createRecord(1, { v: 2 }))).toBe(false);
    expect(isJournalRecord({ v: 1, ref: 0, kind: 'applied', appliedAt: 1 })).toBe(false);
    expect(isJournalRecord(createRecord(1, { seq: 0 }))).toBe(false);
    expect(isJournalRecord(createRecord(1, { nextRevision: 0 }))).toBe(false);
    expect(isJournalRecord(null)).toBe(false);
  });
});
