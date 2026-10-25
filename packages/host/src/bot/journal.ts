/**
 * journal.ts — the durable identity intent journal (framework plan S1).
 *
 * `config.toml` and `agents/<id>/profile.json` are two files no transaction
 * covers, and the config table itself is read-modify-write. The plan's risk
 * table is explicit about that window: "每个写入步骤 crash fixture，revision
 * 冲突与修复 — durable create/update intent 驱动补齐，保留原始文件副本".
 * This journal is the durable intent half of that contract; `service.ts`
 * owns the repair that consumes it.
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
 * ## requestId dedup
 *
 * Applied create intents carry their receipt (id / name / revision), so a
 * retried create with the same requestId is answered from the journal
 * without executing anything — the same bot id comes back twice, never two
 * bots. The dedup survives process crashes because it is the journal file,
 * not memory.
 *
 * ## What is deliberately NOT here
 *
 * Compaction. The journal grows monotonically with bot writes, which are
 * low-frequency; S3's inbox work owns the general retention-window question
 * and this file adopts its answer then. Growing an append-only log of
 * identity edits is also the audit trail the plan asks to keep.
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import * as path from 'node:path';
import type { CustomAgentConfig } from '../config-agents/agent-config-schema.js';
import type { BotCommandReceipt } from '@duya/agent-protocol/bot-api';

export const BOT_IDENTITY_JOURNAL_FILENAME = '.identity-journal.jsonl';
const JOURNAL_VERSION = 1;

/** The raw command fields an update intent re-applies on repair. */
export interface BotUpdatePatch {
  name?: string | undefined;
  description?: string | undefined;
}

/** A create intent as journaled (the full entry — a create is absolute). */
export interface BotCreateIntent {
  v: number;
  seq: number;
  kind: 'create';
  requestId: string | null;
  id: string;
  entry: CustomAgentConfig;
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

export interface JournalLoadReport {
  /** Lines that failed to parse (expected only as a torn tail). */
  corruptLines: number;
  /** Intents without an applied marker — the repair work list. */
  pending: BotIdentityIntent[];
  /** Applied create receipts by requestId, for dedup lookups. */
  appliedCreates: Map<string, BotCommandReceipt>;
}

export class BotIdentityJournal {
  readonly filePath: string;
  private readonly intents = new Map<number, BotIdentityIntent>();
  private readonly applied = new Set<number>();
  private readonly receiptBySeq = new Map<number, BotCommandReceipt>();
  private nextSeq = 1;
  corruptLines = 0;

  constructor(readonly dir: string) {
    this.filePath = path.join(dir, BOT_IDENTITY_JOURNAL_FILENAME);
    this.load();
  }

  private load(): void {
    if (!existsSync(this.filePath)) return;
    const raw = readFileSync(this.filePath, 'utf8');
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        this.corruptLines += 1;
        continue;
      }
      if (!isJournalRecord(parsed)) {
        this.corruptLines += 1;
        continue;
      }
      if (parsed.kind === 'applied') {
        this.applied.add(parsed.ref);
        continue;
      }
      if (this.intents.has(parsed.seq)) continue; // duplicate append — last wins is already stored
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
  }

  /** The load report — what repair has to work with. */
  report(): JournalLoadReport {
    const pending: BotIdentityIntent[] = [];
    const appliedCreates = new Map<string, BotCommandReceipt>();
    for (const [seq, intent] of this.intents) {
      if (!this.applied.has(seq)) pending.push(intent);
      if (intent.kind === 'create' && intent.requestId && this.applied.has(seq)) {
        appliedCreates.set(intent.requestId, this.receiptBySeq.get(seq)!);
      }
    }
    pending.sort((a, b) => a.seq - b.seq);
    return { corruptLines: this.corruptLines, pending, appliedCreates };
  }

  /** A completed create's receipt by requestId, or null. */
  lookupCreate(requestId: string): BotCommandReceipt | null {
    return this.report().appliedCreates.get(requestId) ?? null;
  }

  appendCreate(intent: {
    requestId: string | null;
    id: string;
    entry: CustomAgentConfig;
    nextRevision: number;
  }): BotCreateIntent {
    const record: BotCreateIntent = {
      v: JOURNAL_VERSION,
      seq: this.nextSeq++,
      kind: 'create',
      requestId: intent.requestId,
      id: intent.id,
      entry: intent.entry,
      nextRevision: intent.nextRevision,
      recordedAt: Date.now(),
    };
    this.append(record);
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

  appendUpdate(intent: {
    id: string;
    patch: BotUpdatePatch;
    nextRevision: number;
  }): BotUpdateIntent {
    const record: BotUpdateIntent = {
      v: JOURNAL_VERSION,
      seq: this.nextSeq++,
      kind: 'update',
      id: intent.id,
      patch: intent.patch,
      nextRevision: intent.nextRevision,
      recordedAt: Date.now(),
    };
    this.append(record);
    this.intents.set(record.seq, record);
    return record;
  }

  markApplied(seq: number): void {
    this.applied.add(seq);
    this.append({ v: JOURNAL_VERSION, ref: seq, kind: 'applied', appliedAt: Date.now() });
  }

  private append(record: unknown): void {
    mkdirSync(this.dir, { recursive: true });
    const line = `${JSON.stringify(record)}\n`;
    // A journal that does not end in a newline means the previous append
    // tore; start a fresh line rather than gluing two records together.
    let prefix = '';
    if (existsSync(this.filePath)) {
      const raw = readFileSync(this.filePath, 'utf8');
      if (raw.length > 0 && !raw.endsWith('\n')) prefix = '\n';
    }
    appendFileSync(this.filePath, `${prefix}${line}`, 'utf8');
  }
}

interface AppliedMarker {
  v: number;
  ref: number;
  kind: 'applied';
  appliedAt: number;
}

function isJournalRecord(value: unknown): value is BotIdentityIntent | AppliedMarker {
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
