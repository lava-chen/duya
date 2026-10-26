/**
 * Forget repair (framework plan S5).
 *
 * The forget ledger is the write-ahead record of a forget: it is written
 * before the canonical file is retired and names the file. These cases
 * reproduce the crash window (ledger written, file still `status: active`)
 * and pin that the repair pass completes it.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import type { Database as DatabaseType } from 'better-sqlite3';
import { runMigrations } from '../migrations';
import { listTierEntries } from '../tierIndex';
import { writeTierFact, type TierWriteInput } from '../tierWriter';
import { recoverForgottenMemories } from '../forgetRecovery';
import { recordForgetSync } from '@duya/memory/forget_ledger';
import { parseCanonicalFile } from '@duya/memory/canonical_file';

const mocks = vi.hoisted(() => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock('../../logging/logger', () => ({
  getLogger: () => mocks.logger,
  LogComponent: {
    DB: 'DB',
    DBMigration: 'DBMigration',
    Main: 'Main',
  },
}));

let db: DatabaseType;
let duyaRoot: string;
let tmpDir: string | undefined;

function baseInput(overrides: Partial<TierWriteInput> = {}): TierWriteInput {
  return {
    actorAgentId: 'alpha',
    tier: 'agent',
    action: 'write',
    fact: 'Prefers concise answers',
    dedupeKey: 'prefers concise answers',
    kind: 'note',
    ...overrides,
  };
}

beforeEach(() => {
  db = new Database(':memory:');
  db.pragma('journal_mode = WAL');
  runMigrations(db);
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'duya-forget-recovery-'));
  duyaRoot = tmpDir;
});

afterEach(() => {
  db.close();
  if (tmpDir) {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    tmpDir = undefined;
  }
});

describe('recoverForgottenMemories', () => {
  it('completes a forget that a crash left half-applied', () => {
    const written = writeTierFact(db, duyaRoot, baseInput());
    expect(written.success).toBe(true);
    const relPath = written.success ? written.filePath! : '';

    // The crash window: the ledger landed, the process died before the file
    // was retired and the index row dropped.
    recordForgetSync(path.join(duyaRoot, 'memory'), [
      { key: 'prefers concise answers', path: relPath },
    ]);
    expect(parseCanonicalFile(path.join(duyaRoot, relPath))?.status).toBe('active');
    expect(listTierEntries(db, { tier: 'agent', agentProfileId: 'alpha' })).toHaveLength(1);

    const report = recoverForgottenMemories(db, duyaRoot);

    expect(report.scanned).toBe(1);
    expect(report.retired).toBe(1);
    expect(report.indexRowsRemoved).toBe(1);
    expect(parseCanonicalFile(path.join(duyaRoot, relPath))?.status).toBe('retired');
    expect(listTierEntries(db, { tier: 'agent', agentProfileId: 'alpha' })).toHaveLength(0);
  });

  it('is idempotent — a completed forget is a no-op', () => {
    const written = writeTierFact(db, duyaRoot, baseInput());
    const relPath = written.success ? written.filePath! : '';
    recordForgetSync(path.join(duyaRoot, 'memory'), [
      { key: 'prefers concise answers', path: relPath },
    ]);

    const first = recoverForgottenMemories(db, duyaRoot);
    const second = recoverForgottenMemories(db, duyaRoot);

    expect(first.retired).toBe(1);
    expect(second.retired).toBe(0);
    expect(second.indexRowsRemoved).toBe(0);
    expect(second.scanned).toBe(1);
    expect(parseCanonicalFile(path.join(duyaRoot, relPath))?.status).toBe('retired');
  });

  it('does nothing when no forget was recorded', () => {
    writeTierFact(db, duyaRoot, baseInput());
    const report = recoverForgottenMemories(db, duyaRoot);

    expect(report.scanned).toBe(0);
    expect(report.retired).toBe(0);
    expect(listTierEntries(db, { tier: 'agent', agentProfileId: 'alpha' })).toHaveLength(1);
  });
});
