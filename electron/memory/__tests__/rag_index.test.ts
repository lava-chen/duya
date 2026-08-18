import { describe, it, expect, beforeEach, afterEach } from 'vitest';
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

let tmpRoot: string;
let memoryRoot: string;

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'rag-test-'));
  memoryRoot = path.join(tmpRoot, 'memory');
});

afterEach(() => {
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
  it('excludes git, tmp, and memory-generated projections under the memory root', () => {
    expect(isExcluded('MEMORY.md', true)).toBe(true);
    expect(isExcluded('summary.md', true)).toBe(true);
    expect(isExcluded('global/areas/index.md', true)).toBe(true);
    expect(isExcluded('stage1_policy.md', true)).toBe(true);
    expect(isExcluded('rollout_summaries/2026-x.md', true)).toBe(true);
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
