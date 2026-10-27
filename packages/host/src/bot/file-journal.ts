/**
 * file-journal.ts — the fs JSONL adapter of the identity journal (framework
 * plan S2; the durable half of the S1 `bot/journal.ts`).
 *
 * The bookkeeping (intents/applied/receipts maps, record validation, the
 * load report, the requestId dedup) is `@duya/bot`'s
 * `BotIdentityJournalState`. This adapter owns the bytes: reading the JSONL
 * file once at construction, feeding each parsed line to the state (a line
 * that fails to parse counts as corrupt — the torn-tail rule), and appending
 * every record the state returns. The file format and the
 * `.identity-journal.jsonl` filename are unchanged from S1, and the class
 * keeps the S1 name and constructor because the Desktop store backend
 * constructs it (`new BotIdentityJournal(dir)`).
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import * as path from 'node:path';
import { BOT_IDENTITY_JOURNAL_FILENAME, BotIdentityJournalState } from '@duya/bot';
import type {
  BotCreateIntent,
  BotIdentityEntry,
  BotIdentityJournalPort,
  BotUpdateIntent,
  BotUpdatePatch,
  JournalLoadReport,
} from '@duya/bot';

export class BotIdentityJournal implements BotIdentityJournalPort {
  readonly filePath: string;
  private readonly state = new BotIdentityJournalState();

  constructor(readonly dir: string) {
    this.filePath = path.join(dir, BOT_IDENTITY_JOURNAL_FILENAME);
    this.load();
  }

  /** Lines that failed to parse at load — the S1 public field, now derived. */
  get corruptLines(): number {
    return this.state.corruptLines;
  }

  private load(): void {
    if (!existsSync(this.filePath)) return;
    const raw = readFileSync(this.filePath, 'utf8');
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      try {
        this.state.ingestRecord(JSON.parse(line));
      } catch {
        this.state.ingestCorruptLine();
      }
    }
  }

  report(): JournalLoadReport {
    return this.state.report();
  }

  lookupCreate(requestId: string) {
    return this.state.lookupCreate(requestId);
  }

  appendCreate(input: {
    requestId: string | null;
    id: string;
    entry: BotIdentityEntry;
    nextRevision: number;
  }): BotCreateIntent {
    const record = this.state.createIntent(input);
    this.append(record);
    return record;
  }

  appendUpdate(input: {
    id: string;
    patch: BotUpdatePatch;
    nextRevision: number;
  }): BotUpdateIntent {
    const record = this.state.updateIntent(input);
    this.append(record);
    return record;
  }

  markApplied(seq: number): void {
    this.append(this.state.markApplied(seq));
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
