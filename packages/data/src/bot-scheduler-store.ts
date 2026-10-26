import type { BotSchedulerState } from '@duya/agent-protocol/bot-inbox-api';
import { randomUUID } from 'node:crypto';
import type { Migration, SqliteDatabase } from './core-database.js';

export const BOT_SCHEDULER_MIGRATIONS: readonly Migration[] = [{
  id: 46, name: 'bot_scheduler_ownership',
  up: (db) => db.exec(`CREATE TABLE bot_scheduler_owners (
    owner_id TEXT NOT NULL, bot_id TEXT NOT NULL,
    mode TEXT NOT NULL CHECK (mode IN ('legacy','host')),
    epoch INTEGER NOT NULL, PRIMARY KEY (owner_id, bot_id)
  )`),
}, {
  id: 47, name: 'bot_dispatch_preemptions',
  up: (db) => db.exec(`CREATE TABLE bot_dispatch_preemptions (
    id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, bot_id TEXT NOT NULL,
    source_inbox_id TEXT NOT NULL, source_run_id TEXT NOT NULL,
    redrive_count INTEGER NOT NULL CHECK (redrive_count BETWEEN 0 AND 3),
    state TEXT NOT NULL CHECK (state IN ('requested','cancel_requested','redriven','superseded','recovery_required')),
    target_inbox_id TEXT, created_ms INTEGER NOT NULL,
    UNIQUE (owner_id, bot_id, source_run_id)
  )`),
}];

/** The data-root owner is local; source/channel identities never choose it. */
export const LOCAL_BOT_OWNER = 'local';

export interface BotDispatchPreemption {
  readonly id: string;
  readonly ownerId: string;
  readonly botId: string;
  readonly sourceInboxId: string;
  readonly sourceRunId: string;
  readonly redriveCount: number;
  readonly state: 'requested' | 'cancel_requested' | 'redriven' | 'superseded' | 'recovery_required';
  readonly targetInboxId: string | null;
}

export class BotSchedulerStore {
  constructor(private readonly db: SqliteDatabase) {}

  get(botId: string, ownerId = LOCAL_BOT_OWNER): BotSchedulerState {
    const row = this.db.prepare('SELECT mode, epoch FROM bot_scheduler_owners WHERE owner_id = ? AND bot_id = ?')
      .get(ownerId, botId) as { mode: 'legacy' | 'host'; epoch: number } | undefined;
    return { ownerId, botId, mode: row?.mode ?? 'legacy', epoch: row?.epoch ?? 0 };
  }

  current(expected: BotSchedulerState): boolean {
    const stored = this.get(expected.botId, expected.ownerId);
    return stored.mode === expected.mode && stored.epoch === expected.epoch;
  }

  /** Mode changes and Run creation use the same SQLite transaction domain. */
  switch(botId: string, mode: 'legacy' | 'host', expectedEpoch: number, ownerId = LOCAL_BOT_OWNER): BotSchedulerState {
    return this.db.transaction(() => {
      const current = this.get(botId, ownerId);
      if (current.epoch !== expectedEpoch) throw new Error('bot_scheduler_revision_conflict');
      if (current.mode === mode) return current;
      const active = this.db.prepare("SELECT 1 FROM runs WHERE session_id = ? AND terminal IS NULL LIMIT 1").get(`bot:${botId}`);
      if (active) throw new Error('bot_scheduler_busy: drain active Runs before transferring ownership');
      const pending = this.db.prepare("SELECT 1 FROM bot_inbox WHERE owner_id = ? AND bot_id = ? AND status IN ('pending','claimed','dispatched') LIMIT 1")
        .get(ownerId, botId);
      if (pending) throw new Error('bot_scheduler_busy: drain accepted inputs before transferring ownership');
      const preemption = this.db.prepare(`SELECT 1 FROM bot_dispatch_preemptions
        WHERE owner_id = ? AND bot_id = ? AND state IN ('requested','cancel_requested') LIMIT 1`).get(ownerId, botId);
      if (preemption) throw new Error('bot_scheduler_busy: reconcile pending preemption before transferring ownership');
      this.db.prepare(`INSERT INTO bot_scheduler_owners(owner_id, bot_id, mode, epoch) VALUES (?, ?, ?, ?)
        ON CONFLICT(owner_id, bot_id) DO UPDATE SET mode = excluded.mode, epoch = excluded.epoch`)
        .run(ownerId, botId, mode, current.epoch + 1);
      return this.get(botId, ownerId);
    })();
  }

  withEpoch<T>(expected: BotSchedulerState, operation: () => T): T {
    return this.db.transaction(() => {
      if (!this.current(expected)) throw new Error('bot_scheduler_fenced');
      return operation();
    })();
  }

  requestPreemption(input: { ownerId: string; botId: string; sourceInboxId: string; sourceRunId: string; redriveCount: number }): BotDispatchPreemption {
    this.db.prepare(`INSERT INTO bot_dispatch_preemptions
      (id, owner_id, bot_id, source_inbox_id, source_run_id, redrive_count, state, target_inbox_id, created_ms)
      VALUES (?, ?, ?, ?, ?, ?, 'requested', NULL, ?) ON CONFLICT(owner_id, bot_id, source_run_id) DO NOTHING`)
      .run(randomUUID(), input.ownerId, input.botId, input.sourceInboxId, input.sourceRunId, input.redriveCount, Date.now());
    return this.db.prepare(`SELECT id, owner_id AS ownerId, bot_id AS botId,
      source_inbox_id AS sourceInboxId, source_run_id AS sourceRunId,
      redrive_count AS redriveCount, state, target_inbox_id AS targetInboxId
      FROM bot_dispatch_preemptions WHERE owner_id = ? AND bot_id = ? AND source_run_id = ?`)
      .get(input.ownerId, input.botId, input.sourceRunId) as BotDispatchPreemption;
  }

  pendingPreemptions(ownerId: string): BotDispatchPreemption[] {
    return this.db.prepare(`SELECT id, owner_id AS ownerId, bot_id AS botId,
      source_inbox_id AS sourceInboxId, source_run_id AS sourceRunId,
      redrive_count AS redriveCount, state, target_inbox_id AS targetInboxId
      FROM bot_dispatch_preemptions WHERE owner_id = ? AND state IN ('requested','cancel_requested')
      ORDER BY created_ms, id`).all(ownerId) as BotDispatchPreemption[];
  }

  updatePreemption(id: string, state: BotDispatchPreemption['state'], targetInboxId: string | null = null): boolean {
    return this.db.prepare(`UPDATE bot_dispatch_preemptions SET state = ?, target_inbox_id = ?
      WHERE id = ? AND state IN ('requested','cancel_requested')`).run(state, targetInboxId, id).changes > 0;
  }
}
