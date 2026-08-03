import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import Database from 'better-sqlite3';
import type { Database as DatabaseType } from 'better-sqlite3';
import {
  parseCanonicalFile,
  rebuildMemoryEntriesFromFiles,
  type ParsedCanonicalFile,
} from '../memory_entries_rebuild';

interface ParseEnv {
  root: string;
  cleanup: () => void;
}

function makeEnv(): ParseEnv {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rebuild-parse-'));
  return {
    root,
    cleanup: () => {
      try {
        fs.rmSync(root, { recursive: true, force: true });
      } catch {
        /* best-effort */
      }
    },
  };
}

function write(filePath: string, content: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, 'utf8');
}

describe('parseCanonicalFile', () => {
  let env: ParseEnv;
  beforeEach(() => {
    env = makeEnv();
  });
  afterEach(() => {
    env.cleanup();
  });

  it('parses a valid canonical file with full frontmatter', () => {
    const file = path.join(env.root, 'items', 'preference', 'verification-style.md');
    write(
      file,
      [
        '---',
        'memory_id: mem_abc123',
        'canonical_key: preference:verification-style',
        'claim_type: preference',
        'scope: project',
        'scope_id: duya',
        'project_id: 11111111-1111-1111-1111-111111111111',
        'status: active',
        'importance: essential',
        'summary_eligible: true',
        'updated_at: 2026-08-03T12:00:00Z',
        '---',
        '',
        '# Verification style',
        '',
        'Prefer Playwright MCP for UI verification.',
      ].join('\n')
    );

    const result = parseCanonicalFile(file);
    const expected: ParsedCanonicalFile = {
      memory_id: 'mem_abc123',
      canonical_key: 'preference:verification-style',
      claim_type: 'preference',
      scope: 'project',
      scope_id: 'duya',
      project_id: '11111111-1111-1111-1111-111111111111',
      status: 'active',
      importance: 'essential',
      file_path: file,
      updated_at: '2026-08-03T12:00:00Z',
    };
    expect(result).toEqual(expected);
  });

  it('returns null when the file has no frontmatter', () => {
    const file = path.join(env.root, 'items', 'preference', 'no-fm.md');
    write(file, '# No frontmatter\n\nJust body text.');
    expect(parseCanonicalFile(file)).toBeNull();
  });

  it('returns null when required fields are missing (no canonical_key)', () => {
    const file = path.join(env.root, 'items', 'preference', 'incomplete.md');
    write(
      file,
      [
        '---',
        'memory_id: mem_x',
        'claim_type: preference',
        'status: active',
        '---',
        '',
        'Body',
      ].join('\n')
    );
    expect(parseCanonicalFile(file)).toBeNull();
  });

  it('returns null when the file does not exist', () => {
    expect(parseCanonicalFile(path.join(env.root, 'missing.md'))).toBeNull();
  });

  it('parses a retired file (status=retired) for cache rebuild', () => {
    const file = path.join(env.root, 'items', 'fact', 'old-truth.md');
    write(
      file,
      [
        '---',
        'memory_id: mem_retired',
        'canonical_key: fact:old-truth',
        'claim_type: fact',
        'scope: global',
        'scope_id: null',
        'project_id: null',
        'status: retired',
        'importance: normal',
        'summary_eligible: false',
        'updated_at: 2026-01-01T00:00:00Z',
        '---',
        '',
        'Stale.',
      ].join('\n')
    );
    const result = parseCanonicalFile(file);
    expect(result?.status).toBe('retired');
    expect(result?.canonical_key).toBe('fact:old-truth');
  });
});

function createSchema(db: DatabaseType): void {
  db.exec(`
    CREATE TABLE memory_entries (
      memory_id     TEXT PRIMARY KEY,
      scope         TEXT NOT NULL,
      project_id    TEXT,
      kind          TEXT NOT NULL,
      canonical_key TEXT NOT NULL,
      content       TEXT NOT NULL,
      version       INTEGER NOT NULL DEFAULT 1,
      status        TEXT NOT NULL DEFAULT 'active',
      created_at    INTEGER NOT NULL,
      updated_at    INTEGER NOT NULL
    );
  `);
}

function listEntries(
  db: DatabaseType
): Array<{ memory_id: string; canonical_key: string; status: string; kind: string; scope: string }> {
  return db
    .prepare(
      'SELECT memory_id, canonical_key, status, kind, scope FROM memory_entries ORDER BY canonical_key ASC'
    )
    .all() as Array<{ memory_id: string; canonical_key: string; status: string; kind: string; scope: string }>;
}

describe('rebuildMemoryEntriesFromFiles', () => {
  let env: ParseEnv;
  let db: DatabaseType;

  beforeEach(() => {
    env = makeEnv();
    db = new Database(':memory:');
    createSchema(db);
  });

  afterEach(() => {
    db.close();
    env.cleanup();
  });

  it('repopulates memory_entries to match the live files', async () => {
    const itemsDir = path.join(env.root, 'items', 'preference');
    fs.mkdirSync(itemsDir, { recursive: true });
    fs.writeFileSync(
      path.join(itemsDir, 'a.md'),
      [
        '---',
        'memory_id: mem_a',
        'canonical_key: preference:a',
        'claim_type: preference',
        'scope: project',
        'scope_id: duya',
        'project_id: 11111111-1111-1111-1111-111111111111',
        'status: active',
        'importance: essential',
        'updated_at: 2026-08-03T12:00:00Z',
        '---',
        '',
        'Body A',
      ].join('\n')
    );
    fs.writeFileSync(
      path.join(itemsDir, 'b.md'),
      [
        '---',
        'memory_id: mem_b',
        'canonical_key: preference:b',
        'claim_type: preference',
        'scope: global',
        'scope_id: null',
        'project_id: null',
        'status: active',
        'importance: normal',
        'updated_at: 2026-08-03T12:00:00Z',
        '---',
        '',
        'Body B',
      ].join('\n')
    );

    const result = await rebuildMemoryEntriesFromFiles(db, env.root);

    expect(result.processed).toBe(2);
    expect(result.skipped).toBe(0);
    const rows = listEntries(db);
    expect(rows).toHaveLength(2);
    expect(rows[0].canonical_key).toBe('preference:a');
    expect(rows[1].canonical_key).toBe('preference:b');
  });

  it('writes retired files into the cache with status=retired', async () => {
    const file = path.join(env.root, 'items', 'fact', 'old.md');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(
      file,
      [
        '---',
        'memory_id: mem_old',
        'canonical_key: fact:old',
        'claim_type: fact',
        'scope: global',
        'scope_id: null',
        'project_id: null',
        'status: retired',
        'importance: normal',
        'updated_at: 2026-01-01T00:00:00Z',
        '---',
        '',
        'Stale.',
      ].join('\n')
    );

    await rebuildMemoryEntriesFromFiles(db, env.root);

    const rows = listEntries(db);
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe('retired');
  });

  it('clears the table when no canonical files exist', async () => {
    // Seed a stale row that should be wiped.
    db.prepare(
      `INSERT INTO memory_entries (memory_id, scope, project_id, kind, canonical_key, content, version, status, created_at, updated_at)
       VALUES ('mem_stale', 'global', NULL, 'fact', 'fact:stale', 'old', 1, 'active', 0, 0)`
    ).run();

    const result = await rebuildMemoryEntriesFromFiles(db, env.root);

    expect(result.processed).toBe(0);
    expect(listEntries(db)).toHaveLength(0);
  });

  it('skips files that fail to parse and reports them in `skipped`', async () => {
    const dir = path.join(env.root, 'items', 'preference');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'good.md'),
      [
        '---',
        'memory_id: mem_good',
        'canonical_key: preference:good',
        'claim_type: preference',
        'scope: global',
        'scope_id: null',
        'project_id: null',
        'status: active',
        'importance: normal',
        'updated_at: 2026-08-03T12:00:00Z',
        '---',
        '',
        'Body',
      ].join('\n')
    );
    fs.writeFileSync(path.join(dir, 'bad.md'), 'no frontmatter at all');

    const result = await rebuildMemoryEntriesFromFiles(db, env.root);

    expect(result.processed).toBe(1);
    expect(result.skipped).toBe(1);
    expect(listEntries(db)).toHaveLength(1);
  });

  it('also scans entities/ directory', async () => {
    const dir = path.join(env.root, 'entities', 'people');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'alice.md'),
      [
        '---',
        'memory_id: mem_alice',
        'canonical_key: person:alice',
        'claim_type: relationship',
        'scope: global',
        'scope_id: null',
        'project_id: null',
        'status: active',
        'importance: high',
        'updated_at: 2026-08-03T12:00:00Z',
        '---',
        '',
        'Alice',
      ].join('\n')
    );

    const result = await rebuildMemoryEntriesFromFiles(db, env.root);

    expect(result.processed).toBe(1);
    const rows = listEntries(db);
    expect(rows[0].canonical_key).toBe('person:alice');
  });
});