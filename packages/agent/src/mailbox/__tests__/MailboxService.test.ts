import { describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { MailboxService } from '../MailboxService.js';

let nativeSqliteAvailable = true;
try {
  const probe = new Database(':memory:');
  probe.close();
} catch {
  nativeSqliteAvailable = false;
}

function createDb(): Database.Database {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE agent_mailbox (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      submitted_during_run_id TEXT NOT NULL,
      content TEXT NOT NULL,
      kind TEXT NOT NULL,
      status TEXT NOT NULL,
      priority INTEGER NOT NULL DEFAULT 100,
      constraints_json TEXT,
      attachments_json TEXT,
      source TEXT NOT NULL DEFAULT 'ui',
      client_msg_id TEXT,
      created_at INTEGER NOT NULL,
      claim_token TEXT,
      claim_expires_at INTEGER,
      observed_at INTEGER,
      observed_at_checkpoint TEXT,
      observed_by_run_id TEXT,
      claim_attempts INTEGER NOT NULL DEFAULT 0,
      last_claim_error TEXT,
      edit_locked_at INTEGER,
      apply_mode TEXT,
      applied_at INTEGER,
      applied_at_checkpoint TEXT,
      applied_summary TEXT,
      resulting_user_msg_id TEXT,
      failure_reason TEXT,
      edit_history_json TEXT,
      cancelled_at INTEGER,
      cancelled_by TEXT,
      cancel_reason TEXT
    );
  `);
  return db;
}

function insertRow(
  db: Database.Database,
  input: {
    id: string;
    kind?: string;
    priority?: number;
    createdAt?: number;
    status?: string;
    claimExpiresAt?: number | null;
    claimAttempts?: number;
    source?: string;
    applyMode?: string | null;
  },
): void {
  db.prepare(`
    INSERT INTO agent_mailbox (
      id, session_id, submitted_during_run_id, content, kind, status,
      priority, source, created_at, claim_expires_at, claim_attempts, apply_mode
    ) VALUES (
      @id, 's1', 'r0', @content, @kind, @status,
      @priority, @source, @createdAt, @claimExpiresAt, @claimAttempts, @applyMode
    )
  `).run({
    id: input.id,
    content: `content ${input.id}`,
    kind: input.kind ?? 'followup',
    status: input.status ?? 'pending',
    priority: input.priority ?? 100,
    createdAt: input.createdAt ?? Date.now(),
    claimExpiresAt: input.claimExpiresAt ?? null,
    claimAttempts: input.claimAttempts ?? 0,
    source: input.source ?? 'ui',
    applyMode: input.applyMode ?? null,
  });
}

describe.skipIf(!nativeSqliteAvailable)('MailboxService', () => {
  it('claims the highest-priority pending row first', () => {
    const db = createDb();
    insertRow(db, { id: 'followup', kind: 'followup', priority: 100, createdAt: 1 });
    insertRow(db, { id: 'stop', kind: 'stop', priority: 10, createdAt: 2 });

    const service = new MailboxService(db);
    const result = service.claimBatch({
      sessionId: 's1',
      runId: 'run1',
      checkpoint: 'before_model_turn',
    });

    expect(result.rows.map((row) => row.id)).toEqual(['stop']);
    expect(result.claimTokens).toHaveLength(1);
    expect(result.rows[0].status).toBe('observed');
    expect(result.rows[0].edit_locked_at).toBeTypeOf('number');
  });

  it('coalesces rows in the same priority window', () => {
    const db = createDb();
    insertRow(db, { id: 'a', priority: 100, createdAt: 1000, applyMode: 'runtime_instruction' });
    insertRow(db, { id: 'b', priority: 100, createdAt: 1400, applyMode: 'runtime_instruction' });
    insertRow(db, { id: 'c', priority: 100, createdAt: 4000, applyMode: 'runtime_instruction' });

    const service = new MailboxService(db, { coalesceWindowMs: 1500 });
    const result = service.claimBatch({
      sessionId: 's1',
      runId: 'run1',
      checkpoint: 'before_model_turn',
    });

    expect(result.rows.map((row) => row.id)).toEqual(['a', 'b']);
  });

  it('leaves ordinary queued rows unclaimed until they are guided', () => {
    const db = createDb();
    insertRow(db, { id: 'queued', priority: 100, createdAt: 1000, source: 'ui' });
    insertRow(db, { id: 'guided', priority: 100, createdAt: 1001, applyMode: 'runtime_instruction' });

    const service = new MailboxService(db);
    const result = service.claimBatch({
      sessionId: 's1',
      runId: 'run1',
      checkpoint: 'before_model_turn',
    });

    expect(result.rows.map((row) => row.id)).toEqual(['guided']);
  });

  it('reclaims expired observed rows', () => {
    const db = createDb();
    insertRow(db, {
      id: 'expired',
      status: 'observed',
      claimExpiresAt: Date.now() - 1,
      claimAttempts: 1,
      applyMode: 'runtime_instruction',
    });

    const service = new MailboxService(db);
    const result = service.claimBatch({
      sessionId: 's1',
      runId: 'run2',
      checkpoint: 'before_model_turn',
    });

    expect(result.rows).toHaveLength(1);
    expect(result.rows[0].observed_by_run_id).toBe('run2');
    expect(result.rows[0].claim_attempts).toBe(2);
  });

  it('applies only with the active claim token', () => {
    const db = createDb();
    insertRow(db, { id: 'a', applyMode: 'runtime_instruction' });
    const service = new MailboxService(db);
    const claim = service.claimBatch({
      sessionId: 's1',
      runId: 'run1',
      checkpoint: 'before_model_turn',
    });

    expect(() =>
      service.apply({
        id: 'a',
        claimToken: 'stale',
        mode: 'runtime_instruction',
        checkpoint: 'before_model_turn',
        summary: 'nope',
      }),
    ).toThrow(/stale/);

    const row = service.apply({
      id: 'a',
      claimToken: claim.claimTokens[0],
      mode: 'runtime_instruction',
      checkpoint: 'before_model_turn',
      summary: 'absorbed',
    });

    expect(row.status).toBe('applied');
    expect(row.apply_mode).toBe('runtime_instruction');
    expect(row.applied_summary).toBe('absorbed');
  });
});
