import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import Database from 'better-sqlite3';
import {
  resolveScanRoots,
  isExcluded,
  parseDocument,
  refreshMemoryRagIndex,
  defaultRagIndexPath,
  type EmbeddingClient,
} from '../rag_index';
import { searchMemoryIndex, keywordSearch, KEYWORD_CANDIDATE_LIMIT, VECTOR_CANDIDATE_LIMIT } from '../rag_search';
import { _setConfigStoreForTest } from '../../config/store-instance';
import type { ConfigStore } from '../../config/store';

const mocks = vi.hoisted(() => ({ embeddingClient: null as EmbeddingClient | null }));

// `provider-store-electron` is an Electron-only bridge (documented as
// unimportable from unit tests); the embedding client is injected so the
// vector path is deterministic. `loadBetterSqlite3Ctor` needs no mock — it
// is a plain `require('better-sqlite3')`.
vi.mock('../../services/providers/provider-store-electron', () => ({
  getProviderStore: () => ({}),
}));

vi.mock('../rag_embedding_client', () => ({
  createEmbeddingClient: () => mocks.embeddingClient,
}));

let tmpRoot: string;
let memoryRoot: string;

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'rag-test-'));
  memoryRoot = path.join(tmpRoot, 'memory');
});

afterEach(() => {
  _setConfigStoreForTest(undefined);
  mocks.embeddingClient = null;
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

function writeTree(root: string, files: Record<string, string>): void {
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.resolve(root, rel);
    const relCheck = path.relative(root, abs);
    if (relCheck.startsWith('..') || path.isAbsolute(relCheck)) {
      throw new Error(`refusing path outside tree: ${rel}`);
    }
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content, 'utf-8');
  }
}

function readRows(dbPath: string): {
  docs: Array<{ root: string; rel_path: string; title: string; embedding: string | null }>;
  meta: Record<string, string>;
} {
  const db = new Database(dbPath, { readonly: true });
  try {
    const docs = db
      .prepare('SELECT root, rel_path, title, embedding FROM documents ORDER BY rel_path')
      .all() as Array<{ root: string; rel_path: string; title: string; embedding: string | null }>;
    const metaRows = db.prepare('SELECT key, value FROM meta').all() as Array<{ key: string; value: string }>;
    const meta: Record<string, string> = {};
    for (const r of metaRows) meta[r.key] = r.value;
    return { docs, meta };
  } finally {
    db.close();
  }
}

describe('resolveScanRoots', () => {
  it('memory root always first; ~ expands; duplicates dedupe', () => {
    const home = path.join(tmpRoot, 'home');
    const homeNotes = path.join(home, 'notes');
    const roots = resolveScanRoots(memoryRoot, ['~/notes', homeNotes, homeNotes, ''], home);
    expect(roots).toEqual([path.resolve(memoryRoot), homeNotes]);
  });

  it('handles bare ~ as home', () => {
    const home = path.join(tmpRoot, 'home');
    const roots = resolveScanRoots(memoryRoot, ['~'], home);
    expect(roots[1]).toBe(path.resolve(home));
  });
});

describe('isExcluded', () => {
  it('excludes git, tmp, and memory-generated projections (but indexes rollout_summaries)', () => {
    expect(isExcluded('MEMORY.md', true)).toBe(true);
    expect(isExcluded('summary.md', true)).toBe(true);
    expect(isExcluded('global/areas/index.md', true)).toBe(true);
    expect(isExcluded('stage1_policy.md', true)).toBe(true);
    expect(isExcluded('rollout_summaries/2026-x.md', true)).toBe(false);
    expect(isExcluded('memory-config/layout.json', true)).toBe(true);
    expect(isExcluded('.git/HEAD', true)).toBe(true);
    expect(isExcluded('notes.md.tmp', true)).toBe(true);
  });

  it('indexes user memory files including ad_hoc extensions', () => {
    expect(isExcluded('global/areas/crest-hydrology.md', true)).toBe(false);
    expect(isExcluded('extensions/ad_hoc/todo.md', true)).toBe(false);
    expect(isExcluded('global/preferences/x.md', true)).toBe(false);
  });

  it('looser rules for non-memory scan roots', () => {
    expect(isExcluded('docs/index.md', false)).toBe(false);
    expect(isExcluded('README.md', false)).toBe(false);
    expect(isExcluded('sub/.git/x', false)).toBe(true);
    expect(isExcluded('x.tmp', false)).toBe(true);
  });
});

describe('parseDocument', () => {
  it('derives title from the first H1 and strips it from content', () => {
    const doc = parseDocument('/r', 'global/areas/x.md', '# My Title\n\nbody line\n', 1_700_000_000_000);
    expect(doc.title).toBe('My Title');
    expect(doc.content).toBe('body line');
    expect(doc.updatedAt).toBe(1_700_000_000_000);
  });

  it('falls back to the file slug when no H1 exists', () => {
    const doc = parseDocument('/r', 'global/areas/some-file.md', 'no heading', 0);
    expect(doc.title).toBe('some-file');
  });
});

describe('refreshMemoryRagIndex', () => {
  it('builds a keyword+embedding index across multiple roots', async () => {
    writeTree(memoryRoot, {
      'global/areas/crest.md': '# Crest Design\n\nhydrology notes here\n',
      'extensions/ad_hoc/scratch.md': '# Scratch\n\nunstructured note\n',
      'MEMORY.md': '# Registry\n\nskip me\n',
    });
    const notesRoot = path.join(tmpRoot, 'notes');
    writeTree(notesRoot, {
      'research/water.md': '# Water Research\n\ndifferent root\n',
    });
    const dbPath = path.join(tmpRoot, 'rag', 'index.db');

    const fake: EmbeddingClient = {
      embed: async (texts) => texts.map((_, i) => [i, 1]),
    };

    const result = await refreshMemoryRagIndex(
      resolveScanRoots(memoryRoot, [notesRoot], os.homedir()),
      { dbPath, embeddingEnabled: true, embeddingClient: fake, now: 123 },
    );

    expect(result.documents).toBe(3);
    expect(result.embedded).toBe(3);
    expect(result.scanRoots).toHaveLength(2);

    const { docs, meta } = readRows(dbPath);
    const titles = docs.map((d) => d.title).sort();
    expect(titles).toEqual(['Crest Design', 'Scratch', 'Water Research']);
    expect(docs.every((d) => d.embedding !== null)).toBe(true);
    expect(docs.some((d) => d.root === notesRoot)).toBe(true);
    expect(meta.built_at).toBe('123');
    expect(meta.embedding_enabled).toBe('true');

    // FTS5 keyword search works (trigram tokenizer).
    const fts = new Database(dbPath, { readonly: true });
    try {
      const hits = fts
        .prepare("SELECT rowid FROM documents_fts WHERE documents_fts MATCH 'hydrology'")
        .all();
      expect(hits).toHaveLength(1);
    } finally {
      fts.close();
    }
  });

  it('degrades to keyword-only when the embedding client throws', async () => {
    writeTree(memoryRoot, {
      'global/preferences/p.md': '# Pref\n\nbody\n',
    });
    const dbPath = path.join(tmpRoot, 'rag', 'index.db');
    const failing: EmbeddingClient = {
      embed: async () => {
        throw new Error('provider down');
      },
    };

    const result = await refreshMemoryRagIndex([memoryRoot], {
      dbPath,
      embeddingEnabled: true,
      embeddingClient: failing,
    });

    expect(result.documents).toBe(1);
    expect(result.embedded).toBe(0);
    const { docs, meta } = readRows(dbPath);
    expect(docs[0].embedding).toBeNull();
    expect(meta.embedding_enabled).toBe('false');
  });

  it('skips embeddings entirely when disabled or client absent', async () => {
    writeTree(memoryRoot, { 'global/areas/a.md': '# A\n\nbody\n' });
    const dbPath = path.join(tmpRoot, 'rag', 'index.db');

    await refreshMemoryRagIndex([memoryRoot], {
      dbPath,
      embeddingEnabled: false,
      embeddingClient: { embed: async () => [] },
    });
    expect(readRows(dbPath).docs[0].embedding).toBeNull();

    await refreshMemoryRagIndex([memoryRoot], {
      dbPath,
      embeddingEnabled: true,
      embeddingClient: null,
    });
    expect(readRows(dbPath).meta.embedding_enabled).toBe('false');
  });

  it('removes documents that disappeared since the last refresh', async () => {
    writeTree(memoryRoot, {
      'global/areas/a.md': '# A\n\nbody\n',
      'global/areas/b.md': '# B\n\nbody\n',
    });
    const dbPath = path.join(tmpRoot, 'rag', 'index.db');
    await refreshMemoryRagIndex([memoryRoot], { dbPath, embeddingEnabled: false });

    fs.rmSync(path.join(memoryRoot, 'global/areas/b.md'));
    await refreshMemoryRagIndex([memoryRoot], { dbPath, embeddingEnabled: false });

    const { docs } = readRows(dbPath);
    expect(docs.map((d) => d.rel_path)).toEqual(['global/areas/a.md']);
  });

  it('survives missing scan roots', async () => {
    const missing = path.join(tmpRoot, 'nope');
    const result = await refreshMemoryRagIndex([missing], {
      dbPath: path.join(tmpRoot, 'rag', 'index.db'),
      embeddingEnabled: false,
    });
    expect(result.documents).toBe(0);
  });
});

describe('defaultRagIndexPath', () => {
  it('points under ~/.duya/rag (platform separators)', () => {
    const joined = defaultRagIndexPath(path.join('home', 'u'));
    expect(joined).toBe(path.join('home', 'u', '.duya', 'rag', 'memory-rag.db'));
  });
});

/** Build an (empty) index so the `documents` schema exists, then return its path. */
async function createIndexPath(name: string): Promise<string> {
  const dbPath = path.join(tmpRoot, name, 'index.db');
  await refreshMemoryRagIndex([memoryRoot], { dbPath, embeddingEnabled: false });
  return dbPath;
}

/** Insert documents directly so the rowid order (the candidate window order) is explicit. */
function seedDocuments(
  dbPath: string,
  rows: Array<{ relPath: string; title: string; content: string; embedding?: string | null }>,
): void {
  const db = new Database(dbPath);
  try {
    const insert = db.prepare(
      'INSERT INTO documents (root, rel_path, title, content, updated_at, embedding) VALUES (?, ?, ?, ?, ?, ?)',
    );
    db.transaction(() => {
      for (const r of rows) {
        insert.run(memoryRoot, r.relPath, r.title, r.content, 0, r.embedding ?? null);
      }
    })();
  } finally {
    db.close();
  }
}

function useRagConfig(cfg: Record<string, unknown>): void {
  _setConfigStoreForTest({
    getByPath: (p: string) => (p === 'memory.rag' ? cfg : undefined),
  } as unknown as ConfigStore);
}

describe('keywordSearch candidate bounds (ISS-33)', () => {
  it('caps the short-CJK LIKE scan at KEYWORD_CANDIDATE_LIMIT and orders it by rowid', async () => {
    const dbPath = await createIndexPath('rag-keyword');
    // 3x the cap, every row matching both 2-char CJK terms: an uncapped
    // leading-wildcard LIKE returns all of them into the agent process.
    const seeded = Array.from({ length: KEYWORD_CANDIDATE_LIMIT * 3 }, (_, i) => ({
      relPath: `notes/doc-${String(i).padStart(4, '0')}.md`,
      title: `调度方案 ${i}`,
      content: `本段正文讨论调度方案第 ${i} 节的安排。`,
    }));
    seedDocuments(dbPath, seeded);

    const db = new Database(dbPath, { readonly: true });
    try {
      const hits = keywordSearch(db, '调度 方案');
      expect(hits).toHaveLength(KEYWORD_CANDIDATE_LIMIT);
      // Deterministic rowid window, not an arbitrary scan-order prefix.
      expect(hits.map((h) => h.relPath)).toEqual(
        seeded.slice(0, KEYWORD_CANDIDATE_LIMIT).map((r) => r.relPath),
      );
      // Same query, same candidates.
      expect(keywordSearch(db, '调度 方案').map((h) => h.relPath)).toEqual(
        hits.map((h) => h.relPath),
      );
    } finally {
      db.close();
    }
  });

  it('honours a caller-supplied cap and clamps non-positive values', async () => {
    const dbPath = await createIndexPath('rag-keyword-tune');
    seedDocuments(
      dbPath,
      Array.from({ length: 12 }, (_, i) => ({
        relPath: `notes/d${i}.md`,
        title: `调度 ${i}`,
        content: '调度安排',
      })),
    );

    const db = new Database(dbPath, { readonly: true });
    try {
      expect(keywordSearch(db, '调度', 5)).toHaveLength(5);
      expect(keywordSearch(db, '调度', 0)).toHaveLength(1);
      expect(keywordSearch(db, '调度', Number.NaN)).toHaveLength(12);
    } finally {
      db.close();
    }
  });

  it('still ranks a full-match row above a partial match inside the cap', async () => {
    const dbPath = await createIndexPath('rag-keyword-rank');
    seedDocuments(dbPath, [
      { relPath: 'a-full.md', title: '调度方案', content: '调度 方案 完整命中' },
      { relPath: 'b-partial.md', title: '调度', content: '只有调度命中' },
    ]);

    const db = new Database(dbPath, { readonly: true });
    try {
      const hits = keywordSearch(db, '调度 方案');
      expect(hits.map((h) => h.relPath)).toEqual(['a-full.md', 'b-partial.md']);
      expect(hits[0].score).toBe(1);
      expect(hits[1].score).toBeCloseTo(0.5);
    } finally {
      db.close();
    }
  });
});

describe('searchMemoryIndex vector candidate bounds (ISS-32)', () => {
  it('caps the vector candidate window at the rowid prefix, without re-ranking', async () => {
    const dbPath = await createIndexPath('rag-vector');
    const total = 8;
    // Cosine against [1, 0] falls as `i` grows, so the *last* rows would
    // score highest: a cap that re-ranked or ignored the cap would return
    // them, while the rowid window returns the first ones.
    const seeded = Array.from({ length: total }, (_, i) => ({
      relPath: `notes/v${i}.md`,
      title: `Vector ${i}`,
      content: 'unrelated body text without any query terms',
      embedding: JSON.stringify([1, 0.1 * (total - i)]),
    }));
    seedDocuments(dbPath, seeded);

    mocks.embeddingClient = { embed: async () => [[1, 0]] };
    useRagConfig({ enabled: true, index_path: dbPath, embedding_enabled: true });

    const bounded = await searchMemoryIndex('hydrology notes', { limit: 20, vectorCandidateLimit: 3 });
    expect(bounded.ok).toBe(true);
    if (!bounded.ok) return;
    expect(bounded.mode).toBe('vector');
    // Candidates are the rowid prefix (output order is still score-ranked).
    expect(bounded.hits.map((h) => h.title).sort()).toEqual(['Vector 0', 'Vector 1', 'Vector 2']);
    // Vector 7 has the best cosine overall, so this proves the window
    // bounds candidates instead of re-ranking them.
    expect(bounded.hits[0].title).toBe('Vector 2');
    expect(bounded.hits.map((h) => h.score)).toEqual([...bounded.hits].map((h) => h.score).sort((a, b) => b - a));

    // Unbounded default: every row is a candidate, ordering still stable.
    const all = await searchMemoryIndex('hydrology notes', { limit: 20 });
    expect(all.ok).toBe(true);
    if (!all.ok) return;
    expect(all.hits).toHaveLength(total);
    expect(all.hits[0].title).toBe('Vector 7');
    expect(all.hits[all.hits.length - 1].score).toBeLessThan(bounded.hits[0].score);
    expect(VECTOR_CANDIDATE_LIMIT).toBeGreaterThanOrEqual(total);
  });

  it('reports an empty index instead of throwing when the vector window is empty', async () => {
    const dbPath = await createIndexPath('rag-vector-empty');
    mocks.embeddingClient = { embed: async () => [[1, 0]] };
    useRagConfig({ enabled: true, index_path: dbPath, embedding_enabled: true });

    const res = await searchMemoryIndex('hydrology notes');
    expect(res).toEqual({ ok: true, mode: 'keyword', skipped: false, hits: [] });
  });
});
