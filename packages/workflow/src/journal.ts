/** Pure append-only journal model; persistence and progress taps are Host ports. */
import type { JournalRecord as ProtocolJournalRecord } from '@duya/agent-protocol';
import { computeReqHash as hashReq, type WorkflowHashPort } from './hash.js';

export type JournalKind = 'node_result' | 'decision' | 'approval' | 'artifact' | 'phase';
export type JournalStatus = 'pending' | 'running' | 'succeeded' | 'failed' | 'skipped' | 'waiting';
export type JournalNodeKind = 'tool' | 'agent' | 'decision' | 'human' | 'gui' | 'ask' | 'noop';
export type JournalRecord = ProtocolJournalRecord;

export function computeReqHash(kind: JournalKind, payload: unknown, hash: WorkflowHashPort): string {
  return hashReq(kind, payload, hash);
}

export interface JournalSink {
  append(record: JournalRecord): void;
  readAll(): JournalRecord[];
  replaceAll?(records: readonly JournalRecord[]): void;
}

export class MemoryJournalSink implements JournalSink {
  private records: JournalRecord[] = [];

  append(record: JournalRecord): void {
    this.records.push(record);
  }

  readAll(): JournalRecord[] {
    return [...this.records];
  }

  replaceAll(records: readonly JournalRecord[]): void {
    this.records = [...records];
  }
}

export interface JournalOptions {
  nowMs(): number;
}

export class Journal {
  private seq = 0;
  private readonly cache = new Map<string, JournalRecord>();
  listener?: (record: JournalRecord) => void;

  constructor(
    private sink: JournalSink,
    private readonly options: JournalOptions,
  ) {
    const existing = sink.readAll();
    this.seq = existing.reduce((max, record) => Math.max(max, record.seq + 1), 0);
    this.rebuildCache(existing);
  }

  append(record: Omit<JournalRecord, 'seq' | 'atMs'> & { atMs?: number }): JournalRecord {
    const full: JournalRecord = { ...record, seq: this.seq++, atMs: record.atMs ?? this.options.nowMs() };
    this.sink.append(full);
    if (full.reqHash && full.status === 'succeeded') this.cache.set(cacheKey(full.nodeId, full.reqHash), full);
    try {
      this.listener?.(full);
    } catch {
      // A live progress observer must not change workflow execution.
    }
    return full;
  }

  hit(nodeId: string, reqHash: string): JournalRecord | undefined {
    return this.cache.get(cacheKey(nodeId, reqHash));
  }

  all(): JournalRecord[] {
    return this.sink.readAll();
  }

  nodeStatus(nodeId: string): JournalStatus | undefined {
    return this.all().filter((record) => record.nodeId === nodeId).at(-1)?.status;
  }

  /** Settle crash-orphaned running markers without making them cache hits. */
  reconcileOrphanRunning(): number {
    if (!this.sink.replaceAll) return 0;
    const records = this.all();
    let reconciled = 0;
    const settled = records.map((record) => {
      if (record.status !== 'running') return record;
      reconciled++;
      return { ...record, status: 'skipped' as const, errorClass: 'orphan_running' };
    });
    if (reconciled === 0) return 0;
    this.sink.replaceAll(settled);
    this.rebuildCache(settled);
    return reconciled;
  }

  approvalFor(nodeId: string): JournalRecord | undefined {
    return this.all().filter((record) => record.kind === 'approval' && record.nodeId === nodeId).at(-1);
  }

  /**
   * Remove unresolved failure sentinels before a replay. A failed phase and
   * dependency-blocked skips are execution markers, not cache facts; failed
   * attempts followed by a later success remain as audit history. A sink
   * without replacement support leaves durable storage untouched and reports
   * zero so the Host can perform its own rewrite.
   */
  pruneTrailingFailures(): number {
    const records = this.all();
    if (!this.sink.replaceAll) return 0;

    const lastNodeResult = new Map<string, JournalRecord>();
    for (const record of records) {
      if (record.kind === 'node_result') lastNodeResult.set(record.nodeId, record);
    }
    const unresolvedFailedNodes = new Set(
      [...lastNodeResult].filter(([, record]) => record.status === 'failed').map(([nodeId]) => nodeId),
    );
    const kept = records.filter((record) => {
      if (record.kind === 'phase' && record.status === 'failed') return false;
      if (record.kind === 'node_result' && record.status === 'failed' && unresolvedFailedNodes.has(record.nodeId)) return false;
      if (record.kind === 'node_result' && record.status === 'skipped' && record.errorClass === 'dependency_failed') return false;
      return true;
    });
    const removed = records.length - kept.length;
    if (removed === 0) return 0;
    this.sink.replaceAll(kept);
    this.seq = kept.reduce((max, record) => Math.max(max, record.seq + 1), 0);
    this.rebuildCache(kept);
    return removed;
  }

  static memory(options: JournalOptions): Journal {
    return new Journal(new MemoryJournalSink(), options);
  }

  private rebuildCache(records: readonly JournalRecord[]): void {
    this.cache.clear();
    for (const record of records) {
      if (record.reqHash && record.status === 'succeeded') {
        this.cache.set(cacheKey(record.nodeId, record.reqHash), record);
      }
    }
  }
}

function cacheKey(nodeId: string, reqHash: string): string {
  return `${nodeId}\u0000${reqHash}`;
}
