import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import type { Database } from 'better-sqlite3';
import { computeContentHash } from '../outbox';
import {
  deriveRolloutSummaryFilename,
  renderRolloutSummaryFile,
  renderUnifiedMemoryFile,
  renderMemorySummaryFile,
  renderPeopleIndexFile,
  renderAreasIndexFile,
  type Stage1OutputRow,
} from '../projectionContent';
import { reconcileProjections } from '../reconcile';
import {
  createMemoryStateFixture,
  insertStage1Output,
  type MemoryStateFixture,
} from './fixture';

/**
 * Reconciliation scenarios (Plan 303 Phase D, design v3 D12).
 *
 * The fixture's `memoryRoot` temp dir is passed as `rootDir` so the
 * reconciler never touches the real `~/.duya/memory`. Reconcile only
 * enqueues outbox rows; assertions inspect `projection_outbox`
 * directly. Time is injected via `now` (no real sleeps).
 */

const T0 = 1_700_000_000_000;

const ID_A = 'abcd1234-0000-4000-8000-000000000001';
const ID_B = 'bbbb2222-0000-4000-8000-000000000002';

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

function outboxRows(db: Database): OutboxDbRow[] {
  return db.prepare('SELECT * FROM projection_outbox ORDER BY projection_id ASC').all() as OutboxDbRow[];
}

function getStage1Row(db: Database, rolloutId: string): Stage1OutputRow {
  return db.prepare('SELECT * FROM stage1_outputs WHERE rollout_id = ?').get(rolloutId) as Stage1OutputRow;
}

/**
 * Write the derived projection file for a row with exactly the rendered
 * content and store its hash in `content_hash_at_write`, making the row
 * fully consistent so reconcile plans nothing for it.
 */
function writeConsistentProjection(db: Database, memoryRoot: string, rolloutId: string): string {
  const row = getStage1Row(db, rolloutId);
  const content = renderRolloutSummaryFile(row);
  const filePath = path.join(memoryRoot, 'rollout_summaries', deriveRolloutSummaryFilename(row));
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, 'utf8');
  db.prepare('UPDATE stage1_outputs SET content_hash_at_write = ? WHERE rollout_id = ?').run(
    computeContentHash(content),
    rolloutId
  );
  return filePath;
}

function writeSummaryFile(memoryRoot: string, name: string, content: string): string {
  const filePath = path.join(memoryRoot, 'rollout_summaries', name);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, 'utf8');
  return filePath;
}

/**
 * Pre-write the Phase 2 managed projections (migration 0005+) rendered
 * from the empty memory_entries table so reconcile's Phase 2 branch
 * plans nothing and the D12 scenarios stay focused on rollout_summaries.
 */
function writeConsistentPhase2Projections(memoryRoot: string): void {
  const files: Array<[string[], string]> = [
    [['MEMORY.md'], renderUnifiedMemoryFile([])],
    [['summary.md'], renderMemorySummaryFile([])],
    [['global', 'people', 'index.md'], renderPeopleIndexFile([])],
    [['global', 'areas', 'index.md'], renderAreasIndexFile([])],
  ];
  for (const [segments, content] of files) {
    const filePath = path.join(memoryRoot, ...segments);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, content, 'utf8');
  }
}

describe('reconcileProjections (D12)', () => {
  let fixture: MemoryStateFixture;
  let db: Database;

  beforeEach(() => {
    fixture = createMemoryStateFixture();
    db = fixture.db;
    writeConsistentPhase2Projections(fixture.memoryRoot);
  });

  afterEach(() => {
    fixture.cleanup();
  });

  it('1. DB row without a file enqueues a write with the rendered content', () => {
    const id = insertStage1Output(db, { rollout_id: ID_A, generated_at: T0 });
    const row = getStage1Row(db, id);
    const expectedPath = path.join(
      fixture.memoryRoot,
      'rollout_summaries',
      deriveRolloutSummaryFilename(row)
    );

    const report = reconcileProjections(db, { rootDir: fixture.memoryRoot, now: T0 });

    expect(report.written).toContain(expectedPath);
    expect(report.removed).toHaveLength(0);
    const write = outboxRows(db).find((r) => r.target_path === expectedPath);
    expect(write).toBeDefined();
    expect(write!.operation).toBe('write');
    expect(write!.content).toBe(renderRolloutSummaryFile(row));
  });

  it('2. DB row + consistent file (content_hash_at_write) enqueues nothing', () => {
    const id = insertStage1Output(db, { rollout_id: ID_A, generated_at: T0 });
    writeConsistentProjection(db, fixture.memoryRoot, id);

    const report = reconcileProjections(db, { rootDir: fixture.memoryRoot, now: T0 });

    expect(report.written).toHaveLength(0);
    expect(report.removed).toHaveLength(0);
    expect(report.mismatched).toHaveLength(0);
    expect(outboxRows(db)).toHaveLength(0);
  });

  it('3. DB row + drifted file enqueues a rewrite and reports the mismatch', () => {
    const id = insertStage1Output(db, { rollout_id: ID_A, generated_at: T0 });
    const filePath = writeConsistentProjection(db, fixture.memoryRoot, id);
    // Simulate post-write drift (user edit / partial write).
    fs.writeFileSync(filePath, 'tampered content', 'utf8');
    const row = getStage1Row(db, id);

    const report = reconcileProjections(db, { rootDir: fixture.memoryRoot, now: T0 });

    expect(report.mismatched).toContain(filePath);
    expect(report.written).toContain(filePath);
    const write = outboxRows(db).find((r) => r.target_path === filePath);
    expect(write).toBeDefined();
    expect(write!.operation).toBe('write');
    expect(write!.content).toBe(renderRolloutSummaryFile(row));
  });

  it('4. a well-named file with no DB row enqueues a delete', () => {
    const orphan = writeSummaryFile(
      fixture.memoryRoot,
      '2026-01-02T03-04-05-deadbeef-some-rollout.md',
      'orphaned'
    );

    const report = reconcileProjections(db, { rootDir: fixture.memoryRoot, now: T0 });

    expect(report.removed).toContain(orphan);
    const del = outboxRows(db).find((r) => r.operation === 'delete');
    expect(del).toBeDefined();
    expect(del!.target_path).toBe(orphan);
    expect(del!.content).toBeNull();
  });

  it('5. dryRun reports the plan without enqueueing any outbox row', () => {
    insertStage1Output(db, { rollout_id: ID_A, generated_at: T0 }); // missing file -> write
    writeSummaryFile(fixture.memoryRoot, '2026-01-02T03-04-05-deadbeef-some-rollout.md', 'orphan');

    const report = reconcileProjections(db, { rootDir: fixture.memoryRoot, dryRun: true, now: T0 });

    expect(report.written).toHaveLength(1);
    expect(report.removed).toHaveLength(1);
    expect(report.durationMs).toBe(0);
    expect(outboxRows(db)).toHaveLength(0);
  });

  it('6. a 4-char shortid uniquely matching a row is mapped and never deleted', () => {
    const id = insertStage1Output(db, { rollout_id: ID_A, generated_at: T0 });
    writeConsistentProjection(db, fixture.memoryRoot, id);
    // Legacy file using only the first 4 hex chars of the same rollout id.
    const short4 = ID_A.replace(/-/g, '').slice(0, 4);
    const legacy = writeSummaryFile(
      fixture.memoryRoot,
      `2026-01-02T03-04-05-${short4}-legacy-name.md`,
      'legacy content'
    );

    const report = reconcileProjections(db, { rootDir: fixture.memoryRoot, now: T0 });

    expect(report.removed).toHaveLength(0);
    expect(report.written).toHaveLength(0);
    expect(outboxRows(db)).toHaveLength(0);
    expect(fs.existsSync(legacy)).toBe(true);
  });

  it('7. a shortid matching zero rows is an orphan and enqueued for delete', () => {
    const id = insertStage1Output(db, { rollout_id: ID_A, generated_at: T0 });
    writeConsistentProjection(db, fixture.memoryRoot, id);
    const orphan = writeSummaryFile(
      fixture.memoryRoot,
      '2026-01-02T03-04-05-ffff9999-unknown-rollout.md',
      'orphaned'
    );

    const report = reconcileProjections(db, { rootDir: fixture.memoryRoot, now: T0 });

    expect(report.removed).toEqual([orphan]);
    expect(report.written).toHaveLength(0);
    const del = outboxRows(db).find((r) => r.operation === 'delete');
    expect(del!.target_path).toBe(orphan);
  });

  it('8. an 8-char shortid maps unambiguously; non-matching files are untouched', () => {
    const id = insertStage1Output(db, { rollout_id: ID_A, generated_at: T0 });
    writeConsistentProjection(db, fixture.memoryRoot, id);
    // Same rollout, different slug/timestamp — still maps to the row.
    const short8 = ID_A.replace(/-/g, '').slice(0, 8);
    writeSummaryFile(fixture.memoryRoot, `2020-01-01T00-00-00-${short8}-different-slug.md`, 'x');
    // User-owned files outside the filename grammar.
    const summariesDir = path.join(fixture.memoryRoot, 'rollout_summaries');
    fs.writeFileSync(path.join(summariesDir, 'notes.txt'), 'mine', 'utf8');
    fs.writeFileSync(path.join(summariesDir, '.gitkeep'), '', 'utf8');
    fs.writeFileSync(path.join(summariesDir, 'my-notes.md'), 'mine', 'utf8');

    const report = reconcileProjections(db, { rootDir: fixture.memoryRoot, now: T0 });

    expect(report.removed).toHaveLength(0);
    expect(report.written).toHaveLength(0);
    expect(outboxRows(db)).toHaveLength(0);
    expect(fs.existsSync(path.join(summariesDir, 'notes.txt'))).toBe(true);
    expect(fs.existsSync(path.join(summariesDir, '.gitkeep'))).toBe(true);
    expect(fs.existsSync(path.join(summariesDir, 'my-notes.md'))).toBe(true);
  });

  it('raw_memories.md is not recreated from raw_memory rows', () => {
    const idA = insertStage1Output(db, { rollout_id: ID_A, generated_at: T0, raw_memory: 'memory A' });
    const idB = insertStage1Output(db, { rollout_id: ID_B, generated_at: T0 + 1, raw_memory: 'memory B' });
    writeConsistentProjection(db, fixture.memoryRoot, idA);
    writeConsistentProjection(db, fixture.memoryRoot, idB);
    const report = reconcileProjections(db, { rootDir: fixture.memoryRoot, now: T0 });

    expect(report.written).toHaveLength(0);
    expect(outboxRows(db)).toHaveLength(0);
  });

  it('raw_memories.md present without raw_memory rows enqueues a delete', () => {
    const id = insertStage1Output(db, { rollout_id: ID_A, generated_at: T0 });
    writeConsistentProjection(db, fixture.memoryRoot, id);
    const rawPath = path.join(fixture.memoryRoot, 'raw_memories.md');
    fs.writeFileSync(rawPath, '# Raw Memories\n\nstale\n', 'utf8');

    const report = reconcileProjections(db, { rootDir: fixture.memoryRoot, now: T0 });

    expect(report.removed).toContain(rawPath);
    const del = outboxRows(db).find((r) => r.target_path === rawPath);
    expect(del).toBeDefined();
    expect(del!.operation).toBe('delete');
  });

  it('succeeded_no_output row enqueues NO write (no empty files)', () => {
    const id = insertStage1Output(db, {
      rollout_id: ID_A,
      generated_at: T0,
      rollout_slug: 'no-durable-knowledge',
    });
    // Fixture uses `??` so passing null falls back to defaults; UPDATE directly.
    db.prepare(
      `UPDATE stage1_outputs SET job_status = 'succeeded_no_output', content_outcome = NULL, rollout_summary = NULL WHERE rollout_id = ?`
    ).run(id);

    const report = reconcileProjections(db, { rootDir: fixture.memoryRoot, now: T0 });

    expect(report.written).toHaveLength(0);
    expect(report.removed).toHaveLength(0);
    expect(outboxRows(db)).toHaveLength(0);
  });

  it('existing empty file mapping to a succeeded_no_output row is deleted', () => {
    const id = insertStage1Output(db, {
      rollout_id: ID_A,
      generated_at: T0,
      rollout_slug: 'no-durable-knowledge',
    });
    db.prepare(
      `UPDATE stage1_outputs SET job_status = 'succeeded_no_output', content_outcome = NULL, rollout_summary = NULL WHERE rollout_id = ?`
    ).run(id);
    // Simulate a previously-written empty file (the bug we are fixing).
    const row = getStage1Row(db, id);
    const emptyPath = writeSummaryFile(
      fixture.memoryRoot,
      deriveRolloutSummaryFilename(row),
      renderRolloutSummaryFile(row) // frontmatter + empty body
    );

    const report = reconcileProjections(db, { rootDir: fixture.memoryRoot, now: T0 });

    expect(report.written).toHaveLength(0);
    expect(report.removed).toContain(emptyPath);
    const del = outboxRows(db).find((r) => r.target_path === emptyPath);
    expect(del).toBeDefined();
    expect(del!.operation).toBe('delete');
  });

  it('filename derivation follows the D11 shape and sanitizes slugs', () => {
    const name = deriveRolloutSummaryFilename({
      rollout_id: ID_A,
      rollout_slug: 'My Slug: With Spaces!',
      generated_at: T0,
    });
    expect(name).toMatch(
      /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-abcd1234-[a-z0-9-]{3,80}\.md$/
    );
    expect(name).toContain('-my-slug--with-spaces-.md');
    expect(
      deriveRolloutSummaryFilename({ rollout_id: ID_A, rollout_slug: 'ab', generated_at: T0 })
    ).toContain('-rollout.md');
  });
});
