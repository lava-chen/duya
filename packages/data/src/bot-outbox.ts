import type { BotChannelTarget, BotDelivery, BotDeliveryResult } from '@duya/agent-protocol/bot-delivery-api';
import type { ChannelOutboundMessage } from '@duya/agent-protocol/channels';
import { createHash } from 'node:crypto';
import type { Migration, SqliteDatabase } from './core-database.js';
import { BotInboxStore } from './bot-inbox.js';

export const BOT_OUTBOX_MIGRATIONS: Migration[] = [{
  id: 48,
  name: 'create_bot_outbox',
  up(db) {
    db.exec(`CREATE TABLE bot_outbox (
      id TEXT PRIMARY KEY, inbox_id TEXT NOT NULL, run_id TEXT NOT NULL,
      owner_id TEXT NOT NULL, bot_id TEXT NOT NULL, target_json TEXT NOT NULL,
      outbound_json TEXT NOT NULL, status TEXT NOT NULL
        CHECK(status IN ('pending','sending','delivered','unknown','blocked')),
      attempt INTEGER NOT NULL DEFAULT 0, lease_epoch INTEGER NOT NULL DEFAULT 0,
      deadline_ms INTEGER, remote_message_id TEXT, reason TEXT, created_ms INTEGER NOT NULL
    );
    CREATE INDEX idx_bot_outbox_owner ON bot_outbox(owner_id, status);
    CREATE INDEX idx_bot_outbox_bot ON bot_outbox(owner_id, bot_id, created_ms);`);
  },
}];

interface Row {
  id: string; inbox_id: string; run_id: string; target_json: string; outbound_json: string;
  status: BotDelivery['status']; attempt: number; lease_epoch: number; deadline_ms: number | null;
  remote_message_id: string | null; reason: string | null; created_ms: number;
}

function decode(row: Row): BotDelivery {
  return { id: row.id, inboxId: row.inbox_id, runId: row.run_id,
    target: JSON.parse(row.target_json) as BotChannelTarget,
    outbound: JSON.parse(row.outbound_json) as ChannelOutboundMessage,
    status: row.status, attempt: row.attempt, leaseEpoch: row.lease_epoch,
    deadlineMs: row.deadline_ms, remoteMessageId: row.remote_message_id,
    reason: row.reason, createdAtMs: row.created_ms };
}

/** Same core-db transaction domain as the inbox and RunStore. */
export class BotOutboxStore {
  static readonly migrations = BOT_OUTBOX_MIGRATIONS;
  constructor(private readonly db: SqliteDatabase) {}

  get(id: string): BotDelivery | null {
    const row = this.db.prepare('SELECT * FROM bot_outbox WHERE id = ?').get(id) as Row | undefined;
    return row ? decode(row) : null;
  }

  list(ownerId: string, botId?: string): BotDelivery[] {
    const rows = (botId === undefined
      ? this.db.prepare('SELECT * FROM bot_outbox WHERE owner_id = ? ORDER BY created_ms, id').all(ownerId)
      : this.db.prepare('SELECT * FROM bot_outbox WHERE owner_id = ? AND bot_id = ? ORDER BY created_ms, id').all(ownerId, botId)) as Row[];
    return rows.map(decode);
  }

  /** A terminal is a durable fact, never an SSE done or a caller's assertion. */
  completeInput(inboxId: string, runId: string, target: BotChannelTarget,
    outbound: ChannelOutboundMessage, blockedReason?: string): BotDelivery {
    return this.db.transaction(() => {
      const inbox = new BotInboxStore(this.db);
      const entry = inbox.getById(inboxId);
      const receipt = entry?.dispatchKey ? inbox.lookupReceipt(entry.dispatchKey) : null;
      const run = this.db.prepare('SELECT terminal FROM runs WHERE id = ?').get(runId) as { terminal: string | null } | undefined;
      if (!entry || entry.ownerId !== target.ownerId || entry.botId !== target.botId
        || entry.bindingId !== target.bindingId || entry.source !== `channel:${target.platform}`
        || !receipt || receipt.runId !== runId || !run?.terminal
        || !['dispatched', 'settled'].includes(entry.status)) throw new Error('bot_delivery_identity_conflict');
      const offered = this.db.prepare('SELECT id FROM bot_outbox WHERE inbox_id = ? ORDER BY created_ms, id').all(inboxId) as { id: string }[];
      if (offered.length) {
        if (run.terminal !== 'completed') this.db.prepare(`UPDATE bot_outbox SET status = 'blocked', reason = 'run_not_completed'
          WHERE inbox_id = ? AND status = 'pending'`).run(inboxId);
        const settled = inbox.settle(inboxId);
        if (settled.state !== 'applied' && settled.state !== 'replayed') throw new Error('bot_delivery_settlement_conflict');
        return this.get(offered[0]!.id)!;
      }
      const id = `bot-reply:${inboxId}`;
      // Explicit columns strip any extra caller properties (especially secrets).
      const safeTarget: BotChannelTarget = { ownerId: target.ownerId, botId: target.botId,
        bindingId: target.bindingId, platform: target.platform, chatId: target.chatId,
        ...(target.authorizationRevision === undefined ? {} : { authorizationRevision: target.authorizationRevision }) };
      const safeOutbound: ChannelOutboundMessage = { kind: outbound.kind,
        ...(outbound.content === undefined ? {} : { content: outbound.content }),
        ...(outbound.url === undefined ? {} : { url: outbound.url }),
        ...(outbound.caption === undefined ? {} : { caption: outbound.caption }) };
      const reason = blockedReason ?? (run.terminal === 'completed' ? null : 'run_not_completed');
      this.db.prepare(`INSERT INTO bot_outbox
        (id,inbox_id,run_id,owner_id,bot_id,target_json,outbound_json,status,reason,created_ms)
        VALUES (?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO NOTHING`).run(id, inboxId, runId,
        target.ownerId, target.botId, JSON.stringify(safeTarget), JSON.stringify(safeOutbound),
        reason ? 'blocked' : 'pending', reason, Date.now());
      const settled = inbox.settle(inboxId);
      if (settled.state !== 'applied' && settled.state !== 'replayed') throw new Error('bot_delivery_settlement_conflict');
      return this.get(id)!;
    })();
  }

  /** Called only by the existing SendMessage execution path with its captured attempt. */
  offerReply(inboxId: string, runId: string, epoch: number, target: BotChannelTarget, outbound: ChannelOutboundMessage): BotDelivery {
    return this.db.transaction(() => {
      const inbox = new BotInboxStore(this.db);
      const entry = inbox.getById(inboxId);
      const receipt = inbox.lookupReceipt(`bot-inbox:${inboxId}`);
      const run = this.db.prepare('SELECT epoch, terminal FROM runs WHERE id = ?').get(runId) as { epoch: number; terminal: string | null } | undefined;
      if (!entry || !receipt || receipt.runId !== runId || !run || run.epoch !== epoch || run.terminal !== null
        || entry.ownerId !== target.ownerId || entry.botId !== target.botId || entry.bindingId !== target.bindingId
        || entry.source !== `channel:${target.platform}`
        || !['claimed', 'dispatched'].includes(entry.status)) throw new Error('bot_delivery_attempt_fenced');
      const safeTarget = { ownerId: target.ownerId, botId: target.botId, bindingId: target.bindingId,
        platform: target.platform, chatId: target.chatId,
        ...(target.authorizationRevision === undefined ? {} : { authorizationRevision: target.authorizationRevision }) };
      const safeOutbound = { kind: outbound.kind, content: outbound.content ?? '',
        ...(outbound.url === undefined ? {} : { url: outbound.url }),
        ...(outbound.caption === undefined ? {} : { caption: outbound.caption }) };
      const encoded = JSON.stringify(safeOutbound);
      const id = `bot-reply:${inboxId}:${createHash('sha256').update(encoded).digest('hex')}`;
      const previous = this.db.prepare('SELECT MAX(created_ms) AS latest FROM bot_outbox WHERE inbox_id = ?').get(inboxId) as { latest: number | null };
      const created = Math.max(Date.now(), (previous.latest ?? 0) + 1);
      this.db.prepare(`INSERT INTO bot_outbox
        (id,inbox_id,run_id,owner_id,bot_id,target_json,outbound_json,status,created_ms)
        VALUES (?,?,?,?,?,?,?,'pending',?) ON CONFLICT(id) DO NOTHING`).run(id, inboxId, runId,
        target.ownerId, target.botId, JSON.stringify(safeTarget), encoded, created);
      return this.get(id)!;
    })();
  }

  /** Commit sending BEFORE touching the network; an expired send is unknown. */
  claim(id: string, deadlineMs: number, now = Date.now()): BotDelivery | null {
    if (!Number.isFinite(deadlineMs) || deadlineMs <= now) throw new Error('invalid_delivery_deadline');
    return this.db.transaction(() => {
      const changed = this.db.prepare(`UPDATE bot_outbox SET status = 'sending',
        lease_epoch = lease_epoch + 1, attempt = attempt + 1, deadline_ms = ?
        WHERE id = ? AND status = 'pending' AND attempt < 3
        AND EXISTS (SELECT 1 FROM bot_inbox WHERE bot_inbox.id = bot_outbox.inbox_id AND bot_inbox.status = 'settled')`).run(deadlineMs, id);
      return changed.changes ? this.get(id) : null;
    })();
  }

  record(grant: BotDelivery, result: BotDeliveryResult, now = Date.now()): boolean {
    const status = result.state === 'delivered' ? 'delivered' : result.state === 'not_sent' ? 'blocked' : 'unknown';
    // Persist fixed error codes only; provider errors can contain tokens and URLs.
    return this.db.prepare(`UPDATE bot_outbox SET status = ?, remote_message_id = ?,
      reason = ?, deadline_ms = NULL WHERE id = ? AND status = 'sending'
      AND lease_epoch = ? AND deadline_ms > ?`).run(status,
      result.state === 'delivered' ? result.remoteMessageId : null,
      result.state === 'not_sent' ? 'transport_not_sent' : result.state === 'unknown' ? 'send_outcome_unknown' : null,
      grant.id, grant.leaseEpoch, now).changes > 0;
  }

  recoverExpired(ownerId: string, now = Date.now()): void {
    this.db.prepare(`UPDATE bot_outbox SET status = 'blocked', reason = 'input_recovery_required'
      WHERE owner_id = ? AND status = 'pending' AND EXISTS
      (SELECT 1 FROM bot_inbox WHERE bot_inbox.id = bot_outbox.inbox_id AND bot_inbox.status = 'dead_letter')`).run(ownerId);
    this.db.prepare(`UPDATE bot_outbox SET status = 'unknown', reason = 'send_interrupted',
      deadline_ms = NULL WHERE owner_id = ? AND status = 'sending' AND deadline_ms <= ?`).run(ownerId, now);
  }

  /** Positive provider evidence only. Unknown never becomes an automatic resend. */
  reconcile(id: string, epoch: number, result: BotDeliveryResult): boolean {
    if (result.state === 'unknown') return false;
    return this.db.prepare(`UPDATE bot_outbox SET status = ?, remote_message_id = ?, reason = ?
      WHERE id = ? AND status = 'unknown' AND lease_epoch = ?`).run(
      result.state === 'delivered' ? 'delivered' : 'blocked',
      result.state === 'delivered' ? result.remoteMessageId : null,
      result.state === 'not_sent' ? 'transport_not_sent' : null, id, epoch).changes > 0;
  }

  hasWork(ownerId: string): boolean {
    return this.db.prepare("SELECT 1 FROM bot_outbox WHERE owner_id = ? AND status IN ('pending','sending') LIMIT 1").get(ownerId) !== undefined;
  }
}
