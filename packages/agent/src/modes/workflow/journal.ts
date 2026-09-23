/**
 * journal.ts — append-only run journal (plan 415 §5.3 + 552 §4.4/§6.4).
 *
 * One JSON-serializable record per result-bearing event. The journal is
 * the breakpoint-resume cache AND the audit trail AND (via the host
 * `onJournalEvent` hook) the live progress feed — one write, three uses
 * (plan 552 §2 principle 4: entries reported as they happen survive a
 * crashed run).
 *
 * Cache economics (§6.4): a re-run / amended re-run looks up records by
 * `nodeId + reqHash` — unchanged nodes hit the cache and never re-pay;
 * `params` changes only touch the reqHash of nodes that reference them.
 * BudgetExceeded / Cancelled terminate WITHOUT journal records (a re-run
 * with a raised budget replays cleanly); `pruneTrailingFailures()` cuts
 * the failed tail sentinel off a Failed run so the failing call truly
 * re-executes on resume.
 */

import { createHash } from 'node:crypto';

export type JournalKind = 'node_result' | 'decision' | 'approval' | 'artifact' | 'phase';

export type JournalStatus = 'pending' | 'running' | 'succeeded' | 'failed' | 'skipped' | 'waiting';

/** Node kind annotation — drives console stats (agent count) and icons. */
export type JournalNodeKind = 'tool' | 'agent' | 'decision' | 'human' | 'gui' | 'browser' | 'noop';

export interface JournalRecord {
  seq: number;
  kind: JournalKind;
  nodeId: string;
  /** Skyvern block-level attempt semantics. */
  attempt: number;
  /** sha256(kind + canonical payload), first 16 bytes hex (415 §5.3). */
  reqHash?: string;
  /** Replay cache value. */
  result?: unknown;
  status: JournalStatus;
  /** fresh-eyes annotation (plan 552 §2 principle 4) — verify-stage output. */
  verification?: 'verified' | 'unconfirmed';
  /** Failure taxonomy (Skyvern-style classes; regex first). */
  errorClass?: string;
  atMs: number;
  /**
   * Step-evidence metadata (plan 552 Phase 7 console, ZCode replay-view
   * analogue). Display/audit only — NEVER part of the reqHash payload,
   * so populating these can never invalidate the replay cache.
   */
  nodeKind?: JournalNodeKind;
  /** What ran: tool name, agent type, gui action (`click`/`capture`), `decide`. */
  action?: string;
  /** Process exit code when the host surfaces one (bash-family tools). */
  exitCode?: number | null;
  /** Wall time of the host call (cache hits carry no duration). */
  durationMs?: number;
  /** Serialized size of `result` in bytes (output evidence weight). */
  outputSize?: number;
  /** Sub-agent DB session (plan 504 lineage) — console links to the transcript. */
  childSessionId?: string;
  /** Token usage when the host reports it (summed into run stats). */
  usage?: { inputTokens: number; outputTokens: number };
  /**
   * Display-only one-line input digest (plan 560 §6.1), e.g.
   * `git tag --list v*`. The record otherwise carries only `reqHash`, so the
   * run card has nothing readable to print for a step. Truncated by the
   * producer (~200 chars).
   *
   * Display/audit only — NEVER part of the reqHash payload, so populating it
   * can never invalidate the replay cache.
   */
  inputSummary?: string;
  /**
   * This call was served from the replay cache — the host was never invoked
   * (plan 560 §6.1). The run card renders it as the `重放` badge; it is NOT a
   * re-run control.
   *
   * Display/audit only — NEVER part of the reqHash payload.
   */
  replayed?: boolean;
}

/** Canonical JSON: sorted keys, stable float formatting. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const keys = Object.keys(value as Record<string, unknown>).sort();
  const body = keys
    .map((k) => `${JSON.stringify(k)}:${canonicalJson((value as Record<string, unknown>)[k])}`)
    .join(',');
  return `{${body}}`;
}

/** reqHash = sha256(kind + canonical payload), first 16 bytes hex. */
export function computeReqHash(kind: JournalKind, payload: unknown): string {
  return createHash('sha256').update(`${kind}\u0000${canonicalJson(payload)}`).digest('hex').slice(0, 16);
}

/** Where records are durably appended (JSONL file / core-db blob / memory). */
export interface JournalSink {
  append(record: JournalRecord): void;
  /** All records in seq order (resume source). */
  readAll(): JournalRecord[];
}

export class MemoryJournalSink implements JournalSink {
  private readonly records: JournalRecord[] = [];

  append(record: JournalRecord): void {
    this.records.push(record);
  }

  readAll(): JournalRecord[] {
    return [...this.records];
  }
}

/** JSONL file sink — the per-run durable form used until plan 552 Phase 4
 * moves storage into core-db blobs. */
export class JsonlJournalSink implements JournalSink {
  private buffer: JournalRecord[] | undefined;

  constructor(
    private readonly fsModule: typeof import('node:fs'),
    private readonly filePath: string,
  ) {}

  append(record: JournalRecord): void {
    this.fsModule.appendFileSync(this.filePath, `${JSON.stringify(record)}\n`, 'utf8');
    this.buffer = undefined;
  }

  readAll(): JournalRecord[] {
    if (this.buffer) return [...this.buffer];
    if (!this.fsModule.existsSync(this.filePath)) return [];
    const lines = this.fsModule.readFileSync(this.filePath, 'utf8').split('\n').filter(Boolean);
    this.buffer = lines.map((line) => JSON.parse(line) as JournalRecord);
    return [...this.buffer];
  }
}

export class Journal {
  private seq = 0;
  private sink: JournalSink;
  private readonly cache = new Map<string, JournalRecord>();
  /** Live-progress tap — the "one write, three uses" SSE channel. */
  listener?: (record: JournalRecord) => void;

  constructor(sink: JournalSink = new MemoryJournalSink()) {
    this.sink = sink;
    const existing = sink.readAll();
    this.seq = existing.length;
    for (const record of existing) {
      if (record.reqHash && record.status === 'succeeded') {
        this.cache.set(cacheKey(record.nodeId, record.reqHash), record);
      }
    }
  }

  /** Append a record; fires the sink (durability) + the live listener. */
  append(record: Omit<JournalRecord, 'seq' | 'atMs'> & { atMs?: number }): JournalRecord {
    const full: JournalRecord = {
      ...record,
      seq: this.seq++,
      atMs: record.atMs ?? Date.now(),
    };
    this.sink.append(full);
    if (full.reqHash && full.status === 'succeeded') {
      this.cache.set(cacheKey(full.nodeId, full.reqHash), full);
    }
    try {
      this.listener?.(full);
    } catch {
      // Progress taps must never break execution.
    }
    return full;
  }

  /**
   * Cache lookup by `nodeId + reqHash` (plan 552 §6.4). A hit means the
   * identical call succeeded before — reuse its result and skip execution.
   */
  hit(nodeId: string, reqHash: string): JournalRecord | undefined {
    return this.cache.get(cacheKey(nodeId, reqHash));
  }

  all(): JournalRecord[] {
    return this.sink.readAll();
  }

  /** Status of a node's latest record (undefined when never touched). */
  nodeStatus(nodeId: string): JournalStatus | undefined {
    const records = this.all().filter((r) => r.nodeId === nodeId);
    return records.length > 0 ? records[records.length - 1].status : undefined;
  }

  /** The approval record for a human node, if the resume flow wrote one. */
  approvalFor(nodeId: string): JournalRecord | undefined {
    const records = this.all().filter((r) => r.kind === 'approval' && r.nodeId === nodeId);
    return records.length > 0 ? records[records.length - 1] : undefined;
  }

  /**
   * Drop the trailing failure sentinel(s) of a Failed run (415 §5.3) so
   * the failing call re-executes on resume. Succeeded cache entries stay.
   */
  pruneTrailingFailures(): number {
    const records = this.all();
    let cut = 0;
    for (let i = records.length - 1; i >= 0; i--) {
      if (records[i].status === 'failed') cut++;
      else break;
    }
    if (cut === 0) return 0;
    // Rebuild the sink without the failed tail (memory sink: rewrite the
    // store; file sink: caller persists the trimmed snapshot via Phase 4).
    const kept = records.slice(0, records.length - cut);
    if (this.sink instanceof MemoryJournalSink) {
      const fresh = new MemoryJournalSink();
      for (const r of kept) fresh.append(r);
      this.sink = fresh;
    }
    this.seq = kept.length;
    return cut;
  }

  static memory(): Journal {
    return new Journal(new MemoryJournalSink());
  }
}

function cacheKey(nodeId: string, reqHash: string): string {
  return `${nodeId}\u0000${reqHash}`;
}
