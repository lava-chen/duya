import type Database from 'better-sqlite3';

type MailboxDatabase = Pick<Database.Database, 'prepare'>;

export interface MailboxTransitionResult {
  row: Record<string, unknown>;
  previousContent: string;
}

/** Keep the row claimable and opt it into the agent's in-run checkpoints. */
export function markMailboxForGuidance(
  database: MailboxDatabase,
  id: string,
): MailboxTransitionResult | null {
  const existing = database.prepare(
    'SELECT * FROM agent_mailbox WHERE id = ?',
  ).get(id) as Record<string, unknown> | undefined;
  if (!existing || existing.status !== 'pending') return null;

  const result = database.prepare(`
    UPDATE agent_mailbox
    SET apply_mode = 'runtime_instruction'
    WHERE id = @id AND status = 'pending'
  `).run({ id });
  if (result.changes === 0) return null;

  return {
    row: database.prepare('SELECT * FROM agent_mailbox WHERE id = ?').get(id) as Record<string, unknown>,
    previousContent: String(existing.content ?? ''),
  };
}

/** Claim a queued row for a new user turn after the active run finishes. */
export function promoteQueuedMailbox(
  database: MailboxDatabase,
  id: string,
  now = Date.now(),
): Record<string, unknown> | null {
  const result = database.prepare(`
    UPDATE agent_mailbox
    SET status = 'applied',
        apply_mode = 'promote_to_user_message',
        applied_at = @now,
        applied_at_checkpoint = 'after_current_run',
        applied_summary = 'queued_for_next_agent_turn',
        claim_expires_at = NULL
    WHERE id = @id
      AND status = 'pending'
      AND (apply_mode IS NULL OR apply_mode <> 'runtime_instruction')
  `).run({ id, now });
  if (result.changes === 0) return null;

  return database.prepare('SELECT * FROM agent_mailbox WHERE id = ?').get(id) as Record<string, unknown>;
}
