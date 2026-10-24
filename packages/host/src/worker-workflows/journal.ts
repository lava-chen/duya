/** Host adapters for pure journal types and algorithms. */
import { createHash } from 'node:crypto';
import {
  Journal as WorkflowJournal,
  MemoryJournalSink,
  computeReqHash as coreComputeReqHash,
  type JournalOptions,
  type JournalRecord,
  type JournalSink,
  type JournalKind,
  type WorkflowHashPort,
} from '@duya/workflow';

export { MemoryJournalSink, type JournalRecord, type JournalSink, type JournalKind };

const nativeHash: WorkflowHashPort = {
  sha256(input) {
    return createHash('sha256').update(input).digest('hex');
  },
};

/** Source compatibility for Host callers; the core requires an injected hash. */
export function computeReqHash(kind: JournalKind, payload: unknown): string {
  return coreComputeReqHash(kind, payload, nativeHash);
}

/** Host-bound clock default; tests may still supply a deterministic journal. */
export class Journal extends WorkflowJournal {
  constructor(sink: JournalSink = new MemoryJournalSink(), options: JournalOptions = { nowMs: () => Date.now() }) {
    super(sink, options);
  }

  static memory(options: JournalOptions = { nowMs: () => Date.now() }): Journal {
    return new Journal(new MemoryJournalSink(), options);
  }
}

/** JSONL stays a Host IO adapter; the core sees only JournalSink. */
export class JsonlJournalSink implements JournalSink {
  private buffer: JournalRecord[] | undefined;

  constructor(private readonly fsModule: typeof import('node:fs'), private readonly filePath: string) {}

  append(record: JournalRecord): void {
    this.fsModule.appendFileSync(this.filePath, `${JSON.stringify(record)}\n`, 'utf8');
    this.buffer = undefined;
  }

  readAll(): JournalRecord[] {
    if (this.buffer) return [...this.buffer];
    if (!this.fsModule.existsSync(this.filePath)) return [];
    this.buffer = this.fsModule.readFileSync(this.filePath, 'utf8').split('\n').filter(Boolean)
      .map((line) => JSON.parse(line) as JournalRecord);
    return [...this.buffer];
  }

  replaceAll(records: readonly JournalRecord[]): void {
    this.fsModule.writeFileSync(this.filePath, records.map((record) => JSON.stringify(record)).join('\n') + (records.length ? '\n' : ''), 'utf8');
    this.buffer = [...records];
  }
}
