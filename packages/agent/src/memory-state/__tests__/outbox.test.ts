import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { Database } from 'better-sqlite3';
import {
  assertSafe,
  computeContentHash,
  drainOutbox,
  enqueueProjectionOutbox,
  outboxBackoffMs,
} from '../outbox';
import { createMemoryStateFixture, type MemoryStateFixture } from './fixture';

/**
 * Projection outbox scenarios (Plan 303 Phase D, design v3 D12).
 *
 * Time is injected via `now` everywhere — backoff elapsing and
 * next_attempt_at gating are simulated without real sleeps. The
 * fixture's `memoryRoot` temp dir is injected into the drain allowlist
 * to stand in for `~/.duya/memory`.
 */

const T0 = 1_700_000_000_000;

interface OutboxDbRow {
  projection_id: number;
  target_path: string;
  operation: string;
  content: string | null;
  attempt_count: number;
  next_attempt_at: number | null;
  last_error: string | null;
  enqueued_at: number;
  completed_at: number | null;
}

function getRow(db: Database, id: number): OutboxDbRow | undefined {
  return db.prepare('SELECT * FROM projection_outbox WHERE projection_id = ?').get(id) as
    | OutboxDbRow
    | undefined;
}

function allRows(db: Database): OutboxDbRow[] {
  return db.prepare('SELECT * FROM projection_outbox ORDER BY projection_id ASC').all() as OutboxDbRow[];
}

describe('projection outbox (D12)', () => {
  let fixture: MemoryStateFixture;
  let db: Database;

  beforeEach(() => {
    fixture = createMemoryStateFixture();
    db = fixture.db;
  });

  afterEach(() => {
    fixture.cleanup();
  });

  it('1. standalone enqueue inserts a visible row with next_attempt_at <= now + 2s', () => {
    const target = path.join(fixture.memoryRoot, 'a.md');
    const result = enqueueProjectionOutbox(db, {
      targetPath: target,
      operation: 'write',
      content: 'hello',
      now: T0,
    });

    const row = getRow(db, result.projectionId);
    expect(row).toBeDefined();
    expect(row!.target_path).toBe(target);
    expect(row!.operation).toBe('write');
    expect(row!.content).toBe('hello');
    expect(row!.attempt_count).toBe(0);
    expect(row!.last_error).toBeNull();
    expect(row!.completed_at).toBeNull();
    expect(row!.enqueued_at).toBe(T0);
    expect(row!.next_attempt_at).toBe(T0 + 1_000);
    expect(row!.next_attempt_at!).toBeLessThanOrEqual(T0 + 2_000);
    expect(result.nextAttemptAt).toBe(new Date(T0 + 1_000).toISOString());
  });

  it('2. enqueue inside a rolled-back transaction leaves no row', () => {
    const target = path.join(fixture.memoryRoot, 'rolled-back.md');
    expect(() =>
      db.transaction(() => {
        enqueueProjectionOutbox(db, { targetPath: target, operation: 'write', content: 'x', now: T0 });
        throw new Error('force rollback');
      })()
    ).toThrow('force rollback');
    expect(allRows(db)).toHaveLength(0);
  });

  it('3. enqueue inside a committed transaction keeps the row', () => {
    const target = path.join(fixture.memoryRoot, 'committed.md');
    let projectionId = -1;
    db.transaction(() => {
      projectionId = enqueueProjectionOutbox(db, {
        targetPath: target,
        operation: 'write',
        content: 'x',
        now: T0,
      }).projectionId;
    })();
    const row = getRow(db, projectionId);
    expect(row).toBeDefined();
    expect(row!.target_path).toBe(target);
  });

  it('4. drain writes atomically: full content, temp file gone, completed_at set', () => {
    const target = path.join(fixture.memoryRoot, 'atomic.md');
    const content = '# full content\nwith several\nlines\n';
    const { projectionId } = enqueueProjectionOutbox(db, {
      targetPath: target,
      operation: 'write',
      content,
      now: T0,
    });

    const processed = drainOutbox(db, { allowedRoots: [fixture.memoryRoot], now: T0 + 2_000 });
    expect(processed).toBe(1);

    expect(fs.readFileSync(target, 'utf8')).toBe(content);
    const tmp = path.join(fixture.memoryRoot, `.atomic.md.${projectionId}.tmp`);
    expect(fs.existsSync(tmp)).toBe(false);

    const row = getRow(db, projectionId)!;
    expect(row.completed_at).toBe(T0 + 2_000);
    expect(row.attempt_count).toBe(1);
    expect(row.last_error).toBeNull();
  });

  it('5. target outside the allowlist is marked unsafe-path and never written', () => {
    // memoryRoot is NOT under the default allowlist (~/.duya/memory) and
    // we deliberately do not pass allowedRoots, so this is rejected.
    const target = path.join(fixture.memoryRoot, 'outside.md');
    const { projectionId } = enqueueProjectionOutbox(db, {
      targetPath: target,
      operation: 'write',
      content: 'x',
      now: T0,
    });

    drainOutbox(db, { now: T0 + 2_000 });

    const row = getRow(db, projectionId)!;
    expect(row.completed_at).toBe(T0 + 2_000);
    expect(row.last_error).toBe('unsafe-path');
    expect(row.attempt_count).toBe(1);
    expect(fs.existsSync(target)).toBe(false);
  });

  it('6. drain creates missing parent directories recursively', () => {
    const target = path.join(fixture.memoryRoot, 'nested', 'deep', 'file.md');
    const { projectionId } = enqueueProjectionOutbox(db, {
      targetPath: target,
      operation: 'write',
      content: 'deep content',
      now: T0,
    });

    drainOutbox(db, { allowedRoots: [fixture.memoryRoot], now: T0 + 2_000 });

    expect(fs.readFileSync(target, 'utf8')).toBe('deep content');
    expect(getRow(db, projectionId)!.completed_at).toBe(T0 + 2_000);
  });

  it('7. repeated failures increment attempt_count and follow the backoff schedule', () => {
    // Make the target's parent path a FILE so mkdirSync always fails
    // (Windows-reliable failure injection).
    const blocker = path.join(fixture.memoryRoot, 'blocker');
    fs.writeFileSync(blocker, 'not a directory', 'utf8');
    const target = path.join(blocker, 'file.md');
    const { projectionId } = enqueueProjectionOutbox(db, {
      targetPath: target,
      operation: 'write',
      content: 'x',
      now: T0,
    });

    const now1 = T0 + 2_000;
    expect(drainOutbox(db, { allowedRoots: [fixture.memoryRoot], now: now1 })).toBe(1);
    let row = getRow(db, projectionId)!;
    expect(row.attempt_count).toBe(1);
    expect(row.completed_at).toBeNull();
    expect(row.next_attempt_at).toBe(now1 + outboxBackoffMs(1));
    expect(row.last_error).toBeTruthy();

    const now2 = row.next_attempt_at! + 1;
    expect(drainOutbox(db, { allowedRoots: [fixture.memoryRoot], now: now2 })).toBe(1);
    row = getRow(db, projectionId)!;
    expect(row.attempt_count).toBe(2);
    expect(row.completed_at).toBeNull();
    expect(row.next_attempt_at).toBe(now2 + outboxBackoffMs(2));

    const now3 = row.next_attempt_at! + 1;
    expect(drainOutbox(db, { allowedRoots: [fixture.memoryRoot], now: now3 })).toBe(1);
    row = getRow(db, projectionId)!;
    expect(row.attempt_count).toBe(3);
    expect(row.next_attempt_at).toBe(now3 + outboxBackoffMs(3));
  });

  it('8. a row exceeding maxAttempts is retired and stops being drained', () => {
    const blocker = path.join(fixture.memoryRoot, 'blocker');
    fs.writeFileSync(blocker, 'not a directory', 'utf8');
    const target = path.join(blocker, 'file.md');
    const { projectionId } = enqueueProjectionOutbox(db, {
      targetPath: target,
      operation: 'write',
      content: 'x',
      now: T0,
    });

    let now = T0 + 2_000;
    for (let i = 0; i < 3; i++) {
      drainOutbox(db, { allowedRoots: [fixture.memoryRoot], maxAttempts: 2, now });
      now = (getRow(db, projectionId)!.next_attempt_at ?? now) + 1;
    }

    const row = getRow(db, projectionId)!;
    expect(row.attempt_count).toBe(3);
    expect(row.completed_at).not.toBeNull();
    expect(row.last_error).toBe('retired-after-3-attempts');

    // Retired rows are never selected again.
    expect(
      drainOutbox(db, { allowedRoots: [fixture.memoryRoot], now: now + 100_000_000 })
    ).toBe(0);
  });

  it('9. a re-entrant drain returns 0 (in-process single-flight)', () => {
    const target = path.join(fixture.memoryRoot, 'single-flight.md');
    enqueueProjectionOutbox(db, { targetPath: target, operation: 'write', content: 'x', now: T0 });

    let reentrantResult = -1;
    const processed = drainOutbox(db, {
      allowedRoots: [fixture.memoryRoot],
      now: T0 + 2_000,
      _hooks: {
        beforeWrite: () => {
          reentrantResult = drainOutbox(db, { allowedRoots: [fixture.memoryRoot], now: T0 + 2_000 });
        },
      },
    });

    expect(processed).toBe(1);
    expect(reentrantResult).toBe(0);
    // The outer drain still completed the write after the hook returned.
    expect(fs.readFileSync(target, 'utf8')).toBe('x');
  });

  it('10. a symlink escaping the allowlist is rejected before any write', () => {
    const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), 'outbox-outside-'));
    try {
      const link = path.join(fixture.memoryRoot, 'escape-link');
      try {
        fs.symlinkSync(outsideDir, link, 'junction');
      } catch {
        // This environment cannot create directory symlinks (missing
        // privilege); the assertion is skipped by construction.
        return;
      }
      const target = path.join(link, 'evil.md');
      const { projectionId } = enqueueProjectionOutbox(db, {
        targetPath: target,
        operation: 'write',
        content: 'x',
        now: T0,
      });

      drainOutbox(db, { allowedRoots: [fixture.memoryRoot], now: T0 + 2_000 });

      const row = getRow(db, projectionId)!;
      expect(row.completed_at).toBe(T0 + 2_000);
      expect(row.last_error).toBe('unsafe-path');
      expect(fs.existsSync(path.join(outsideDir, 'evil.md'))).toBe(false);
    } finally {
      fs.rmSync(outsideDir, { recursive: true, force: true });
    }
  });

  it('drains delete operations by removing the target file', () => {
    const target = path.join(fixture.memoryRoot, 'to-delete.md');
    fs.writeFileSync(target, 'stale', 'utf8');
    const { projectionId } = enqueueProjectionOutbox(db, {
      targetPath: target,
      operation: 'delete',
      content: null,
      now: T0,
    });

    drainOutbox(db, { allowedRoots: [fixture.memoryRoot], now: T0 + 2_000 });

    expect(fs.existsSync(target)).toBe(false);
    expect(getRow(db, projectionId)!.completed_at).toBe(T0 + 2_000);
  });

  it('deleting the last managed file prunes empty projection directories only', () => {
    const projectsDir = path.join(fixture.memoryRoot, 'projects');
    const projectDir = path.join(projectsDir, '11111111-1111-4111-8111-111111111111');
    const target = path.join(projectDir, 'MEMORY.md');
    fs.mkdirSync(projectDir, { recursive: true });
    fs.writeFileSync(target, 'legacy', 'utf8');
    enqueueProjectionOutbox(db, {
      targetPath: target,
      operation: 'delete',
      content: null,
      now: T0,
    });

    drainOutbox(db, { allowedRoots: [fixture.memoryRoot], now: T0 + 2_000 });

    expect(fs.existsSync(target)).toBe(false);
    expect(fs.existsSync(projectDir)).toBe(false);
    expect(fs.existsSync(projectsDir)).toBe(false);
    expect(fs.existsSync(fixture.memoryRoot)).toBe(true);
  });

  it('outboxBackoffMs follows the documented schedule and clamps beyond it', () => {
    expect(outboxBackoffMs(1)).toBe(1_000);
    expect(outboxBackoffMs(2)).toBe(5_000);
    expect(outboxBackoffMs(3)).toBe(30_000);
    expect(outboxBackoffMs(4)).toBe(120_000);
    expect(outboxBackoffMs(5)).toBe(600_000);
    expect(outboxBackoffMs(6)).toBe(3_600_000);
    expect(outboxBackoffMs(7)).toBe(21_600_000);
    expect(outboxBackoffMs(8)).toBe(21_600_000);
    expect(outboxBackoffMs(100)).toBe(21_600_000);
  });

  it('computeContentHash returns the sha256 hex digest', () => {
    expect(computeContentHash('')).toBe(
      'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'
    );
    expect(computeContentHash('abc')).toMatch(/^[0-9a-f]{64}$/);
  });

  it('assertSafe accepts allowlisted paths and rejects foreign ones', () => {
    expect(() =>
      assertSafe(path.join(fixture.memoryRoot, 'ok.md'), [fixture.memoryRoot])
    ).not.toThrow();
    expect(() => assertSafe(path.join(os.tmpdir(), 'foreign', 'x.md'))).toThrow();
  });
});
