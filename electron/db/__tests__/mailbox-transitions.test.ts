import type Database from 'better-sqlite3';
import { beforeEach, describe, expect, it } from 'vitest';
import { markMailboxForGuidance, promoteQueuedMailbox } from '../mailbox-transitions';

class FakeMailboxDatabase {
  readonly rows = new Map<string, Record<string, unknown>>();

  prepare(sql: string) {
    const normalized = sql.replace(/\s+/g, ' ').trim();
    return {
      get: (id: string) => {
        const row = this.rows.get(id);
        return row ? { ...row } : undefined;
      },
      run: (params: { id: string; now?: number }) => {
        const row = this.rows.get(params.id);
        if (!row || row.status !== 'pending') return { changes: 0 };
        if (normalized.includes("apply_mode = 'runtime_instruction'")) {
          row.apply_mode = 'runtime_instruction';
        } else if (normalized.includes("apply_mode = 'promote_to_user_message'")) {
          if (row.apply_mode === 'runtime_instruction') return { changes: 0 };
          row.status = 'applied';
          row.apply_mode = 'promote_to_user_message';
          row.applied_at = params.now;
          row.applied_at_checkpoint = 'after_current_run';
          row.applied_summary = 'queued_for_next_agent_turn';
          row.claim_expires_at = null;
        }
        return { changes: 1 };
      },
    };
  }
}

describe('mailbox transitions', () => {
  let fake: FakeMailboxDatabase;
  let database: Database.Database;

  beforeEach(() => {
    fake = new FakeMailboxDatabase();
    database = fake as unknown as Database.Database;
  });

  function insert(id: string, status = 'pending', source = 'ui'): void {
    fake.rows.set(id, {
      id,
      content: `content:${id}`,
      status,
      source,
      apply_mode: null,
      applied_at: null,
      applied_at_checkpoint: null,
      applied_summary: null,
      claim_expires_at: null,
    });
  }

  it('keeps guided messages pending and marks them claimable by the agent', () => {
    insert('guided');

    const result = markMailboxForGuidance(database, 'guided');

    expect(result?.row).toMatchObject({
      id: 'guided',
      status: 'pending',
      source: 'ui',
      apply_mode: 'runtime_instruction',
    });
    expect(result?.previousContent).toBe('content:guided');
  });

  it('is idempotent when a guided message is clicked again', () => {
    insert('guided', 'pending', 'ui');
    fake.rows.get('guided')!.apply_mode = 'runtime_instruction';

    const result = markMailboxForGuidance(database, 'guided');

    expect(result?.row.apply_mode).toBe('runtime_instruction');
  });

  it('promotes the next FIFO item into a real user turn only after the run', () => {
    insert('queued');

    const row = promoteQueuedMailbox(database, 'queued', 1234);

    expect(row).toMatchObject({
      id: 'queued',
      status: 'applied',
      apply_mode: 'promote_to_user_message',
      applied_at: 1234,
      applied_at_checkpoint: 'after_current_run',
      applied_summary: 'queued_for_next_agent_turn',
    });
  });

  it('does not queue a row the agent has already claimed', () => {
    insert('observed', 'observed');

    expect(promoteQueuedMailbox(database, 'observed')).toBeNull();
  });

  it('does not promote a guided row into a later user turn', () => {
    insert('guided');
    fake.rows.get('guided')!.apply_mode = 'runtime_instruction';

    expect(promoteQueuedMailbox(database, 'guided')).toBeNull();
  });
});
