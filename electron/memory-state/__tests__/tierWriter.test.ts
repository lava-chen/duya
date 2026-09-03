/**
 * Plan 481 P2.1 — memory tier writer tests.
 *
 * Covers the canonical-file write path (frontmatter parseable by the shared
 * parseCanonicalFile), shard layout (agents/ + projects/ trees), index
 * maintenance through upsertTierEntry / removeTierEntryByPath, newest-wins
 * rewrites, and the soft-forget (retire + row removal) flow.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import type { Database as DatabaseType } from 'better-sqlite3';
import { runMigrations } from '../migrations';
import { listTierEntries } from '../tierIndex';
import { forgetTierFact, writeTierFact, type TierWriteInput } from '../tierWriter';
import { parseCanonicalFile } from '../../../packages/agent/src/memory-state/canonical_file';

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
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'duya-tier-writer-'));
  duyaRoot = tmpDir;
});

afterEach(() => {
  db.close();
  if (tmpDir) {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    tmpDir = undefined;
  }
});

describe('writeTierFact', () => {
  it('writes a canonical file into the own-tier shard and indexes it', () => {
    const result = writeTierFact(db, duyaRoot, baseInput());

    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.outcome).toBe('inserted');
    expect(result.filePath).toBe('agents/alpha/memory/prefers-concise-answers-prefers-c.md');

    const abs = path.join(duyaRoot, result.filePath!);
    expect(fs.existsSync(abs)).toBe(true);
    const parsed = parseCanonicalFile(abs);
    expect(parsed).not.toBeNull();
    expect(parsed!.canonical_key).toBe('prefers concise answers');
    expect(parsed!.status).toBe('active');
    expect(parsed!.scope).toBe('agent');
    expect(parsed!.scope_id).toBe('alpha');
    expect(parsed!.project_id).toBeNull();
    expect(fs.readFileSync(abs, 'utf8')).toContain('Prefers concise answers');

    const rows = listTierEntries(db, { tier: 'agent', agentProfileId: 'alpha' });
    expect(rows).toHaveLength(1);
    expect(rows[0].file_path).toBe(result.filePath);
  });

  it('routes user-tier writes to the agents/<id>/user shard', () => {
    const result = writeTierFact(db, duyaRoot, baseInput({ tier: 'user' }));
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.filePath).toMatch(/^agents\/alpha\/user\//);
    const parsed = parseCanonicalFile(path.join(duyaRoot, result.filePath!));
    expect(parsed!.scope).toBe('user');
  });

  it('routes project-tier writes to projects/<pid>/agents/<id>', () => {
    const result = writeTierFact(db, duyaRoot, baseInput({ tier: 'project', projectId: 'web' }));
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.filePath).toMatch(/^projects\/web\/agents\/alpha\//);
    const parsed = parseCanonicalFile(path.join(duyaRoot, result.filePath!));
    expect(parsed!.scope).toBe('project');
    expect(parsed!.project_id).toBe('web');
    const rows = listTierEntries(db, { tier: 'project', agentProfileId: 'alpha', projectId: 'web' });
    expect(rows).toHaveLength(1);
  });

  it('rewrites the same dedupe key in place (newest-wins, stable memory_id)', () => {
    const first = writeTierFact(db, duyaRoot, baseInput());
    const firstMemoryId = parseCanonicalFile(path.join(duyaRoot, first.success ? first.filePath! : ''))!.memory_id;

    const second = writeTierFact(db, duyaRoot, baseInput({ fact: 'Prefers concise answers, always' }));
    expect(second.success).toBe(true);
    if (!second.success) return;
    // Same dedupe key → same slug → same file path.
    expect(second.filePath).toBe(first.success ? first.filePath : undefined);
    expect(second.outcome).toBe('updated');

    const parsed = parseCanonicalFile(path.join(duyaRoot, second.filePath!));
    expect(parsed!.memory_id).toBe(firstMemoryId);
    expect(fs.readFileSync(path.join(duyaRoot, second.filePath!), 'utf8')).toContain('always');

    const rows = listTierEntries(db, { tier: 'agent', agentProfileId: 'alpha' });
    expect(rows).toHaveLength(1);
  });

  it('rejects unsafe identity segments', () => {
    const result = writeTierFact(db, duyaRoot, baseInput({ actorAgentId: '../../etc' }));
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.code).toBe('WRITE_FAILED');
    expect(fs.existsSync(path.join(duyaRoot, 'etc'))).toBe(false);
  });

  it('rejects project-tier writes without a projectId', () => {
    const result = writeTierFact(db, duyaRoot, baseInput({ tier: 'project' }));
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.code).toBe('INVALID_INPUT');
  });
});

describe('forgetTierFact', () => {
  it('retires the file and removes the index row', () => {
    const written = writeTierFact(db, duyaRoot, baseInput());
    expect(written.success).toBe(true);

    const forgotten = forgetTierFact(db, duyaRoot, baseInput({ action: 'forget' }));
    expect(forgotten.success).toBe(true);
    if (!forgotten.success) return;
    expect(forgotten.outcome).toBe('removed');
    expect(forgotten.filePath).toBe(written.success ? written.filePath : undefined);

    const abs = path.join(duyaRoot, (forgotten as { filePath?: string }).filePath ?? '');
    expect(parseCanonicalFile(abs)?.status).toBe('retired');

    const rows = listTierEntries(db, { tier: 'agent', agentProfileId: 'alpha' });
    expect(rows).toHaveLength(0);
  });

  it('returns not_found when the writer has no matching entry', () => {
    const result = forgetTierFact(db, duyaRoot, baseInput({ action: 'forget' }));
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.outcome).toBe('not_found');
  });

  it('respects the single-writer rule — one bot cannot forget another bot fact', () => {
    writeTierFact(db, duyaRoot, baseInput({ actorAgentId: 'beta' }));
    const result = forgetTierFact(db, duyaRoot, baseInput({ actorAgentId: 'alpha', action: 'forget' }));
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.outcome).toBe('not_found');
    expect(listTierEntries(db, { tier: 'agent', agentProfileId: 'beta' })).toHaveLength(1);
  });
});
