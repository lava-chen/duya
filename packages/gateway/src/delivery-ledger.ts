/**
 * DeliveryLedger - Durable outbound delivery obligation ledger (JSON file).
 *
 * A final agent response that was generated but not yet confirmed-delivered to
 * the messaging platform is the one artifact the gateway can lose without a
 * trace: the turn already burned its tokens and a crash between finalize and
 * platform ACK drops it silently. This module records a small durable row per
 * outbound final response in a local JSON file, so a restart can re-deliver
 * what was owed.
 *
 * State machine around a send:
 *   recordObligation()   state='pending'     before any send attempt
 *   markAttempting()     state='attempting'  immediately before the await
 *   markDelivered()      state='delivered'   only on a confirmed success
 *   markFailed()         state='failed'      on a definitive rejection
 *
 * On startup, sweepRecoverable() returns rows in recoverable states so the
 * caller can re-deliver. Attempts are capped and stable rows expire, both
 * transitioning to 'abandoned' (kept briefly, then pruned).
 */

import { homedir } from 'node:os';
import { join } from 'node:path';
import { readFileSync, writeFileSync, mkdirSync, existsSync, renameSync } from 'node:fs';
import { randomUUID } from 'node:crypto';

export type LedgerState = 'pending' | 'attempting' | 'delivered' | 'failed' | 'abandoned';

export interface DeliveryObligation {
  id: string;
  sessionKey: string;
  platform: string;
  chatId: string;
  /** Serialized NormalizedReply so the sender can reconstruct the outbound. */
  reply: unknown;
  state: LedgerState;
  attempts: number;
  createdAt: number;
  updatedAt: number;
  lastError?: string;
}

export interface LedgerOptions {
  /** Absolute path to the ledger JSON file. Defaults to ~/.duya/workspace/delivery-ledger.json */
  filePath?: string;
  maxAttempts?: number;
  staleAfterMs?: number;
  retentionMs?: number;
  maxRows?: number;
}

const DEFAULT_MAX_ATTEMPTS = 3;
const DEFAULT_STALE_AFTER_MS = 24 * 60 * 60 * 1000;
const DEFAULT_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const DEFAULT_MAX_ROWS = 500;

// Error patterns that will never succeed on retry. Marking these `failed`
// would keep re-delivering a message every restart until attempts are
// exhausted, piling up undeliverable obligations. They transition straight to
// `abandoned` instead so they are excluded from redelivery.
const PERMANENT_ERROR_PATTERNS: RegExp[] = [
  // Filesystem: missing file / permission / not-a-directory.
  /\bENOENT\b/,
  /\bEACCES\b/,
  /\bEPERM\b/,
  /\bEISDIR\b/,
  /\bENOTDIR\b/,
  /no such file or directory/i,
  // Platform contract violations: the adapter could not read a message id it
  // always requires, so the outbound can never be reconciled with the platform.
  /Cannot read properties of undefined \(reading ['"]message_id['"]\)/,
  /Unknown reply type/i,
];

/**
 * True when the error describes a condition retrying cannot fix. Used by
 * `markFailed` to decide whether an obligation should stay recoverable or be
 * abandoned on the first failure.
 */
export function isPermanentError(error: string): boolean {
  if (!error) return false;
  return PERMANENT_ERROR_PATTERNS.some((re) => re.test(error));
}

export class DeliveryLedger {
  private filePath: string;
  private maxAttempts: number;
  private staleAfterMs: number;
  private retentionMs: number;
  private maxRows: number;
  private rows = new Map<string, DeliveryObligation>();
  private loaded = false;

  constructor(options: LedgerOptions = {}) {
    this.filePath = options.filePath ?? defaultLedgerPath();
    this.maxAttempts = options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
    this.staleAfterMs = options.staleAfterMs ?? DEFAULT_STALE_AFTER_MS;
    this.retentionMs = options.retentionMs ?? DEFAULT_RETENTION_MS;
    this.maxRows = options.maxRows ?? DEFAULT_MAX_ROWS;
  }

  /** Load the ledger file (idempotent). Best-effort: never throws outward. */
  load(): void {
    if (this.loaded) return;
    this.loaded = true;
    try {
      if (!existsSync(this.filePath)) return;
      const parsed = JSON.parse(readFileSync(this.filePath, 'utf8')) as DeliveryObligation[];
      if (Array.isArray(parsed)) {
        for (const row of parsed) {
          if (row && typeof row.id === 'string') {
            this.rows.set(row.id, row);
          }
        }
      }
    } catch {
      // Corrupt file: ignore and start fresh rather than crash the gateway.
    }
  }

  /** Persist the current rows atomically (write temp + rename). */
  private persist(): void {
    try {
      mkdirSync(join(this.filePath, '..'), { recursive: true });
      const tmp = `${this.filePath}.tmp`;
      writeFileSync(tmp, JSON.stringify(Array.from(this.rows.values()), null, 2), 'utf8');
      renameSync(tmp, this.filePath);
    } catch {
      // Best-effort by design: a ledger write failure must never block a send.
    }
  }

  /** Record a final response as owed to the platform (state='pending'). */
  recordObligation(
    sessionKey: string,
    platform: string,
    chatId: string,
    reply: unknown,
  ): string {
    this.load();
    const id = randomUUID();
    const now = Date.now();
    this.rows.set(id, {
      id,
      sessionKey,
      platform,
      chatId,
      reply,
      state: 'pending',
      attempts: 0,
      createdAt: now,
      updatedAt: now,
    });
    this.persist();
    return id;
  }

  private update(id: string, mutate: (row: DeliveryObligation) => void): void {
    this.load();
    const row = this.rows.get(id);
    if (!row) return;
    mutate(row);
    row.updatedAt = Date.now();
    this.persist();
  }

  markAttempting(id: string): void {
    this.update(id, (r) => { r.state = 'attempting'; });
  }

  markDelivered(id: string): void {
    this.update(id, (r) => { r.state = 'delivered'; });
    this.prune();
  }

  markFailed(id: string, error: string): void {
    this.update(id, (r) => {
      r.attempts += 1;
      r.lastError = error?.slice(0, 500);
      // Permanent failures can never succeed on retry, so abandon immediately
      // instead of re-delivering them on every restart until attempts run out.
      if (isPermanentError(error ?? '')) {
        r.state = 'abandoned';
        return;
      }
      r.state = 'failed';
    });
  }

  /**
   * Return recoverable rows (pending/attempting/failed) with attempts left for
   * redelivery. Rows past the attempts cap or stale cutoff transition to
   * 'abandoned' instead of being returned.
   */
  sweepRecoverable(now: number = Date.now()): DeliveryObligation[] {
    this.load();
    const claimable: DeliveryObligation[] = [];
    for (const row of this.rows.values()) {
      if (row.state === 'delivered' || row.state === 'abandoned') continue;
      if (row.attempts >= this.maxAttempts || (now - row.createdAt) > this.staleAfterMs) {
        row.state = 'abandoned';
        row.updatedAt = now;
        continue;
      }
      claimable.push(row);
    }
    this.persist();
    return claimable;
  }

  /** Remove delivered/abandoned rows older than retention, and cap total rows. */
  private prune(now: number = Date.now()): void {
    const cutoff = now - this.retentionMs;
    for (const [id, row] of this.rows) {
      if ((row.state === 'delivered' || row.state === 'abandoned') && row.updatedAt < cutoff) {
        this.rows.delete(id);
      }
    }
    if (this.rows.size > this.maxRows) {
      const sorted = Array.from(this.rows.values()).sort(
        (a, b) => a.updatedAt - b.updatedAt,
      );
      const excess = this.rows.size - this.maxRows;
      for (let i = 0; i < excess; i++) this.rows.delete(sorted[i].id);
    }
    this.persist();
  }

  /** Human-readable snapshot for debugging. */
  debugRows(limit = 20): DeliveryObligation[] {
    this.load();
    return Array.from(this.rows.values())
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .slice(0, limit);
  }
}

function defaultLedgerPath(): string {
  // Durable location that survives gateway restarts (not the temp dir, which
  // may be cleaned). Falls back to ~/.duya.
  return join(homedir(), '.duya', 'delivery-ledger.json');
}

export { defaultLedgerPath };