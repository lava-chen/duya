/**
 * Mailbox tests — ported from the deleted dead code:
 *  - `packages/agent/src/mailbox/__tests__/MailboxService.test.ts` (6 tests)
 *  - `packages/agent/src/mailbox/__tests__/assertValidApply.test.ts` (matrix)
 *  - `electron/db/__tests__/mailbox-transitions.test.ts` (5 tests, guide/promoteQueued)
 *
 * Per plan 327 Phase 1: "原 53 例的构成... MailboxService.test.ts 随 Phase 0 死代码删除,
 * 其 claim/apply/defer/cancel 语义并入本文件移植范围; 其余 3 个测活代码, 保留原位。"
 * Plan 328 deleted `mailbox-transitions.ts` and its test (the old `agent_mailbox`
 * table path); this file is now the sole mailbox state-machine test.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  ApplyViolationError,
  Mailbox,
  type CheckpointType,
  type MailboxApplyMode,
  type MailboxItem,
  type MailboxKind,
  type MailboxStatus,
} from '../mailbox';
import type { SqliteDatabase } from '../database';

let nativeSqliteAvailable = true;
try {
  const probe = new Database(':memory:');
  probe.close();
} catch {
  nativeSqliteAvailable = false;
}

describe.skipIf(!nativeSqliteAvailable)('Mailbox', () => {
  let tempDir: string;
  let db: SqliteDatabase;
  let mailbox: Mailbox;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'core-mailbox-test-'));
    db = new Database(path.join(tempDir, 'core.db')) as unknown as SqliteDatabase;
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
    for (const m of Mailbox.migrations) m.up(db);
    mailbox = new Mailbox(db);
  });

  afterEach(() => {
    try { db.close(); } catch { /* already closed */ }
    try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch { /* best-effort */ }
  });

  function enqueue(overrides: Partial<{
    id: string;
    sessionId: string;
    kind: MailboxKind;
    content: string;
    submittedRunId: string;
    clientMsgId: string | null;
    source: string;
    attachments: unknown[];
    meta: Record<string, unknown>;
  }> = {}): MailboxItem {
    return mailbox.enqueue({
      id: overrides.id ?? `m-${Math.random().toString(36).slice(2, 10)}`,
      sessionId: overrides.sessionId ?? 's1',
      submittedRunId: overrides.submittedRunId ?? 'r0',
      content: overrides.content ?? 'hello',
      kind: overrides.kind ?? 'followup',
      clientMsgId: overrides.clientMsgId ?? null,
      source: overrides.source ?? 'ui',
      attachments: overrides.attachments,
      meta: overrides.meta,
    });
  }

  /** Helper: insert an observed row with a stale claim token + expired lease. */
  function enqueueObservedExpired(id: string, claimAttempts = 1): MailboxItem {
    const item = enqueue({
      id,
      kind: 'followup',
      content: `content:${id}`,
    });
    const expiresAt = Date.now() - 1;
    db.prepare(
      `UPDATE mailbox_items SET status='observed', claim_token=@t, claim_expires_at=@e,
        claim_attempts=@a, observed_at=@now, observed_at_checkpoint='before_model_turn',
        observed_by_run_id='r-prev', edit_locked_at=@now WHERE id=@id`,
    ).run({ id, t: 'stale-token', e: expiresAt, a: claimAttempts, now: Date.now() });
    return mailbox.get(id)!;
  }

  // ─── Enqueue ───

  it('enqueue inserts a pending row with default priority per kind', () => {
    const followup = enqueue({ id: 'f1', kind: 'followup' });
    expect(followup.status).toBe('pending');
    expect(followup.priority).toBe(10);
    expect(followup.source).toBe('ui');
    expect(followup.attachments).toBeNull();
    expect(followup.meta).toEqual({});

    const queued = enqueue({ id: 'q1', kind: 'queued' });
    expect(queued.priority).toBe(100);

    const bg = enqueue({ id: 'b1', kind: 'background_notification' });
    expect(bg.priority).toBe(50);
  });

  it('enqueue is idempotent on client_msg_id collision', () => {
    const first = enqueue({ id: 'a', clientMsgId: 'cm-1', content: 'first' });
    const second = mailbox.enqueue({
      id: 'b',
      sessionId: 's1',
      submittedRunId: 'r0',
      content: 'second',
      kind: 'followup',
      clientMsgId: 'cm-1',
    });
    expect(second.id).toBe('a');
    expect(second.content).toBe('first');
    expect(mailbox.listForSession('s1')).toHaveLength(1);
  });

  it('enqueue stores attachments and meta JSON', () => {
    const item = enqueue({
      id: 'a1',
      attachments: [{ type: 'file', name: 'foo.txt' }],
      meta: { constraints: { maxTokens: 1000 } },
    });
    const fetched = mailbox.get('a1')!;
    expect(fetched.attachments).toEqual([{ type: 'file', name: 'foo.txt' }]);
    expect(fetched.meta).toEqual({ constraints: { maxTokens: 1000 } });
  });

  // ─── Edit ───

  it('edit updates content and appends edit history to meta', () => {
    enqueue({ id: 'e1', content: 'orig', kind: 'followup' });
    const edited = mailbox.edit('e1', { content: 'edited' })!;
    expect(edited.content).toBe('edited');
    const history = edited.meta.editHistory as Array<{ prevContent: string; prevKind: string }>;
    expect(history).toHaveLength(1);
    expect(history[0].prevContent).toBe('orig');
    expect(history[0].prevKind).toBe('followup');
  });

  it('edit changes kind and updates priority', () => {
    enqueue({ id: 'e2', kind: 'queued', content: 'hi' });
    const edited = mailbox.edit('e2', { kind: 'followup' })!;
    expect(edited.kind).toBe('followup');
    expect(edited.priority).toBe(10);
  });

  it('edit returns null when row is missing, not pending, or locked', () => {
    enqueue({ id: 'e3', kind: 'followup' });
    db.prepare('UPDATE mailbox_items SET edit_locked_at = ? WHERE id = ?').run(Date.now(), 'e3');
    expect(mailbox.edit('e3', { content: 'x' })).toBeNull();

    enqueue({ id: 'e4', kind: 'followup' });
    db.prepare("UPDATE mailbox_items SET status = 'observed' WHERE id = ?").run('e4');
    expect(mailbox.edit('e4', { content: 'x' })).toBeNull();

    expect(mailbox.edit('missing', { content: 'x' })).toBeNull();
  });

  // ─── guide / promoteQueued (ported from mailbox-transitions.test.ts) ───

  it('guide keeps pending status and marks the row claimable at before_model_turn', () => {
    const item = enqueue({ id: 'g1', kind: 'queued', content: 'content:g1' });
    const guided = mailbox.guide('g1')!;
    expect(guided.status).toBe('pending');
    expect(guided.kind).toBe('followup');
    expect(guided.applyMode).toBe('runtime_instruction');
  });

  it('guide is idempotent on re-click', () => {
    enqueue({ id: 'g2', kind: 'queued' });
    mailbox.guide('g2');
    const second = mailbox.guide('g2')!;
    expect(second.applyMode).toBe('runtime_instruction');
    expect(second.kind).toBe('followup');
  });

  it('guide returns null when row is missing or not pending', () => {
    expect(mailbox.guide('missing')).toBeNull();
    enqueue({ id: 'g3', kind: 'followup' });
    db.prepare("UPDATE mailbox_items SET status = 'observed' WHERE id = ?").run('g3');
    expect(mailbox.guide('g3')).toBeNull();
  });

  it('promoteQueued flips a pending non-guided row to applied', () => {
    enqueue({ id: 'p1', kind: 'queued' });
    const row = mailbox.promoteQueued('s1', 'p1', 1234)!;
    expect(row.status).toBe('applied');
    expect(row.applyMode).toBe('promote_to_user_message');
    expect(row.appliedAt).toBe(1234);
    expect(row.appliedAtCheckpoint).toBe('after_current_run');
    expect(row.appliedSummary).toBe('queued_for_next_agent_turn');
    expect(row.claimExpiresAt).toBeNull();
  });

  it('promoteQueued returns null for non-pending rows (already observed)', () => {
    enqueue({ id: 'p2', kind: 'queued' });
    db.prepare("UPDATE mailbox_items SET status = 'observed' WHERE id = ?").run('p2');
    expect(mailbox.promoteQueued('s1', 'p2')).toBeNull();
  });

  it('promoteQueued does not promote a guided row (apply_mode=runtime_instruction)', () => {
    enqueue({ id: 'p3', kind: 'queued' });
    mailbox.guide('p3');
    expect(mailbox.promoteQueued('s1', 'p3')).toBeNull();
  });

  it('promoteQueued is session-scoped (wrong session returns null)', () => {
    enqueue({ id: 'p4', kind: 'queued', sessionId: 's1' });
    expect(mailbox.promoteQueued('other-session', 'p4')).toBeNull();
  });

  // ─── cancel / cancelByAgent ───

  it('cancel sets status=cancelled with cancelled_by=user', () => {
    enqueue({ id: 'c1', kind: 'followup' });
    const cancelled = mailbox.cancel('c1', 'user changed mind')!;
    expect(cancelled.status).toBe('cancelled');
    expect(cancelled.cancelledBy).toBe('user');
    expect(cancelled.cancelReason).toBe('user changed mind');
    expect(cancelled.cancelledAt).toBeTypeOf('number');
  });

  it('cancel returns null when row is not pending', () => {
    enqueue({ id: 'c2', kind: 'followup' });
    db.prepare("UPDATE mailbox_items SET status = 'observed' WHERE id = ?").run('c2');
    expect(mailbox.cancel('c2')).toBeNull();
  });

  it('cancelByAgent requires a valid claim token', () => {
    enqueue({ id: 'c3', kind: 'followup' });
    const claim = mailbox.claimBatch({
      sessionId: 's1', runId: 'r1', checkpoint: 'before_model_turn',
    });
    expect(claim.rows.map((r) => r.id)).toContain('c3');

    const cancelled = mailbox.cancelByAgent({ id: 'c3', claimToken: claim.claimTokens[0], reason: 'stale' })!;
    expect(cancelled.status).toBe('cancelled');
    expect(cancelled.cancelledBy).toBe('agent');
    expect(cancelled.cancelReason).toBe('stale');

    // Wrong token: no change, returns null
    enqueue({ id: 'c4', kind: 'followup' });
    const claim2 = mailbox.claimBatch({
      sessionId: 's1', runId: 'r1', checkpoint: 'before_model_turn',
    });
    const c4token = claim2.claimTokens[0];
    expect(mailbox.cancelByAgent({ id: 'c4', claimToken: 'wrong-token', reason: 'x' })).toBeNull();
    // Valid token still works
    expect(mailbox.cancelByAgent({ id: 'c4', claimToken: c4token, reason: 'now-cancel' })!.status).toBe('cancelled');
  });

  // ─── claimBatch (ported from MailboxService.test.ts) ───

  it('claims the highest-priority pending row first', () => {
    // followup (priority 10) beats background_notification (priority 50)
    mailbox.enqueue({ id: 'low', sessionId: 's1', submittedRunId: 'r0', content: 'low', kind: 'background_notification' });
    mailbox.enqueue({ id: 'high', sessionId: 's1', submittedRunId: 'r0', content: 'high', kind: 'followup' });
    db.prepare('UPDATE mailbox_items SET created_at = ? WHERE id = ?').run(2, 'low');
    db.prepare('UPDATE mailbox_items SET created_at = ? WHERE id = ?').run(1, 'high');

    const result = mailbox.claimBatch({
      sessionId: 's1', runId: 'run1', checkpoint: 'before_model_turn',
    });

    expect(result.rows.map((r) => r.id)).toEqual(['high']);
    expect(result.claimTokens).toHaveLength(1);
    expect(result.rows[0].status).toBe('observed');
    expect(result.rows[0].editLockedAt).toBeTypeOf('number');
    expect(result.rows[0].observedByRunId).toBe('run1');
  });

  it('coalesces rows in the same priority window', () => {
    // Use background_notification (priority 50) so all three share priority
    mailbox.enqueue({ id: 'a', sessionId: 's1', submittedRunId: 'r0', content: 'a', kind: 'background_notification' });
    mailbox.enqueue({ id: 'b', sessionId: 's1', submittedRunId: 'r0', content: 'b', kind: 'background_notification' });
    mailbox.enqueue({ id: 'c', sessionId: 's1', submittedRunId: 'r0', content: 'c', kind: 'background_notification' });
    db.prepare('UPDATE mailbox_items SET created_at = ? WHERE id = ?').run(1000, 'a');
    db.prepare('UPDATE mailbox_items SET created_at = ? WHERE id = ?').run(1400, 'b');
    db.prepare('UPDATE mailbox_items SET created_at = ? WHERE id = ?').run(4000, 'c');

    const result = mailbox.claimBatch({
      sessionId: 's1', runId: 'run1', checkpoint: 'before_model_turn', coalesceWindowMs: 1500,
    });

    expect(result.rows.map((r) => r.id)).toEqual(['a', 'b']);
  });

  it('excludes queued rows at before_model_turn but claims followup rows', () => {
    mailbox.enqueue({ id: 'queued', sessionId: 's1', submittedRunId: 'r0', content: 'q', kind: 'queued' });
    mailbox.enqueue({ id: 'followup', sessionId: 's1', submittedRunId: 'r0', content: 'f', kind: 'followup' });

    const result = mailbox.claimBatch({
      sessionId: 's1', runId: 'run1', checkpoint: 'before_model_turn',
    });

    expect(result.rows.map((r) => r.id)).toEqual(['followup']);
  });

  it('claims queued rows only at before_final_answer, not before_model_turn', () => {
    mailbox.enqueue({ id: 'queued-a', sessionId: 's1', submittedRunId: 'r0', content: 'qa', kind: 'queued' });
    mailbox.enqueue({ id: 'queued-b', sessionId: 's1', submittedRunId: 'r0', content: 'qb', kind: 'queued' });
    db.prepare('UPDATE mailbox_items SET created_at = ? WHERE id = ?').run(1000, 'queued-a');
    db.prepare('UPDATE mailbox_items SET created_at = ? WHERE id = ?').run(1001, 'queued-b');

    const modelTurn = mailbox.claimBatch({
      sessionId: 's1', runId: 'run1', checkpoint: 'before_model_turn',
    });
    expect(modelTurn.rows).toEqual([]);

    const finalAnswer = mailbox.claimBatch({
      sessionId: 's1', runId: 'run1', checkpoint: 'before_final_answer',
    });
    expect(finalAnswer.rows.map((r) => r.id)).toEqual(['queued-a', 'queued-b']);
  });

  it('reclaims expired observed rows and increments claim_attempts', () => {
    enqueueObservedExpired('expired', 1);

    const result = mailbox.claimBatch({
      sessionId: 's1', runId: 'run2', checkpoint: 'before_model_turn',
    });

    expect(result.rows).toHaveLength(1);
    expect(result.rows[0].observedByRunId).toBe('run2');
    expect(result.rows[0].claimAttempts).toBe(2);
  });

  it('auto-cancels rows exceeding maxClaimAttempts', () => {
    enqueueObservedExpired('doomed', 5);

    const result = mailbox.claimBatch({
      sessionId: 's1', runId: 'run2', checkpoint: 'before_model_turn', maxClaimAttempts: 5,
    });

    expect(result.rows).toEqual([]);
    const row = mailbox.get('doomed')!;
    expect(row.status).toBe('cancelled');
    expect(row.cancelledBy).toBe('system:max_claim_attempts');
    expect(row.cancelReason).toBe('max_claim_attempts_exceeded');
  });

  // ─── apply / defer ───

  it('apply only succeeds with the active claim token', () => {
    enqueue({ id: 'a1', kind: 'followup' });
    const claim = mailbox.claimBatch({
      sessionId: 's1', runId: 'run1', checkpoint: 'before_model_turn',
    });

    expect(() =>
      mailbox.apply({
        id: 'a1', claimToken: 'stale', mode: 'runtime_instruction',
        checkpoint: 'before_model_turn', summary: 'nope',
      }),
    ).toThrow(/stale/);

    const row = mailbox.apply({
      id: 'a1', claimToken: claim.claimTokens[0], mode: 'runtime_instruction',
      checkpoint: 'before_model_turn', summary: 'absorbed',
    });

    expect(row.status).toBe('applied');
    expect(row.applyMode).toBe('runtime_instruction');
    expect(row.appliedSummary).toBe('absorbed');
    expect(row.claimExpiresAt).toBeNull();
  });

  it('apply writes resultingEventId when provided', () => {
    enqueue({ id: 'a2', kind: 'followup' });
    const claim = mailbox.claimBatch({
      sessionId: 's1', runId: 'run1', checkpoint: 'before_model_turn',
    });
    const row = mailbox.apply({
      id: 'a2', claimToken: claim.claimTokens[0], mode: 'promote_to_user_message',
      checkpoint: 'before_model_turn', summary: 'promoted',
      resultingEventId: 'evt-123',
    });
    expect(row.resultingEventId).toBe('evt-123');
  });

  it('defer applies as deferred_to_next_turn AND inserts a pending mirror row', () => {
    enqueue({ id: 'd1', kind: 'followup', content: 'defer-me' });
    const claim = mailbox.claimBatch({
      sessionId: 's1', runId: 'run1', checkpoint: 'before_model_turn',
    });

    const applied = mailbox.defer({
      id: 'd1', claimToken: claim.claimTokens[0], reason: 'wait',
      checkpoint: 'after_model_turn',
    });

    expect(applied.status).toBe('applied');
    expect(applied.applyMode).toBe('deferred_to_next_turn');
    expect(applied.appliedSummary).toBe('wait');

    const items = mailbox.listForSession('s1');
    expect(items).toHaveLength(2);
    const mirror = items.find((r) => r.status === 'pending')!;
    expect(mirror).toBeDefined();
    expect(mirror.content).toBe('defer-me');
    expect(mirror.kind).toBe('followup');
    expect(mirror.source).toBe('system');
  });

  // ─── list / listForSession ───

  it('list filters by status and limits', () => {
    enqueue({ id: 'l1', kind: 'followup' });
    enqueue({ id: 'l2', kind: 'followup' });
    enqueue({ id: 'l3', kind: 'followup' });
    db.prepare("UPDATE mailbox_items SET status = 'observed' WHERE id = ?").run('l2');

    const pending = mailbox.list('s1', { status: ['pending'] });
    expect(pending.map((r) => r.id).sort()).toEqual(['l1', 'l3']);

    const observed = mailbox.list('s1', { status: ['observed'] });
    expect(observed.map((r) => r.id)).toEqual(['l2']);

    const limited = mailbox.list('s1', { limit: 1 });
    expect(limited).toHaveLength(1);
  });

  it('listForSession returns all rows ASC by created_at', () => {
    enqueue({ id: 'f1', kind: 'followup' });
    enqueue({ id: 'f2', kind: 'followup' });
    db.prepare('UPDATE mailbox_items SET created_at = ? WHERE id = ?').run(100, 'f1');
    db.prepare('UPDATE mailbox_items SET created_at = ? WHERE id = ?').run(200, 'f2');
    const items = mailbox.listForSession('s1');
    expect(items.map((r) => r.id)).toEqual(['f1', 'f2']);
  });

  // ─── apply matrix (ported from assertValidApply.test.ts) ───

  const ALL_CHECKPOINTS: CheckpointType[] = [
    'before_model_turn', 'after_model_turn', 'before_tool_call', 'after_tool_call',
    'before_file_write', 'before_shell_command', 'before_final_answer',
    'on_permission_request', 'on_error_recovery',
  ];
  const ALL_MODES: MailboxApplyMode[] = [
    'promote_to_user_message', 'runtime_instruction', 'tool_guard',
    'permission_context', 'interrupt_signal', 'deferred_to_next_turn',
  ];
  const PERMITTED_BY_CHECKPOINT: Record<CheckpointType, ReadonlyArray<MailboxApplyMode>> = {
    before_model_turn: ['promote_to_user_message', 'runtime_instruction', 'interrupt_signal'],
    after_model_turn: ['runtime_instruction', 'interrupt_signal', 'deferred_to_next_turn'],
    before_tool_call: ['tool_guard', 'interrupt_signal', 'runtime_instruction'],
    after_tool_call: ['runtime_instruction', 'tool_guard', 'interrupt_signal', 'deferred_to_next_turn'],
    before_file_write: ['tool_guard', 'interrupt_signal'],
    before_shell_command: ['tool_guard', 'interrupt_signal'],
    before_final_answer: ['promote_to_user_message', 'runtime_instruction', 'interrupt_signal'],
    on_permission_request: ['permission_context', 'interrupt_signal'],
    on_error_recovery: ['runtime_instruction', 'interrupt_signal', 'deferred_to_next_turn'],
  };

  describe('assertApplyAllowed — matrix acceptance', () => {
    for (const checkpoint of ALL_CHECKPOINTS) {
      const permitted = PERMITTED_BY_CHECKPOINT[checkpoint];
      for (const mode of permitted) {
        it(`accepts (${checkpoint}, ${mode})`, () => {
          expect(() => Mailbox.assertApplyAllowed(checkpoint, mode)).not.toThrow();
          expect(Mailbox.isValidApply(checkpoint, mode)).toBe(true);
        });
      }
    }
  });

  describe('assertApplyAllowed — matrix rejection', () => {
    for (const checkpoint of ALL_CHECKPOINTS) {
      const permitted = new Set(PERMITTED_BY_CHECKPOINT[checkpoint]);
      for (const mode of ALL_MODES) {
        if (permitted.has(mode)) continue;
        it(`rejects (${checkpoint}, ${mode}) with ApplyViolationError`, () => {
          expect(() => Mailbox.assertApplyAllowed(checkpoint, mode)).toThrow(ApplyViolationError);
          try {
            Mailbox.assertApplyAllowed(checkpoint, mode);
          } catch (err) {
            expect(err).toBeInstanceOf(ApplyViolationError);
            const violation = err as ApplyViolationError;
            expect(violation.checkpoint).toBe(checkpoint);
            expect(violation.mode).toBe(mode);
            expect(violation.name).toBe('ApplyViolationError');
            expect(violation.message).toContain(checkpoint);
            expect(violation.message).toContain(mode);
          }
        });
      }
    }
  });

  describe('isValidApply — predicate symmetry', () => {
    it('agrees with assertApplyAllowed on every (checkpoint, mode) pair', () => {
      let permits = 0;
      let rejects = 0;
      for (const checkpoint of ALL_CHECKPOINTS) {
        for (const mode of ALL_MODES) {
          const predicate = Mailbox.isValidApply(checkpoint, mode);
          let throws = false;
          try { Mailbox.assertApplyAllowed(checkpoint, mode); } catch { throws = true; }
          expect(predicate).toBe(!throws);
          if (predicate) permits += 1;
          else rejects += 1;
        }
      }
      // Sanity: 9×6 = 54 grid, 25 permitted, 29 forbidden.
      expect(permits).toBe(25);
      expect(rejects).toBe(29);
    });
  });

  describe('ApplyViolationError — invariant I4 hint', () => {
    it('names the violated pair in the message', () => {
      const err = new ApplyViolationError('before_tool_call', 'promote_to_user_message');
      expect(err.message).toContain('before_tool_call');
      expect(err.message).toContain('promote_to_user_message');
      expect(err.message).toContain('Plan 202 §5.2');
    });
  });
});
