/**
 * journal.ts — the durable identity intent ledger, PURE half (framework plan
 * S2; the state machine moved from the Host's `bot/journal.ts`).
 *
 * `config.toml` and `agents/<id>/profile.json` are two files no transaction
 * covers, and the config table itself is read-modify-write. The plan's risk
 * table is explicit about that window: "每个写入步骤 crash fixture，revision
 * 冲突与修复 — durable create/update intent 驱动补齐，保留原始文件副本".
 * The journal is the durable intent half of that contract; the application
 * service owns the repair that consumes it.
 *
 * ## Shape
 *
 * One JSONL file at `<agentsRoot>/.identity-journal.jsonl`, append-only:
 *
 *   {"v":1,"seq":7,"kind":"create","requestId":"…","id":"bot-x",
 *    "entry":{…},"nextRevision":1,"recordedAt":1699…}
 *   {"v":1,"ref":7,"kind":"applied","appliedAt":1699…}
 *
 * An intent line is written BEFORE the config write; the `applied` marker is
 * appended AFTER the config write and profile seeding complete. Pending =
 * intent without marker. Because the file is only ever appended, a crash can
 * tear at most the LAST line — which is why a line that fails to parse is
 * counted in `corruptLines` and skipped instead of failing the load: a torn
 * tail must not make every bot write unreadable.
 *
 * ## What is pure here and what is not
 *
 * `BotIdentityJournalState` owns ALL bookkeeping — record construction and
 * validation (`isJournalRecord`), the intents/applied/receipts maps, the
 * load report and the requestId dedup lookup — with no `node:*` import. The
 * bytes on disk are a Host adapter's business: it reads the JSONL lines,
 * feeds parsed values to `ingestRecord` (or `ingestCorruptLine` for a line
 * that fails to parse), and persists whatever record the state returns from
 * `createIntent` / `updateIntent` / `markApplied`. The file format and the
 * `.identity-journal.jsonl` filename are unchanged from S1.
 *
 * `InMemoryBotIdentityJournal` is the same state behind the journal port,
 * for tests and for embedders whose durability lives elsewhere.
 *
 * ## requestId dedup
 *
 * Applied create intents carry their receipt (id / name / revision), so a
 * retried create with the same requestId is answered from the journal
 * without executing anything — the same bot id comes back twice, never two
 * bots. The dedup survives process crashes because the durable half is the
 * journal file, not memory.
 *
 * ## What is deliberately NOT here
 *
 * Compaction. The journal grows monotonically with bot writes, which are
 * low-frequency; S3's inbox work owns the general retention-window question
 * and this file adopts its answer then. Growing an append-only log of
 * identity edits is also the audit trail the plan asks to keep.
 */

import type { BotCommandReceipt } from '@duya/agent-protocol/bot-api';
import type { BotIdentityEntry, BotUpdatePatch } from '../domain/identity.js';
import type { BotIdentityJournalPort } from '../ports/ports.js';

export const BOT_IDENTITY_JOURNAL_FILENAME = '.identity-journal.jsonl';
const JOURNAL_VERSION = 1;

/** A create intent as journaled (the full entry — a create is absolute). */
export interface BotCreateIntent {
  v: number;
  seq: number;
  kind: 'create';
  requestId: string | null;
  id: string;
  entry: BotIdentityEntry;
  nextRevision: number;
  recordedAt: number;
}

/** An update intent (the patch is relative to whatever is on disk). */
export interface BotUpdateIntent {
  v: number;
  seq: number;
  kind: 'update';
  id: string;
  patch: BotUpdatePatch;
  nextRevision: number;
  recordedAt: number;
}

export type BotIdentityIntent = BotCreateIntent | BotUpdateIntent;

export interface AppliedMarker {
  v: number;
  ref: number;
  kind: 'applied';
  appliedAt: number;
}

export interface JournalLoadReport {
  /** Lines that failed to parse (expected only as a torn tail). */
  corruptLines: number;
  /** Intents without an applied marker — the repair work list. */
  pending: BotIdentityIntent[];
  /** Applied create receipts by requestId, for dedup lookups. */
  appliedCreates: Map<string, BotCommandReceipt>;
}

export function isJournalRecord(value: unknown): value is BotIdentityIntent | AppliedMarker {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  if (v.v !== JOURNAL_VERSION) return false;
  if (v.kind === 'applied') {
    return typeof v.ref === 'number' && Number.isInteger(v.ref) && v.ref > 0;
  }
  if (v.kind !== 'create' && v.kind !== 'update') return false;
  if (typeof v.seq !== 'number' || !Number.isInteger(v.seq) || v.seq < 1) return false;
  if (typeof v.id !== 'string' || !v.id) return false;
  if (typeof v.nextRevision !== 'number' || !Number.isInteger(v.nextRevision) || v.nextRevision < 1) return false;
  if (v.kind === 'create') {
    return typeof v.entry === 'object' && v.entry !== null && (v.requestId === null || typeof v.requestId === 'string');
  }
  return typeof v.patch === 'object' && v.patch !== null;
}

/**
 * The journal's bookkeeping state machine — every map, counter and record
 * constructor, none of the bytes. See the header for the split of labor
 * against the Host's fs adapter.
 */
export class BotIdentityJournalState {
  private readonly intents = new Map<number, BotIdentityIntent>();
  private readonly applied = new Set<number>();
  private readonly receiptBySeq = new Map<number, BotCommandReceipt>();
  private nextSeq = 1;
  corruptLines = 0;

  /**
   * Feed one PARSED journal line into the state. A line that does not match
   * the record shape counts as corrupt (the torn-tail rule) and is skipped;
   * an applied marker closes its intent; a duplicate seq keeps the first
   * stored record.
   */
  ingestRecord(value: unknown): void {
    if (!isJournalRecord(value)) {
      this.corruptLines += 1;
      return;
    }
    const parsed = value;
    if (parsed.kind === 'applied') {
      this.applied.add(parsed.ref);
      return;
    }
    if (this.intents.has(parsed.seq)) return; // duplicate append — first stored wins
    this.intents.set(parsed.seq, parsed);
    if (parsed.seq >= this.nextSeq) this.nextSeq = parsed.seq + 1;
    if (parsed.kind === 'create' && parsed.requestId) {
      this.receiptBySeq.set(parsed.seq, {
        id: parsed.id,
        name: parsed.entry.name ?? parsed.id,
        revision: parsed.nextRevision,
      });
    }
  }

  /** A line that failed to even JSON.parse — the torn-tail count. */
  ingestCorruptLine(): void {
    this.corruptLines += 1;
  }

  /** The load report — what repair has to work with. */
  report(): JournalLoadReport {
    const pending: BotIdentityIntent[] = [];
    const appliedCreates = new Map<string, BotCommandReceipt>();
    for (const [seq, intent] of this.intents) {
      if (!this.applied.has(seq)) pending.push(intent);
      if (intent.kind === 'create' && intent.requestId && this.applied.has(seq)) {
        const receipt = this.receiptBySeq.get(seq);
        if (receipt) appliedCreates.set(intent.requestId, receipt);
      }
    }
    pending.sort((a, b) => a.seq - b.seq);
    return { corruptLines: this.corruptLines, pending, appliedCreates };
  }

  /** A completed create's receipt by requestId, or null. */
  lookupCreate(requestId: string): BotCommandReceipt | null {
    return this.report().appliedCreates.get(requestId) ?? null;
  }

  /**
   * Construct a create intent and account for it. The returned record is the
   * caller's to persist — the state itself writes nothing.
   */
  createIntent(input: {
    requestId: string | null;
    id: string;
    entry: BotIdentityEntry;
    nextRevision: number;
  }): BotCreateIntent {
    const record: BotCreateIntent = {
      v: JOURNAL_VERSION,
      seq: this.nextSeq++,
      kind: 'create',
      requestId: input.requestId,
      id: input.id,
      entry: input.entry,
      nextRevision: input.nextRevision,
      recordedAt: Date.now(),
    };
    this.intents.set(record.seq, record);
    if (record.requestId) {
      this.receiptBySeq.set(record.seq, {
        id: record.id,
        name: record.entry.name ?? record.id,
        revision: record.nextRevision,
      });
    }
    return record;
  }

  /** Construct an update intent and account for it. Persist the return value. */
  updateIntent(input: {
    id: string;
    patch: BotUpdatePatch;
    nextRevision: number;
  }): BotUpdateIntent {
    const record: BotUpdateIntent = {
      v: JOURNAL_VERSION,
      seq: this.nextSeq++,
      kind: 'update',
      id: input.id,
      patch: input.patch,
      nextRevision: input.nextRevision,
      recordedAt: Date.now(),
    };
    this.intents.set(record.seq, record);
    return record;
  }

  /** Close an intent; the returned marker is the caller's to persist. */
  markApplied(seq: number): AppliedMarker {
    this.applied.add(seq);
    return { v: JOURNAL_VERSION, ref: seq, kind: 'applied', appliedAt: Date.now() };
  }
}

/**
 * The journal port over the pure state alone — no persistence. Tests use it
 * (and embedders whose durability lives outside the journal), and it is the
 * reference implementation of the port the application service depends on.
 */
export class InMemoryBotIdentityJournal implements BotIdentityJournalPort {
  private readonly state = new BotIdentityJournalState();

  report(): JournalLoadReport {
    return this.state.report();
  }

  lookupCreate(requestId: string): BotCommandReceipt | null {
    return this.state.lookupCreate(requestId);
  }

  appendCreate(input: {
    requestId: string | null;
    id: string;
    entry: BotIdentityEntry;
    nextRevision: number;
  }): BotCreateIntent {
    return this.state.createIntent(input);
  }

  appendUpdate(input: {
    id: string;
    patch: BotUpdatePatch;
    nextRevision: number;
  }): BotUpdateIntent {
    return this.state.updateIntent(input);
  }

  markApplied(seq: number): void {
    this.state.markApplied(seq);
  }
}
