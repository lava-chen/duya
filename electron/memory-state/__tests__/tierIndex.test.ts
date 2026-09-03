import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as crypto from 'crypto';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import type { Database as DatabaseType } from 'better-sqlite3';
import { runMigrations } from '../migrations';
import {
  normalizeDedupeKey,
  computeTierEntryId,
  upsertTierEntry,
  listTierEntries,
  listTierShards,
  getTierEntryByPath,
  removeTierEntryByPath,
  mergedTierRecall,
  rebuildTierIndexFromFiles,
  type TierIndexRow,
} from '../tierIndex';

// Shared mock logger — must be hoisted so vi.mock (also hoisted) sees it
// (same pattern as db.test.ts / logger-handlers.test.ts).
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
  },
}));

function sha256(text: string): string {
  return crypto.createHash('sha256').update(text).digest('hex');
}

function writeMemoryFile(
  duyaRoot: string,
  relPath: string,
  frontmatter: Record<string, string>,
  body = 'Body text.'
): string {
  const abs = path.join(duyaRoot, ...relPath.split('/'));
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  const lines = Object.entries(frontmatter).map(([k, v]) => `${k}: ${v}`);
  const content = ['---', ...lines, '---', '', body, ''].join('\n');
  fs.writeFileSync(abs, content, 'utf8');
  return abs;
}

const BASE_FRONTMATTER = {
  memory_id: 'mem_base',
  claim_type: 'fact',
  scope: 'global',
  status: 'active',
  importance: 'normal',
};

describe('tier key normalization and identity', () => {
  it('normalizes dedupe keys: trim + lowercase + collapse whitespace', () => {
    expect(normalizeDedupeKey('  Person: Alice  ')).toBe('person: alice');
    expect(normalizeDedupeKey('PREFERENCE\tVERIFICATION')).toBe('preference verification');
  });

  it('computes deterministic entry ids stable across file moves', () => {
    const a = computeTierEntryId('user', 'botA', '', 'person:alice');
    const b = computeTierEntryId('user', 'botA', '', 'person:alice');
    const moved = computeTierEntryId('user', 'botA', '', 'person:alice');
    expect(a).toBe(b);
    expect(a).toBe(moved);
    expect(a).not.toBe(computeTierEntryId('user', 'botB', '', 'person:alice'));
    expect(a).not.toBe(computeTierEntryId('agent', 'botA', '', 'person:alice'));
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('upsertTierEntry', () => {
  let db: DatabaseType;

  beforeEach(() => {
    db = new Database(':memory:');
    runMigrations(db);
  });

  afterEach(() => {
    db.close();
  });

  const input = {
    tier: 'agent' as const,
    agentProfileId: 'botA',
    kind: 'profile' as const,
    filePath: 'agents/botA/memory/profile/verification-style.md',
    contentHash: 'hash-1',
  };

  it('inserts, then updates on newer updatedAt, then reports unchanged', () => {
    expect(upsertTierEntry(db, { ...input, dedupeKey: 'Pref:Style', updatedAt: 100 })).toBe('inserted');

    // Normalized key collides with the inserted row → same entry_id.
    expect(upsertTierEntry(db, { ...input, dedupeKey: 'pref:style', contentHash: 'hash-2', updatedAt: 200 })).toBe('updated');
    expect(upsertTierEntry(db, { ...input, dedupeKey: 'pref:style', contentHash: 'hash-3', updatedAt: 150 })).toBe('unchanged');

    const row = getTierEntryByPath(db, input.filePath);
    expect(row?.content_hash).toBe('hash-2');
    expect(row?.updated_at).toBe(200);
    expect(row?.created_at).toBe(100);
    expect(row?.dedupe_key).toBe('pref:style');
  });

  it('updates on equal timestamps only when content hash changes', () => {
    upsertTierEntry(db, { ...input, dedupeKey: 'k', contentHash: 'h1', updatedAt: 100 });
    expect(upsertTierEntry(db, { ...input, dedupeKey: 'k', contentHash: 'h1', updatedAt: 100 })).toBe('unchanged');
    expect(upsertTierEntry(db, { ...input, dedupeKey: 'k', contentHash: 'h2', updatedAt: 100 })).toBe('updated');
  });

  it('rejects tier=agent without agentProfileId and tier=project without projectId', () => {
    expect(() =>
      upsertTierEntry(db, { ...input, tier: 'agent', agentProfileId: '', dedupeKey: 'k', updatedAt: 1 })
    ).toThrow(/agentProfileId/);
    expect(() =>
      upsertTierEntry(db, { tier: 'project', kind: 'note', projectId: '', dedupeKey: 'k', filePath: 'x.md', contentHash: 'h', updatedAt: 1 })
    ).toThrow(/projectId/);
  });

  it('rejects unsafe file paths', () => {
    expect(() =>
      upsertTierEntry(db, { ...input, dedupeKey: 'k', filePath: '../escape.md', updatedAt: 1 })
    ).toThrow(/traverse/);
    expect(() =>
      upsertTierEntry(db, { ...input, dedupeKey: 'k', filePath: 'C:/evil.md', updatedAt: 1 })
    ).toThrow(/relative/);
    expect(() =>
      upsertTierEntry(db, { ...input, dedupeKey: 'k', filePath: 'agents\\botA\\memory.md', updatedAt: 1 })
    ).toThrow(/forward slashes/);
  });

  it('treats a normalized-key collision in one shard as a rewrite (row moves to the newest file)', () => {
    upsertTierEntry(db, { ...input, dedupeKey: 'k', filePath: 'agents/botA/memory/a.md', updatedAt: 1 });
    // Same shard + same key after normalization ('K ' → 'k') = same entry_id:
    // newest-wins rewrite, and the row now points at the newest backing file.
    expect(
      upsertTierEntry(db, { ...input, dedupeKey: 'K ', filePath: 'agents/botA/memory/b.md', contentHash: 'h2', updatedAt: 2 })
    ).toBe('updated');
    expect(getTierEntryByPath(db, 'agents/botA/memory/b.md')).not.toBeNull();
    expect(getTierEntryByPath(db, 'agents/botA/memory/a.md')).toBeNull();
  });
});

describe('listTierEntries / listTierShards', () => {
  let db: DatabaseType;

  beforeEach(() => {
    db = new Database(':memory:');
    runMigrations(db);
  });

  afterEach(() => {
    db.close();
  });

  function seed(): void {
    upsertTierEntry(db, { tier: 'agent', agentProfileId: 'botA', kind: 'profile', dedupeKey: 'own:style', filePath: 'agents/botA/memory/profile.md', contentHash: 'h', updatedAt: 300 });
    upsertTierEntry(db, { tier: 'agent', agentProfileId: 'botA', kind: 'log', dedupeKey: '[episode] 2026-09-01 ship', filePath: 'agents/botA/memory/log.md', contentHash: 'h', updatedAt: 250 });
    upsertTierEntry(db, { tier: 'project', agentProfileId: 'botA', projectId: 'p1', kind: 'note', dedupeKey: 'proj:fact', filePath: 'memory/projects/p1/botA/fact.md', contentHash: 'h', updatedAt: 200 });
    upsertTierEntry(db, { tier: 'user', agentProfileId: 'botB', kind: 'note', dedupeKey: 'person:alice', filePath: 'memory/entities/alice.md', contentHash: 'h', updatedAt: 100 });
    upsertTierEntry(db, { tier: 'user', agentProfileId: '', kind: 'note', dedupeKey: 'fact:legacy', filePath: 'memory/items/legacy.md', contentHash: 'h', updatedAt: 50 });
  }

  it('filters by tier', () => {
    seed();
    const agentRows = listTierEntries(db, { tier: 'agent' });
    expect(agentRows).toHaveLength(2);
    expect(agentRows.every((r: TierIndexRow) => r.tier === 'agent')).toBe(true);
    expect(listTierEntries(db, { tier: 'user' })).toHaveLength(2);
  });

  it('orders by updated_at descending', () => {
    seed();
    expect(listTierEntries(db, { tier: 'agent' }).map((r) => r.updated_at)).toEqual([300, 250]);
  });

  it('filters by shard (agentProfileId / projectIds) and kind', () => {
    seed();
    expect(listTierEntries(db, { tier: 'project', projectIds: ['p1'] })).toHaveLength(1);
    expect(listTierEntries(db, { tier: 'project', projectIds: ['p2'] })).toHaveLength(0);
    expect(listTierEntries(db, { tier: 'project', projectIds: [] })).toHaveLength(0);
    expect(listTierEntries(db, { tier: 'agent', kind: 'log' })).toHaveLength(1);
    expect(listTierEntries(db, { tier: 'agent', kind: 'note' })).toHaveLength(0);
    expect(listTierEntries(db, { tier: 'user', agentProfileId: 'botB' })).toHaveLength(1);
  });

  it('summarizes shards per tier', () => {
    seed();
    const agentShards = listTierShards(db, 'agent');
    expect(agentShards).toHaveLength(1);
    expect(agentShards[0]).toMatchObject({ agentProfileId: 'botA', entryCount: 2, lastUpdatedAt: 300 });
    const userShards = listTierShards(db, 'user');
    expect(userShards).toHaveLength(2); // legacy '' shard + botB shard
  });
});

describe('getTierEntryByPath / removeTierEntryByPath', () => {
  let db: DatabaseType;

  beforeEach(() => {
    db = new Database(':memory:');
    runMigrations(db);
  });

  afterEach(() => {
    db.close();
  });

  it('round-trips by path', () => {
    upsertTierEntry(db, { tier: 'agent', agentProfileId: 'botA', kind: 'note', dedupeKey: 'k', filePath: 'agents/botA/memory/n.md', contentHash: 'h', updatedAt: 1 });
    expect(getTierEntryByPath(db, 'agents/botA/memory/n.md')?.dedupe_key).toBe('k');
    expect(getTierEntryByPath(db, 'missing.md')).toBeNull();
    expect(removeTierEntryByPath(db, 'agents/botA/memory/n.md')).toBe(true);
    expect(removeTierEntryByPath(db, 'agents/botA/memory/n.md')).toBe(false);
    expect(getTierEntryByPath(db, 'agents/botA/memory/n.md')).toBeNull();
  });
});

describe('mergedTierRecall', () => {
  let db: DatabaseType;

  beforeEach(() => {
    db = new Database(':memory:');
    runMigrations(db);
  });

  afterEach(() => {
    db.close();
  });

  it('merges three tiers with precedence and earliest-via attribution', () => {
    upsertTierEntry(db, { tier: 'agent', agentProfileId: 'botA', kind: 'profile', dedupeKey: 'pref:style', filePath: 'a.md', contentHash: 'h', updatedAt: 100, createdAt: 100 });
    // user tier: two writers state the same fact — earliest becomes via
    upsertTierEntry(db, { tier: 'user', agentProfileId: 'botB', kind: 'note', dedupeKey: 'person:alice', filePath: 'b.md', contentHash: 'h', updatedAt: 300, createdAt: 300 });
    upsertTierEntry(db, { tier: 'user', agentProfileId: 'botC', kind: 'note', dedupeKey: 'person:alice', filePath: 'c.md', contentHash: 'h', updatedAt: 200, createdAt: 200 });
    upsertTierEntry(db, { tier: 'user', agentProfileId: 'botB', kind: 'note', dedupeKey: 'fact:only-user', filePath: 'd.md', contentHash: 'h', updatedAt: 50, createdAt: 50 });
    // project tier: loses to nothing here, distinct key
    upsertTierEntry(db, { tier: 'project', agentProfileId: 'botA', projectId: 'p1', kind: 'note', dedupeKey: 'proj:fact', filePath: 'e.md', contentHash: 'h', updatedAt: 90, createdAt: 90 });

    const { resolved, suppressed } = mergedTierRecall(db, { agentProfileId: 'botA', projectIds: ['p1'] });

    const byKey = new Map(resolved.map((r) => [r.entry.dedupe_key, r]));
    expect(resolved).toHaveLength(4);
    expect(byKey.get('pref:style')?.tier).toBe('agent');
    expect(byKey.get('person:alice')?.viaShard).toBe('user:botC'); // earliest created
    expect(byKey.get('fact:only-user')?.tier).toBe('user');
    expect(byKey.get('proj:fact')?.tier).toBe('project');
    // alice re-stated by botB (later) is suppressed
    expect(suppressed.some((s) => s.entry.dedupe_key === 'person:alice' && s.entry.agent_profile_id === 'botB')).toBe(true);
  });

  it('excludes project tier when projectIds is absent', () => {
    upsertTierEntry(db, { tier: 'project', agentProfileId: 'botA', projectId: 'p1', kind: 'note', dedupeKey: 'proj:fact', filePath: 'e.md', contentHash: 'h', updatedAt: 90 });
    const { resolved } = mergedTierRecall(db, { agentProfileId: 'botA' });
    expect(resolved).toHaveLength(0);
  });
});

describe('rebuildTierIndexFromFiles', () => {
  let db: DatabaseType;
  let duyaRoot: string;

  beforeEach(() => {
    db = new Database(':memory:');
    runMigrations(db);
    duyaRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'tier-rebuild-'));
  });

  afterEach(() => {
    db.close();
    try {
      fs.rmSync(duyaRoot, { recursive: true, force: true });
    } catch {
      /* best-effort */
    }
  });

  it('backfills legacy user/project rows from items, entities and global trees', () => {
    writeMemoryFile(duyaRoot, 'memory/items/preference/style.md', {
      ...BASE_FRONTMATTER,
      memory_id: 'mem_style',
      canonical_key: 'Preference:Style',
      updated_at: '2026-08-03T12:00:00Z',
    });
    writeMemoryFile(duyaRoot, 'memory/entities/people/alice.md', {
      ...BASE_FRONTMATTER,
      memory_id: 'mem_alice',
      canonical_key: 'person:alice',
      updated_at: '2026-08-01T00:00:00Z',
    });
    writeMemoryFile(duyaRoot, 'memory/global/areas/duya.md', {
      ...BASE_FRONTMATTER,
      memory_id: 'mem_duya',
      canonical_key: 'area:duya',
      project_id: '11111111-1111-1111-1111-111111111111',
      updated_at: '2026-08-02T00:00:00Z',
    });

    const report = rebuildTierIndexFromFiles(db, duyaRoot);
    expect(report.dryRun).toBe(false);
    expect(report.scannedFiles).toBe(3);
    expect(report.parsed).toBe(3);
    expect(report.skipped).toBe(0);
    expect(report.inserted).toBe(3);

    const userRows = listTierEntries(db, { tier: 'user' });
    expect(userRows.map((r) => r.dedupe_key)).toContain('preference:style'); // lowercased
    const projectRows = listTierEntries(db, { tier: 'project' });
    expect(projectRows).toHaveLength(1);
    expect(projectRows[0].project_id).toBe('11111111-1111-1111-1111-111111111111');
    expect(projectRows[0].kind).toBe('note');
    // all backfilled rows are legacy (no writer)
    expect(userRows.every((r) => r.agent_profile_id === '')).toBe(true);
  });

  it('dry-run reports counts without writing', () => {
    writeMemoryFile(duyaRoot, 'memory/items/preference/dry.md', {
      ...BASE_FRONTMATTER,
      memory_id: 'mem_dry',
      canonical_key: 'fact:dry',
      updated_at: '2026-08-03T12:00:00Z',
    });
    const report = rebuildTierIndexFromFiles(db, duyaRoot, { dryRun: true });
    expect(report.dryRun).toBe(true);
    expect(report.parsed).toBe(1);
    expect(report.inserted).toBe(0);
    expect(db.prepare('SELECT COUNT(*) AS n FROM memory_tier_index').get()).toMatchObject({ n: 0 });
  });

  it('skips non-active and unparseable files', () => {
    writeMemoryFile(duyaRoot, 'memory/items/fact/retired.md', {
      ...BASE_FRONTMATTER,
      memory_id: 'mem_ret',
      canonical_key: 'fact:retired',
      status: 'retired',
      updated_at: '2026-08-03T12:00:00Z',
    });
    writeMemoryFile(duyaRoot, 'memory/items/fact/nofm.md', 'no frontmatter');
    const report = rebuildTierIndexFromFiles(db, duyaRoot);
    expect(report.parsed).toBe(0);
    expect(report.skipped).toBe(2);
    expect(db.prepare('SELECT COUNT(*) AS n FROM memory_tier_index').get()).toMatchObject({ n: 0 });
  });

  it('is idempotent and resolves same-key collisions via newest-wins', () => {
    writeMemoryFile(duyaRoot, 'memory/items/fact/dup-new.md', {
      ...BASE_FRONTMATTER,
      memory_id: 'mem_dup_new',
      canonical_key: 'fact:dup',
      updated_at: '2026-08-05T00:00:00Z',
    });
    // Second file normalizes to the same dedupe key in the same
    // (legacy, writer='') shard → newest-wins keeps the newer file.
    writeMemoryFile(duyaRoot, 'memory/entities/fact-dup.md', {
      ...BASE_FRONTMATTER,
      memory_id: 'mem_dup_old',
      canonical_key: 'fact:dup',
      updated_at: '2026-08-01T00:00:00Z',
    });

    const first = rebuildTierIndexFromFiles(db, duyaRoot);
    // items/ is scanned before entities/, so the newer file inserts first;
    // the older file's upsert is a no-op (newest-wins keeps the newer file).
    expect(first.inserted).toBe(1);
    expect(first.unchanged).toBe(1);
    expect(first.updated).toBe(0);
    // the surviving row points at the newer file
    expect(getTierEntryByPath(db, 'memory/items/fact/dup-new.md')).not.toBeNull();
    expect(getTierEntryByPath(db, 'memory/entities/fact-dup.md')).toBeNull();

    const second = rebuildTierIndexFromFiles(db, duyaRoot);
    expect(second.inserted).toBe(0);
    expect(second.updated).toBe(0);
    expect(second.unchanged).toBe(2);
  });

  it('removes rows whose backing file vanished, scoped to scanned roots', () => {
    const abs = writeMemoryFile(duyaRoot, 'memory/items/fact/gone.md', {
      ...BASE_FRONTMATTER,
      memory_id: 'mem_gone',
      canonical_key: 'fact:gone',
      updated_at: '2026-08-03T12:00:00Z',
    });
    rebuildTierIndexFromFiles(db, duyaRoot);
    expect(listTierEntries(db, { tier: 'user' })).toHaveLength(1);

    fs.unlinkSync(abs);
    const report = rebuildTierIndexFromFiles(db, duyaRoot);
    expect(report.removed).toBe(1);
    expect(listTierEntries(db, { tier: 'user' })).toHaveLength(0);

    // Agent-tier rows written directly are never touched by the rebuild.
    upsertTierEntry(db, { tier: 'agent', agentProfileId: 'botA', kind: 'note', dedupeKey: 'own:k', filePath: 'agents/botA/memory/n.md', contentHash: sha256('x'), updatedAt: 1 });
    rebuildTierIndexFromFiles(db, duyaRoot);
    expect(listTierEntries(db, { tier: 'agent', agentProfileId: 'botA' })).toHaveLength(1);
  });
});
