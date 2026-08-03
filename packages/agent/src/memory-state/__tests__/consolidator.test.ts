/**
 * Consolidator test suite (Plan 306 Phase B).
 *
 * Covers the 10-step consolidator flow: lock acquisition, CAS-skip,
 * D8 guard, winner selection, UPSERT/merge, evidence, ad-hoc
 * digestion, projection rendering, transaction rollback, and
 * idempotency.
 *
 * NOTE: better-sqlite3 may be ABI-broken in some environments; these
 * tests are structured so `npx tsc --noEmit` passes even when
 * vitest cannot run. The fixture applies migrations 0001-0003 and
 * 0005-0007.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import {
  createMemoryStateFixture,
  insertStage1Output,
  type MemoryStateFixture,
} from './fixture.js';
import { runConsolidator } from '../consolidator.js';
import { drainOutbox } from '../outbox.js';
import type { Database as BetterSqlite3Database } from 'better-sqlite3';

// ---------------------------------------------------------------------------
// Fixture extension: migrations 0005-0007 are applied by the base fixture;
// this adds the ad-hoc directories on top.
// ---------------------------------------------------------------------------

interface Phase2Fixture extends MemoryStateFixture {
  adHocDir: string;
  digestedDir: string;
}

function createPhase2Fixture(): Phase2Fixture {
  const base = createMemoryStateFixture();
  const adHocDir = path.join(base.memoryRoot, 'extensions', 'ad_hoc');
  const digestedDir = path.join(adHocDir, '.digested');
  fs.mkdirSync(adHocDir, { recursive: true });
  return { ...base, adHocDir, digestedDir };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface RawMemoryItemInput {
  claim: string;
  claim_type: string;
  scope?: string;
  scope_id?: string | null;
  evidence: Array<{
    source_type: string;
    source_id: string;
    verification?: string;
  }>;
  canonical_key: string;
  confidence?: string;
  status?: string;
  valid_from?: string | null;
  valid_until?: string | null;
  relation_to_existing?: string | null;
  supersedes?: string[];
  why_future_agent_needs_this?: string;
  retrieval_cues?: string[];
}

function makeRawMemory(items: RawMemoryItemInput[]): string {
  return JSON.stringify({ items: items.map((item) => ({ scope: 'global', ...item })) });
}

function makeStage1Row(
  db: BetterSqlite3Database,
  overrides: {
    rolloutId?: string;
    projectId?: string;
    rawMemory?: string | null;
    contentOutcome?: string;
    jobStatus?: string;
    generatedAt?: number;
    sourceContentHash?: string;
  } = {}
): string {
  const rolloutId = overrides.rolloutId ?? crypto.randomUUID();
  insertStage1Output(db, {
    rollout_id: rolloutId,
    project_id: overrides.projectId ?? 'global',
    raw_memory: overrides.rawMemory ?? null,
    content_outcome:
      (overrides.contentOutcome as 'success' | 'partial' | 'fail' | 'uncertain' | null) ?? 'success',
    job_status: (overrides.jobStatus as 'succeeded' | 'succeeded_no_output') ?? 'succeeded',
    generated_at: overrides.generatedAt ?? Date.now(),
    source_content_hash: overrides.sourceContentHash ?? 'hash-1',
  });
  return rolloutId;
}

function getMemoryEntries(db: BetterSqlite3Database): Array<Record<string, unknown>> {
  return db.prepare('SELECT * FROM memory_entries ORDER BY canonical_key').all();
}

function getEvidence(db: BetterSqlite3Database): Array<Record<string, unknown>> {
  return db.prepare('SELECT * FROM memory_evidence ORDER BY memory_id, stage1_item_id').all();
}

function getPhase2Runs(db: BetterSqlite3Database): Array<Record<string, unknown>> {
  return db.prepare('SELECT * FROM phase2_runs ORDER BY id').all();
}

function writeAdHocFile(dir: string, filename: string, content: string): string {
  const filePath = path.join(dir, filename);
  fs.writeFileSync(filePath, content, 'utf8');
  return filePath;
}

function drainAndRead(db: BetterSqlite3Database, rootDir: string, relPath: string): string | null {
  drainOutbox(db, { batchSize: 64, allowedRoots: [rootDir] });
  const fullPath = path.join(rootDir, relPath);
  if (!fs.existsSync(fullPath)) return null;
  return fs.readFileSync(fullPath, 'utf8');
}

const FIXED_NOW = 1_700_000_000_000;

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('runConsolidator', () => {
  let fx: Phase2Fixture;

  beforeEach(() => {
    fx = createPhase2Fixture();
  });

  afterEach(() => {
    fx.cleanup();
  });

  // 1. Empty stage1_outputs → no-op run, phase2_runs row inserted.
  it('1. empty stage1_outputs: inserts phase2_runs row with status=succeeded', () => {
    const result = runConsolidator({ db: fx.db, now: FIXED_NOW, rootDir: fx.memoryRoot });
    expect(result.skipped).toBe(false);
    expect(result.added).toBe(0);
    expect(result.merged).toBe(0);

    const runs = getPhase2Runs(fx.db);
    expect(runs.length).toBe(1);
    expect(runs[0].status).toBe('succeeded');
    expect(runs[0].lock_holder).toBeNull();
  });

  // 2. Single stage1_output with 1 item → 1 memory_entries + 1 evidence.
  it('2. single item: creates one memory_entries and one evidence row', () => {
    makeStage1Row(fx.db, {
      rawMemory: makeRawMemory([
        {
          claim: 'User prefers dark mode',
          claim_type: 'preference',
          canonical_key: 'ui-theme',
          evidence: [{ source_type: 'user_message', source_id: 'msg-1', verification: 'verified_user' }],
        },
      ]),
    });

    const result = runConsolidator({ db: fx.db, now: FIXED_NOW, rootDir: fx.memoryRoot });
    expect(result.added).toBe(1);

    const entries = getMemoryEntries(fx.db);
    expect(entries.length).toBe(1);
    expect(entries[0].canonical_key).toBe('preference:ui-theme');
    expect(entries[0].status).toBe('active');
    expect(entries[0].version).toBe(1);

    const evidence = getEvidence(fx.db);
    expect(evidence.length).toBe(1);
    expect(evidence[0].relation).toBe('source');
  });

  // 3. Two stage1_outputs same canonical_key in one run → grouped, winner
  //    picked, only one entry created. Merge happens on a SUBSEQUENT run
  //    when the existing entry's content differs from the new winner.
  it('3. same canonical_key: groups items, picks winner, merges on second run', () => {
    // First run: single rollout creates entry with version=1.
    makeStage1Row(fx.db, {
      rolloutId: 'rollout-a',
      rawMemory: makeRawMemory([
        {
          claim: 'Prefers TypeScript',
          claim_type: 'preference',
          canonical_key: 'lang-pref',
          evidence: [{ source_type: 'user_message', source_id: 'm1', verification: 'verified_user' }],
        },
      ]),
      generatedAt: FIXED_NOW - 1000,
      sourceContentHash: 'hash-a',
    });

    const r1 = runConsolidator({ db: fx.db, now: FIXED_NOW, rootDir: fx.memoryRoot });
    expect(r1.added).toBe(1);
    expect(r1.merged).toBe(0);

    const entries1 = getMemoryEntries(fx.db);
    expect(entries1.length).toBe(1);
    expect(entries1[0].version).toBe(1);
    expect(entries1[0].content).toBe('Prefers TypeScript');

    // Second run: add a new rollout with different content + different
    // source_content_hash (so the input_set_hash changes and CAS-skip
    // does not fire). The new item wins (generatedAt is newer), and its
    // content differs from the existing entry → merge bumps version.
    makeStage1Row(fx.db, {
      rolloutId: 'rollout-b',
      rawMemory: makeRawMemory([
        {
          claim: 'Prefers TypeScript strongly',
          claim_type: 'preference',
          canonical_key: 'lang-pref',
          evidence: [{ source_type: 'user_message', source_id: 'm2', verification: 'verified_user' }],
        },
      ]),
      generatedAt: FIXED_NOW,
      sourceContentHash: 'hash-b',
    });

    const r2 = runConsolidator({ db: fx.db, now: FIXED_NOW + 5000, rootDir: fx.memoryRoot });
    expect(r2.added).toBe(0);
    expect(r2.merged).toBe(1);

    const entries2 = getMemoryEntries(fx.db);
    expect(entries2.length).toBe(1);
    expect(entries2[0].version).toBe(2);
    expect(entries2[0].content).toBe('Prefers TypeScript strongly');

    // Two evidence rows (one per rollout).
    const evidence = getEvidence(fx.db);
    expect(evidence.length).toBe(2);
  });

  // 4. Two stage1_outputs different canonical_key → 2 separate entries.
  it('4. different canonical_key: creates two separate entries', () => {
    makeStage1Row(fx.db, {
      rawMemory: makeRawMemory([
        {
          claim: 'Prefers dark mode',
          claim_type: 'preference',
          canonical_key: 'theme',
          evidence: [{ source_type: 'user_message', source_id: 'm1', verification: 'verified_user' }],
        },
      ]),
    });
    makeStage1Row(fx.db, {
      rawMemory: makeRawMemory([
        {
          claim: 'Uses pnpm',
          claim_type: 'fact',
          canonical_key: 'pkg-manager',
          evidence: [{ source_type: 'user_message', source_id: 'm2', verification: 'observed' }],
        },
      ]),
    });

    const result = runConsolidator({ db: fx.db, now: FIXED_NOW, rootDir: fx.memoryRoot });
    expect(result.added).toBe(2);

    const entries = getMemoryEntries(fx.db);
    expect(entries.length).toBe(2);
  });

  // 5. D8 guard: external-only evidence + preference → rejected.
  it('5. D8: external-only preference is rejected', () => {
    makeStage1Row(fx.db, {
      rawMemory: makeRawMemory([
        {
          claim: 'Likes some website',
          claim_type: 'preference',
          canonical_key: 'ext-pref',
          evidence: [{ source_type: 'browser_page', source_id: 'url-1', verification: 'observed' }],
        },
      ]),
    });

    const result = runConsolidator({ db: fx.db, now: FIXED_NOW, rootDir: fx.memoryRoot });
    expect(result.added).toBe(0);

    const entries = getMemoryEntries(fx.db);
    expect(entries.length).toBe(0);
  });

  // 6. D8 guard: external-only evidence + fact → accepted.
  it('6. D8: external-only fact is accepted', () => {
    makeStage1Row(fx.db, {
      rawMemory: makeRawMemory([
        {
          claim: 'API returns JSON',
          claim_type: 'fact',
          canonical_key: 'api-fact',
          evidence: [{ source_type: 'browser_page', source_id: 'url-1', verification: 'observed' }],
        },
      ]),
    });

    const result = runConsolidator({ db: fx.db, now: FIXED_NOW, rootDir: fx.memoryRoot });
    expect(result.added).toBe(1);

    const entries = getMemoryEntries(fx.db);
    expect(entries.length).toBe(1);
    expect(entries[0].kind).toBe('fact');
  });

  // 7. Winner selection: verified_user beats inferred.
  it('7. winner: verified_user beats inferred', () => {
    makeStage1Row(fx.db, {
      rolloutId: 'r-low',
      rawMemory: makeRawMemory([
        {
          claim: 'Low confidence claim',
          claim_type: 'fact',
          canonical_key: 'winner-test',
          evidence: [{ source_type: 'user_message', source_id: 'm1', verification: 'inferred' }],
        },
      ]),
      generatedAt: FIXED_NOW,
    });
    makeStage1Row(fx.db, {
      rolloutId: 'r-high',
      rawMemory: makeRawMemory([
        {
          claim: 'High confidence claim',
          claim_type: 'fact',
          canonical_key: 'winner-test',
          evidence: [{ source_type: 'user_message', source_id: 'm2', verification: 'verified_user' }],
        },
      ]),
      generatedAt: FIXED_NOW - 1000,
    });

    runConsolidator({ db: fx.db, now: FIXED_NOW, rootDir: fx.memoryRoot });

    const entries = getMemoryEntries(fx.db);
    expect(entries.length).toBe(1);
    expect(entries[0].content).toBe('High confidence claim');

    // The winner's evidence is 'source', the loser's is 'supporting'.
    const evidence = getEvidence(fx.db);
    const sourceEv = evidence.find((e) => e.relation === 'source');
    const supportingEv = evidence.find((e) => e.relation === 'supporting');
    expect(sourceEv).toBeDefined();
    expect(supportingEv).toBeDefined();
    expect(sourceEv?.stage1_item_id).toContain('r-high');
    expect(supportingEv?.stage1_item_id).toContain('r-low');
  });

  // 8. Winner selection: tiebreak by generated_at DESC.
  it('8. winner: tiebreak by generated_at DESC', () => {
    makeStage1Row(fx.db, {
      rolloutId: 'r-old',
      rawMemory: makeRawMemory([
        {
          claim: 'Old claim',
          claim_type: 'fact',
          canonical_key: 'tiebreak-test',
          evidence: [{ source_type: 'user_message', source_id: 'm1', verification: 'verified_user' }],
        },
      ]),
      generatedAt: FIXED_NOW - 5000,
    });
    makeStage1Row(fx.db, {
      rolloutId: 'r-new',
      rawMemory: makeRawMemory([
        {
          claim: 'New claim',
          claim_type: 'fact',
          canonical_key: 'tiebreak-test',
          evidence: [{ source_type: 'user_message', source_id: 'm2', verification: 'verified_user' }],
        },
      ]),
      generatedAt: FIXED_NOW,
    });

    runConsolidator({ db: fx.db, now: FIXED_NOW, rootDir: fx.memoryRoot });

    const entries = getMemoryEntries(fx.db);
    expect(entries[0].content).toBe('New claim');
  });

  // 9. CAS skip: same input_set_hash → skipped=true.
  it('9. CAS skip: same input_set_hash returns skipped=true', () => {
    makeStage1Row(fx.db, {
      rolloutId: 'r-1',
      rawMemory: makeRawMemory([
        {
          claim: 'Test claim',
          claim_type: 'fact',
          canonical_key: 'cas-test',
          evidence: [{ source_type: 'user_message', source_id: 'm1', verification: 'verified_user' }],
        },
      ]),
      sourceContentHash: 'hash-cas',
    });

    // First run.
    const r1 = runConsolidator({ db: fx.db, now: FIXED_NOW, rootDir: fx.memoryRoot });
    expect(r1.skipped).toBe(false);

    // Second run with same input set.
    const r2 = runConsolidator({ db: fx.db, now: FIXED_NOW + 1000, rootDir: fx.memoryRoot });
    expect(r2.skipped).toBe(true);
  });

  // 10. CAS skip: different input_set_hash → runs.
  it('10. CAS skip: different input_set_hash runs again', () => {
    makeStage1Row(fx.db, {
      rolloutId: 'r-1',
      rawMemory: makeRawMemory([
        {
          claim: 'First claim',
          claim_type: 'fact',
          canonical_key: 'cas-test-2',
          evidence: [{ source_type: 'user_message', source_id: 'm1', verification: 'verified_user' }],
        },
      ]),
      sourceContentHash: 'hash-A',
    });

    runConsolidator({ db: fx.db, now: FIXED_NOW, rootDir: fx.memoryRoot });

    // Add a new rollout with a different source_content_hash.
    makeStage1Row(fx.db, {
      rolloutId: 'r-2',
      rawMemory: makeRawMemory([
        {
          claim: 'Second claim',
          claim_type: 'fact',
          canonical_key: 'cas-test-2b',
          evidence: [{ source_type: 'user_message', source_id: 'm2', verification: 'verified_user' }],
        },
      ]),
      sourceContentHash: 'hash-B',
    });

    const r2 = runConsolidator({ db: fx.db, now: FIXED_NOW + 1000, rootDir: fx.memoryRoot });
    expect(r2.skipped).toBe(false);
    expect(r2.added).toBe(1);
  });

  // 11. Global lock: concurrent run blocked.
  it('11. lock: fresh running row blocks second run', () => {
    // Manually insert a running phase2_runs row.
    fx.db
      .prepare(
        'INSERT INTO phase2_runs (started_at, input_set_hash, lock_holder, status) VALUES (?, ?, ?, ?)'
      )
      .run(FIXED_NOW - 1000, '', 'other-token', 'running');

    const result = runConsolidator({
      db: fx.db,
      now: FIXED_NOW,
      rootDir: fx.memoryRoot,
      lockTimeoutMs: 5 * 60 * 1000,
    });
    expect(result.skipped).toBe(true);
  });

  // 12. Global lock: stale lock stolen.
  it('12. lock: stale running row is stolen', () => {
    // Insert a stale running row (started_at well before timeout).
    fx.db
      .prepare(
        'INSERT INTO phase2_runs (started_at, input_set_hash, lock_holder, status) VALUES (?, ?, ?, ?)'
      )
      .run(FIXED_NOW - 10 * 60 * 1000, '', 'old-token', 'running');

    const result = runConsolidator({
      db: fx.db,
      now: FIXED_NOW,
      rootDir: fx.memoryRoot,
      lockTimeoutMs: 5 * 60 * 1000,
    });
    expect(result.skipped).toBe(false);
    expect(result.runId).toBeDefined();

    // The stale row should now be succeeded (stolen + completed).
    const runs = getPhase2Runs(fx.db);
    expect(runs.length).toBe(1);
    expect(runs[0].status).toBe('succeeded');
    expect(runs[0].lock_holder).toBeNull();
  });

  // 13. Ad-hoc: single .md file digested.
  it('13. ad-hoc: digests a single .md file into memory_entries', () => {
    writeAdHocFile(fx.adHocDir, 'note.md', 'User likes vim');

    const result = runConsolidator({ db: fx.db, now: FIXED_NOW, rootDir: fx.memoryRoot });
    expect(result.adHocDigested).toBe(1);

    const entries = getMemoryEntries(fx.db);
    expect(entries.length).toBe(1);
    expect(entries[0].canonical_key).toBe('ad-hoc:note.md');
    expect(entries[0].kind).toBe('fact');
    expect(entries[0].scope).toBe('global');
  });

  // 14. Ad-hoc: legacy project-scoped filename prefix is treated as global.
  it('14. ad-hoc: project__<uuid>__ prefix is treated as global', () => {
    const projectId = '550e8400-e29b-41d4-a716-446655440000';
    writeAdHocFile(fx.adHocDir, `project__${projectId}__my-note.md`, 'Project fact');

    const result = runConsolidator({ db: fx.db, now: FIXED_NOW, rootDir: fx.memoryRoot });
    expect(result.adHocDigested).toBe(1);

    const entries = getMemoryEntries(fx.db);
    expect(entries.length).toBe(1);
    expect(entries[0].scope).toBe('global');
    expect(entries[0].project_id).toBeNull();
    expect(entries[0].canonical_key).toBe('ad-hoc:project__550e8400-e29b-41d4-a716-446655440000__my-note.md');
  });

  // 15. Ad-hoc: .digested/ subdirectory ignored.
  it('15. ad-hoc: .digested/ subdirectory is ignored', () => {
    fs.mkdirSync(fx.digestedDir, { recursive: true });
    writeAdHocFile(fx.digestedDir, 'already-done.md', 'Already digested');

    const result = runConsolidator({ db: fx.db, now: FIXED_NOW, rootDir: fx.memoryRoot });
    expect(result.adHocDigested).toBe(0);
    expect(result.added).toBe(0);
  });

  // 16. Ad-hoc: file moved to .digested/ after run.
  it('16. ad-hoc: file is moved to .digested/ after run', () => {
    const filePath = writeAdHocFile(fx.adHocDir, 'move-test.md', 'Move me');
    expect(fs.existsSync(filePath)).toBe(true);

    runConsolidator({ db: fx.db, now: FIXED_NOW, rootDir: fx.memoryRoot });

    // Original file should be gone.
    expect(fs.existsSync(filePath)).toBe(false);
    // Digested copy should exist.
    const digestedPath = path.join(fx.digestedDir, 'move-test.md');
    expect(fs.existsSync(digestedPath)).toBe(true);
  });

  // 17. Ad-hoc: entry never superseded even if stage1 item has same canonical_key.
  it('17. ad-hoc: always wins against stage1 item with same canonical_key', () => {
    writeAdHocFile(fx.adHocDir, 'shared-key.md', 'Ad-hoc content wins');

    makeStage1Row(fx.db, {
      rawMemory: makeRawMemory([
        {
          claim: 'Stage1 content loses',
          claim_type: 'fact',
          canonical_key: 'ad-hoc:shared-key.md',
          evidence: [{ source_type: 'user_message', source_id: 'm1', verification: 'verified_user' }],
        },
      ]),
    });

    runConsolidator({ db: fx.db, now: FIXED_NOW, rootDir: fx.memoryRoot });

    const entries = getMemoryEntries(fx.db);
    expect(entries.length).toBe(1);
    expect(entries[0].content).toBe('Ad-hoc content wins');
    expect(entries[0].version).toBe(1);

    // Evidence: ad-hoc is 'source', stage1 is 'supporting'.
    const evidence = getEvidence(fx.db);
    const sourceEv = evidence.find((e) => e.relation === 'source');
    expect(sourceEv?.stage1_item_id).toContain('ad-hoc#');
  });

  // 18. Unified projections written via outbox drain.
  it('18. projections: unified memory and bounded summary are written via outbox drain', () => {
    makeStage1Row(fx.db, {
      rawMemory: makeRawMemory([
        {
          claim: 'Global pref',
          claim_type: 'preference',
          canonical_key: 'preference:global-response-style',
          evidence: [{ source_type: 'user_message', source_id: 'm1', verification: 'verified_user' }],
        },
      ]),
    });

    runConsolidator({ db: fx.db, now: FIXED_NOW, rootDir: fx.memoryRoot });

    const globalMemory = drainAndRead(fx.db, fx.memoryRoot, 'MEMORY.md');
    expect(globalMemory).toContain('Durable Memory');
    expect(globalMemory).toContain('preference:global-response-style');

    const globalSummary = drainAndRead(fx.db, fx.memoryRoot, 'summary.md');
    expect(globalSummary).toContain('Memory Summary');
    expect(globalSummary).toContain('## Essentials');
    expect(fs.existsSync(path.join(fx.memoryRoot, 'projects'))).toBe(false);

    const diff = drainAndRead(fx.db, fx.memoryRoot, 'phase2_workspace_diff.md');
    expect(diff).toContain('Phase 2 Workspace Diff');
    expect(diff).toContain('Added');
  });

  // 19. Transaction rollback: simulate crash mid-run.
  it('19. rollback: failed transaction leaves no partial writes', () => {
    makeStage1Row(fx.db, {
      rawMemory: makeRawMemory([
        {
          claim: 'Will fail',
          claim_type: 'fact',
          canonical_key: 'fail-test',
          evidence: [{ source_type: 'user_message', source_id: 'm1', verification: 'verified_user' }],
        },
      ]),
    });

    // Drop the memory_entries table to force the transaction to fail
    // mid-run (the UPSERT will throw).
    fx.db.exec('DROP TABLE memory_entries');

    expect(() =>
      runConsolidator({ db: fx.db, now: FIXED_NOW, rootDir: fx.memoryRoot })
    ).toThrow();

    // The lock should be released as 'failed'.
    const runs = getPhase2Runs(fx.db);
    expect(runs.length).toBe(1);
    expect(runs[0].status).toBe('failed');
    expect(runs[0].lock_holder).toBeNull();
  });

  // 20. Idempotency: run twice → second run is CAS-skip.
  it('20. idempotency: second run with same input is CAS-skip', () => {
    makeStage1Row(fx.db, {
      rawMemory: makeRawMemory([
        {
          claim: 'Stable claim',
          claim_type: 'fact',
          canonical_key: 'idem-test',
          evidence: [{ source_type: 'user_message', source_id: 'm1', verification: 'verified_user' }],
        },
      ]),
      sourceContentHash: 'stable-hash',
    });

    const r1 = runConsolidator({ db: fx.db, now: FIXED_NOW, rootDir: fx.memoryRoot });
    expect(r1.skipped).toBe(false);
    expect(r1.added).toBe(1);

    const r2 = runConsolidator({ db: fx.db, now: FIXED_NOW + 5000, rootDir: fx.memoryRoot });
    expect(r2.skipped).toBe(true);

    // Only one memory_entries row (no duplicate).
    const entries = getMemoryEntries(fx.db);
    expect(entries.length).toBe(1);
    expect(entries[0].version).toBe(1);
  });

  it('21. canonical alias retirement merges entries with the same normalized key', () => {
    makeStage1Row(fx.db, {
      rawMemory: makeRawMemory([
        {
          claim: 'Use the dark theme in this project.',
          claim_type: 'preference',
          canonical_key: 'ui-theme',
          evidence: [{ source_type: 'user_message', source_id: 'm-project', verification: 'verified_user' }],
        },
      ]),
    });
    makeStage1Row(fx.db, {
      rawMemory: makeRawMemory([
        {
          claim: 'Use the dark theme globally.',
          claim_type: 'preference',
          canonical_key: 'preference:ui-theme',
          evidence: [{ source_type: 'user_message', source_id: 'm-global', verification: 'verified_user' }],
        },
      ]),
    });

    runConsolidator({ db: fx.db, now: FIXED_NOW, rootDir: fx.memoryRoot });

    const entries = getMemoryEntries(fx.db).filter((item) => item.status === 'active');
    expect(entries).toHaveLength(1);
    expect(entries[0].scope).toBe('global');
    expect(entries[0].canonical_key).toBe('preference:ui-theme');
  });

  it('22. legacy global rows are merged when a new global item shares the same key', () => {
    fx.db.prepare(
      `INSERT INTO memory_entries
         (memory_id, scope, project_id, kind, canonical_key, content, version, status, created_at, updated_at)
       VALUES (?, 'global', NULL, 'fact', 'fact:legacy-detail', ?, 1, 'active', ?, ?)`
    ).run('legacy-global', 'A legacy implementation detail.', FIXED_NOW - 1, FIXED_NOW - 1);
    makeStage1Row(fx.db, {
      rawMemory: JSON.stringify({
        items: [
          {
            claim: 'A legacy implementation detail.',
            claim_type: 'fact',
            canonical_key: 'fact:legacy-detail',
            evidence: [{ source_type: 'user_message', source_id: 'm-legacy', verification: 'verified_user' }],
          },
        ],
      }),
    });

    runConsolidator({ db: fx.db, now: FIXED_NOW, rootDir: fx.memoryRoot });

    const legacy = getMemoryEntries(fx.db).find((item) => item.memory_id === 'legacy-global');
    expect(legacy?.status).toBe('active');
    expect(legacy?.version).toBe(1);
  });
});
