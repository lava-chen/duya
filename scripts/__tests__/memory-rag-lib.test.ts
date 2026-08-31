/**
 * Unit tests for the RAG keyword search core
 * (scripts/memory-rag-lib.mjs keywordSearch).
 *
 * Requires the Node-ABI better-sqlite3 build: run `npm run rebuild:node`
 * before `npm test` (see AGENTS.md footguns).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import Database from 'better-sqlite3';
import {
  keywordSearch,
  MIN_PROMPT_CHARS,
  filterPrompt,
  buildSnippet,
  stripFrontmatter,
  extractTerms,
  SNIPPET_MAX_LEN,
} from '../memory-rag-lib.mjs';

let tmpDir: string;
let db: Database;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rag-kw-test-'));
  db = new Database(path.join(tmpDir, 'test.db'));
  db.exec(`
    CREATE TABLE documents (
      rowid INTEGER PRIMARY KEY AUTOINCREMENT,
      root TEXT NOT NULL,
      rel_path TEXT NOT NULL,
      title TEXT NOT NULL,
      content TEXT NOT NULL,
      updated_at INTEGER NOT NULL,
      embedding TEXT,
      UNIQUE(root, rel_path)
    );
    CREATE VIRTUAL TABLE documents_fts USING fts5(title, content, tokenize='trigram');
  `);
  const insertDoc = db.prepare(
    'INSERT INTO documents (root, rel_path, title, content, updated_at) VALUES (?, ?, ?, ?, ?)',
  );
  const insertFts = db.prepare('INSERT INTO documents_fts (rowid, title, content) VALUES (?, ?, ?)');
  const docs: Array<[string, string, string]> = [
    ['a-full.md', 'Sandbox fallback read tool', 'sandbox fallback read tool all four terms here'],
    ['b-partial.md', 'Sandbox notes', 'only the sandbox term appears'],
    ['c-cjk.md', '调度手册', '五强溪水库调度手册内容'],
    ['d-other.md', 'Unrelated', 'completely unrelated content about nothing'],
    ['e-case.md', 'Case study', 'The Sandbox Module and its Read fallback'],
  ];
  for (const [rel, title, content] of docs) {
    const info = insertDoc.run('root', rel, title, content, 0);
    insertFts.run(info.lastInsertRowid, title, content);
  }
});

afterEach(() => {
  db.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function relOf(hits: Array<{ rel_path: string }>): string[] {
  return hits.map((h) => h.rel_path);
}

describe('keywordSearch', () => {
  it('ranks a full-match doc first with score 1.0', () => {
    const hits = keywordSearch(db, 'sandbox fallback read tool');
    expect(hits[0].rel_path).toBe('a-full.md');
    expect(hits[0].score).toBe(1);
    expect(relOf(hits)).toContain('b-partial.md');
  });

  it('scores partial matches by the matched-term ratio', () => {
    const hits = keywordSearch(db, 'sandbox fallback read tool');
    const partial = hits.find((h) => h.rel_path === 'b-partial.md');
    expect(partial).toBeDefined();
    expect(partial!.score).toBeCloseTo(0.25, 5);
  });

  it('finds 2-char CJK terms via the LIKE fallback', () => {
    const hits = keywordSearch(db, '五强溪 调度');
    expect(relOf(hits)).toContain('c-cjk.md');
    expect(hits.find((h) => h.rel_path === 'c-cjk.md')!.score).toBe(1);
  });

  it('drops 2-char non-CJK terms entirely', () => {
    expect(keywordSearch(db, 'go')).toEqual([]);
    const hits = keywordSearch(db, 'go sandbox');
    expect(hits.length).toBeGreaterThan(0);
    expect(relOf(hits)).toContain('a-full.md');
    expect(hits.every((h) => h.score === 1)).toBe(true);
    expect(relOf(hits)).not.toContain('d-other.md');
  });

  it('matches ASCII terms case-insensitively', () => {
    const hits = keywordSearch(db, 'Sandbox read');
    expect(relOf(hits)).toContain('e-case.md');
  });

  it('returns [] for empty or too-short queries', () => {
    expect(keywordSearch(db, '')).toEqual([]);
    expect(keywordSearch(db, '   ')).toEqual([]);
    expect(keywordSearch(db, 'a')).toEqual([]);
    expect(keywordSearch(db, 'ok')).toEqual([]);
  });

  it('does not crash on quotes or backslashes in the query', () => {
    const hits = keywordSearch(db, '"sandbox" \\ read');
    expect(Array.isArray(hits)).toBe(true);
  });
});

describe('filterPrompt', () => {
  it('keeps short CJK queries (>=3 chars) but drops fillers', () => {
    expect(MIN_PROMPT_CHARS).toBe(3);
    expect(filterPrompt('五强溪')).not.toBeNull();
    expect(filterPrompt('调度图')).not.toBeNull();
    expect(filterPrompt('继续')).toBeNull();
    expect(filterPrompt('明白了')).toBeNull();
    expect(filterPrompt('ok')).toBeNull();
  });

  it('strips surrounding punctuation so "你好。" / "继续？" skip RAG but real queries pass', () => {
    // Filler typed with trailing CJK/ASCII punctuation used to slip past
    // the gate (its length was 3) and trigger a RAG retrieval every time.
    expect(filterPrompt('你好。')).toBeNull();
    expect(filterPrompt('你好！')).toBeNull();
    expect(filterPrompt('继续？')).toBeNull();
    expect(filterPrompt('继续，')).toBeNull();
    expect(filterPrompt('hi!')).toBeNull();
    expect(filterPrompt('Hi?')).toBeNull();
    // Pure-punctuation messages collapse to empty and are skipped.
    expect(filterPrompt('？？？')).toBeNull();
    // Punctuated real queries are kept (still >= 3 chars after stripping).
    expect(filterPrompt('五强溪。')).toBe('五强溪。');
    expect(filterPrompt('帮我写个函数。')).not.toBeNull();
  });
});

describe('extractTerms', () => {
  it('keeps >=3-char tokens and 2-char CJK tokens, drops the rest', () => {
    expect(extractTerms('STALE_STATE lock')).toEqual(['STALE_STATE', 'lock']);
    expect(extractTerms('五强溪 调度')).toEqual(['五强溪', '调度']);
    expect(extractTerms('go sandbox')).toEqual(['sandbox']);
    expect(extractTerms('ok')).toEqual([]);
    expect(extractTerms('')).toEqual([]);
  });

  it('cleans quotes and backslashes before splitting', () => {
    expect(extractTerms('"sandbox" \\ read')).toEqual(['sandbox', 'read']);
  });
});

describe('stripFrontmatter', () => {
  it('drops a leading YAML block with a standalone closing ---', () => {
    const raw = '---\ntags: [a]\ntitle: t\n---\n# Body\n\ncontent';
    expect(stripFrontmatter(raw)).toBe('# Body\n\ncontent');
  });

  it('leaves content without a leading --- untouched', () => {
    const raw = '# Body\n\ncontent';
    expect(stripFrontmatter(raw)).toBe(raw);
  });
});

describe('buildSnippet', () => {
  const filler = Array.from({ length: 40 }, (_, i) => `filler sentence ${i + 1} padding words`).join(' ');

  it('windows around a mid-document term with truncation markers', () => {
    const content = `${filler} STALE_STATE lock protocol rule ${filler}`;
    const snippet = buildSnippet(content, ['STALE_STATE']);
    expect(snippet).toContain('STALE_STATE');
    expect(snippet.startsWith('…')).toBe(true);
    expect(snippet.endsWith('…')).toBe(true);
    expect(snippet.length).toBeLessThanOrEqual(SNIPPET_MAX_LEN + 2);
  });

  it('anchors on the earliest of several terms', () => {
    const content = `${filler} first anchor zzz ${filler} second anchor yyy`;
    const snippet = buildSnippet(content, ['zzz', 'yyy']);
    expect(snippet).toContain('zzz');
    expect(snippet).not.toContain('yyy');
  });

  it('handles CJK terms in a CJK document', () => {
    const cjkFiller = '五强溪水库调度手册内容反复出现的铺垫句子 '.repeat(30);
    const content = `${cjkFiller}死水位试算结果落在这里。${cjkFiller}`;
    const snippet = buildSnippet(content, extractTerms('死水位'));
    expect(snippet).toContain('死水位');
    expect(snippet.startsWith('…')).toBe(true);
  });

  it('skips YAML frontmatter so the preview starts at the real body', () => {
    const content = `---\ntags: [protocol]\ntitle: Fallback\n---\n## Summary\n\n${filler} STALE_STATE rule ${filler}`;
    const snippet = buildSnippet(content, ['STALE_STATE']);
    expect(snippet).toContain('STALE_STATE');
    expect(snippet).not.toContain('tags:');
    expect(snippet).not.toContain('Fallback');
  });

  it('falls back to the body head for vector-only hits', () => {
    const content = `${filler} no query term present here ${filler}`;
    const snippet = buildSnippet(content, undefined);
    expect(snippet.startsWith('filler sentence 1')).toBe(true);
    expect(snippet.endsWith('…')).toBe(true);
  });

  it('returns the full normalized body when it fits the window', () => {
    const content = '# Title\n\nshort body with STALE_STATE here';
    expect(buildSnippet(content, ['STALE_STATE'])).toBe('# Title short body with STALE_STATE here');
    expect(buildSnippet(content, ['STALE_STATE']).includes('…')).toBe(false);
  });

  it('returns empty for empty content', () => {
    expect(buildSnippet('', ['term'])).toBe('');
    expect(buildSnippet('   \n  ', ['term'])).toBe('');
  });

  it('honors a custom maxLen', () => {
    const content = `${filler} STALE_STATE rule ${filler}`;
    const snippet = buildSnippet(content, ['STALE_STATE'], { maxLen: 120 });
    expect(snippet.length).toBeLessThanOrEqual(122);
    expect(snippet).toContain('STALE_STATE');
  });

  it('never cuts a match out of the window when aligning to word boundaries', () => {
    const content = `short intro ${filler} THE_MATCH token ${filler}`;
    const snippet = buildSnippet(content, ['THE_MATCH']);
    expect(snippet).toContain('THE_MATCH');
  });
});
