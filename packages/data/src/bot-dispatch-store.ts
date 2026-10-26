import type { SqliteDatabase } from './core-database.js';
import {
  BotInboxStore,
  type BotInboxClaimGrant,
  type BotInboxEntry,
  type BotDispatchReserveOutcome,
} from './bot-inbox.js';

/** Fenced dispatcher operations over the S3a tables; no additional schema. */
export class BotDispatchStore {
  readonly inbox: BotInboxStore;

  constructor(private readonly db: SqliteDatabase) {
    this.inbox = new BotInboxStore(db);
  }

  outstanding(ownerId: string): BotInboxEntry[] {
    const rows = this.db.prepare(`SELECT id FROM bot_inbox
      WHERE owner_id = ? AND status IN ('pending', 'claimed', 'dispatched')
      ORDER BY created_ms, id`).all(ownerId) as { id: string }[];
    return rows.map(({ id }) => this.inbox.getById(id)!);
  }

  hasOutstanding(ownerId: string): boolean {
    return this.db.prepare(`SELECT 1 FROM bot_inbox
      WHERE owner_id = ? AND status IN ('pending', 'claimed', 'dispatched') LIMIT 1`)
      .get(ownerId) !== undefined;
  }

  requeueExpired(ownerId: string, now: number): void {
    this.db.prepare(`UPDATE bot_inbox SET status = 'pending', lease_owner = NULL,
      deadline_ms = NULL, attempt = attempt + 1 WHERE owner_id = ? AND status = 'claimed'
      AND deadline_ms IS NOT NULL AND deadline_ms <= ?`).run(ownerId, now);
  }

  claim(ownerId: string, botId: string, leaseOwner: string, deadlineMs: number): BotInboxClaimGrant | null {
    return this.db.transaction(() => {
      const row = this.db.prepare(`SELECT id FROM bot_inbox
        WHERE owner_id = ? AND bot_id = ? AND status = 'pending'
        ORDER BY CASE lane WHEN 'user' THEN 0 WHEN 'agent' THEN 1 ELSE 2 END, created_ms, id
        LIMIT 1`).get(ownerId, botId) as { id: string } | undefined;
      if (!row) return null;
      this.db.prepare(`UPDATE bot_inbox SET status = 'claimed', lease_owner = ?,
        lease_epoch = COALESCE(lease_epoch, 0) + 1, deadline_ms = ?, claimed_at_ms = ?
        WHERE id = ? AND status = 'pending'`).run(leaseOwner, deadlineMs, Date.now(), row.id);
      const entry = this.inbox.getById(row.id)!;
      return { entry, leaseOwner, leaseEpoch: entry.leaseEpoch!, deadlineMs };
    })();
  }

  isCurrent(grant: BotInboxClaimGrant, now = Date.now()): boolean {
    const row = this.inbox.getById(grant.entry.id);
    return row !== null && row.status === 'claimed' && row.leaseOwner === grant.leaseOwner
      && row.leaseEpoch === grant.leaseEpoch && row.deadlineMs !== null && row.deadlineMs > now;
  }

  reserve(grant: BotInboxClaimGrant, dispatchKey: string, candidateRunId: string): BotDispatchReserveOutcome | null {
    return this.db.transaction(() => this.isCurrent(grant)
      ? this.inbox.reserve(dispatchKey, candidateRunId) : null)();
  }

  record(grant: BotInboxClaimGrant, dispatchKey: string, runId: string): boolean {
    return this.db.transaction(() => {
      if (!this.isCurrent(grant)) return false;
      const result = this.inbox.recordDispatch(grant.entry.id, dispatchKey, runId);
      return result.state === 'applied' || result.state === 'replayed';
    })();
  }

  /** Release only an unreserved claim; a reserved start must be reconciled. */
  release(grant: BotInboxClaimGrant, dispatchKey: string): boolean {
    return this.db.transaction(() => {
      if (!this.isCurrent(grant)) return false;
      if (this.inbox.lookupReceipt(dispatchKey)) return false;
      return this.db.prepare(`UPDATE bot_inbox SET status = 'pending',
        lease_owner = NULL, deadline_ms = NULL WHERE id = ? AND status = 'claimed'
        AND lease_owner = ? AND lease_epoch = ?`)
        .run(grant.entry.id, grant.leaseOwner, grant.leaseEpoch).changes > 0;
    })();
  }

  deadLetter(grant: BotInboxClaimGrant, reason: string): boolean {
    return this.db.transaction(() => {
      if (!this.isCurrent(grant)) return false;
      return this.inbox.deadLetter(grant.entry.id, reason).state === 'applied';
    })();
  }
}
