/**
 * electron/memory/rag_index.ts — retrievable memory index (plan 428).
 *
 * After every successful curation run the worker rebuilds a small SQLite
 * index over the configured scan roots (the memory root is always first,
 * plus any user-supplied `[memory.rag].scan_paths`). Each document is
 * stored with an optional embedding vector (provider-framework resolved)
 * and mirrored into an FTS5 trigram table for keyword fallback.
 *
 * The index is rebuilt wholesale on each refresh — memory file counts are
 * small and the refresh runs at most once per curation cycle, so a full
 * rebuild keeps the index trivially consistent without incremental-diff
 * machinery.
 */

import type { Database } from 'better-sqlite3';
import * as fsSync from 'fs';
import * as fs from 'fs/promises';
import * as path from 'path';
import { loadBetterSqlite3Ctor } from '../memory-state/db';

/** Minimum embeddable client surface (AIClient.embed satisfies it). */
export interface EmbeddingClient {
  embed(texts: string[]): Promise<number[][]>;
}

export interface RagIndexOptions {
  /** SQLite index path (directory is created on demand). */
  dbPath: string;
  /** When false (or the client is null) embeddings are skipped. */
  embeddingEnabled: boolean;
  embeddingClient?: EmbeddingClient | null;
  /** Label recorded in `meta` (embedding provider/model, informational). */
  embeddingLabel?: string;
  now?: number;
}

export interface RagRefreshResult {
  documents: number;
  embedded: number;
  scanRoots: string[];
  durationMs: number;
}

/** Default index location. */
export function defaultRagIndexPath(homeDir: string): string {
  return path.join(homeDir, '.duya', 'rag', 'memory-rag.db');
}

/** Expand `~` in a user-supplied scan path. */
function expandHome(p: string, homeDir: string): string {
  if (p === '~') return homeDir;
  if (p.startsWith('~/') || p.startsWith('~\\')) return path.join(homeDir, p.slice(2));
  return p;
}

/**
 * Resolve the effective scan roots: the memory root always comes first,
 * then each configured scan path (absolute or `~`-prefixed), deduplicated
 * by resolved absolute path.
 */
export function resolveScanRoots(
  memoryRoot: string,
  scanPaths: string[],
  homeDir: string,
): string[] {
  const roots: string[] = [];
  const seen = new Set<string>();
  const push = (p: string): void => {
    const abs = path.resolve(p);
    if (seen.has(abs)) return;
    seen.add(abs);
    roots.push(abs);
  };
  push(memoryRoot);
  for (const p of scanPaths ?? []) {
    if (!p || typeof p !== 'string') continue;
    push(expandHome(p, homeDir));
  }
  return roots;
}

/**
 * Whether a relative path under a scan root is excluded from the index.
 * `isMemoryRoot` tightens the rules for the curated memory tree: generated
 * projections (MEMORY.md, summary.md, per-directory index.md), the
 * memory-config dir and tmp residue are not user
 * memory and never enter the index. User-authored extension files
 * (`extensions/ad_hoc/**`) are indexed.
 */
export function isExcluded(relPath: string, isMemoryRoot: boolean): boolean {
  const norm = relPath.replace(/\\/g, '/');
  const segs = norm.split('/');
  // VCS metadata and tmp residue are excluded at any depth, in every root.
  if (segs.includes('.git') || norm.endsWith('.tmp')) return true;
  if (!isMemoryRoot) return false;
  const base = segs[0] ?? norm;
  if (base === 'MEMORY.md' || base === 'summary.md' || base === 'stage1_policy.md') return true;
  if (base === 'memory-config' || base === '.git') return true;
  // Per-directory index projections (global/areas/index.md etc.).
  if (norm.endsWith('/index.md') || norm === 'index.md') return true;
  return false;
}

export interface ParsedDocument {
  root: string;
  relPath: string;
  title: string;
  content: string;
  updatedAt: number;
}

const TITLE_RE = /^#\s+(.+)$/m;
const MAX_CONTENT_CHARS = 8000;
const MAX_EMBED_CHARS = 2000;
const EMBED_BATCH_SIZE = 32;

/** Parse a memory markdown file into an indexable document. */
export function parseDocument(
  root: string,
  relPath: string,
  raw: string,
  mtimeMs: number,
): ParsedDocument {
  const titleMatch = raw.match(TITLE_RE);
  const title = titleMatch?.[1]?.trim() ?? path.basename(relPath, '.md');
  // Content = body minus the H1 line, truncated.
  const body = titleMatch ? raw.slice((titleMatch.index ?? 0) + titleMatch[0].length) : raw;
  const content = body.trim().slice(0, MAX_CONTENT_CHARS);
  return { root, relPath, title, content, updatedAt: Math.floor(mtimeMs) };
}

/** Recursively collect `.md` files under a scan root. */
async function collectMarkdownFiles(
  root: string,
  isMemoryRoot: boolean,
): Promise<Array<{ relPath: string; absPath: string }>> {
  const out: Array<{ relPath: string; absPath: string }> = [];
  const walk = async (dir: string, rel: string): Promise<void> => {
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return; // unreadable / missing scan root — skip silently
    }
    for (const entry of entries) {
      const relPath = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        if (entry.name === '.git' || entry.name === 'node_modules') continue;
        await walk(path.join(dir, entry.name), relPath);
        continue;
      }
      if (!entry.name.endsWith('.md')) continue;
      if (isExcluded(relPath, isMemoryRoot)) continue;
      out.push({ relPath, absPath: path.join(dir, entry.name) });
    }
  };
  await walk(root, '');
  return out;
}

/**
 * Rebuild the RAG index from disk. Best-effort by design: every failure
 * mode inside degrades (embedding unavailable → keyword-only) rather than
 * throwing; callers treat a throw as "index refresh failed" and skip.
 */
export async function refreshMemoryRagIndex(
  scanRoots: string[],
  opts: RagIndexOptions,
): Promise<RagRefreshResult> {
  const start = Date.now();
  const now = opts.now ?? start;
  const resolved = scanRoots.map((r) => path.resolve(r));

  // Collect + parse documents.
  const docs: ParsedDocument[] = [];
  for (const root of resolved) {
    const isMemoryRoot = root === resolved[0];
    const files = await collectMarkdownFiles(root, isMemoryRoot);
    for (const f of files) {
      let stat;
      let raw: string;
      try {
        stat = await fs.stat(f.absPath);
        raw = await fs.readFile(f.absPath, 'utf-8');
      } catch {
        continue; // raced with a write; skip
      }
      if (!stat.isFile()) continue;
      docs.push(parseDocument(root, f.relPath, raw, stat.mtimeMs));
    }
  }

  // Embed in batches; any failure degrades to keyword-only.
  let embedded = 0;
  const vectors: (number[] | null)[] = new Array(docs.length).fill(null);
  if (opts.embeddingEnabled && opts.embeddingClient && docs.length > 0) {
    try {
      const inputs = docs.map((d) =>
        `${d.title}\n${d.content.slice(0, MAX_EMBED_CHARS)}`,
      );
      for (let i = 0; i < inputs.length; i += EMBED_BATCH_SIZE) {
        const batch = inputs.slice(i, i + EMBED_BATCH_SIZE);
        const result = await opts.embeddingClient.embed(batch);
        for (let j = 0; j < result.length; j += 1) {
          const vec = result[j];
          if (Array.isArray(vec) && vec.length > 0) {
            vectors[i + j] = vec;
            embedded += 1;
          }
        }
      }
    } catch {
      // Embedding provider failure — fall through with keyword-only index.
      embedded = 0;
      vectors.fill(null);
    }
  }

  // Rebuild tables atomically.
  await writeIndex(resolved, docs, vectors, {
    dbPath: opts.dbPath,
    now,
    embedded,
    embeddingLabel: opts.embeddingLabel,
  });

  return {
    documents: docs.length,
    embedded,
    scanRoots: resolved,
    durationMs: Date.now() - start,
  };
}

async function writeIndex(
  scanRoots: string[],
  docs: ParsedDocument[],
  vectors: (number[] | null)[],
  opts: { dbPath: string; now: number; embedded: number; embeddingLabel?: string },
): Promise<void> {
  const Database = loadBetterSqlite3Ctor();
  const dir = path.dirname(opts.dbPath);
  fsSync.mkdirSync(dir, { recursive: true });

  const db: Database = new Database(opts.dbPath);
  try {
    db.pragma('busy_timeout = 5000');
    db.prepare(
      `CREATE TABLE IF NOT EXISTS documents (
        rowid INTEGER PRIMARY KEY AUTOINCREMENT,
        root TEXT NOT NULL,
        rel_path TEXT NOT NULL,
        title TEXT NOT NULL,
        content TEXT NOT NULL,
        updated_at INTEGER NOT NULL,
        embedding TEXT,
        UNIQUE(root, rel_path)
      )`,
    ).run();
    db.prepare(
      `CREATE VIRTUAL TABLE IF NOT EXISTS documents_fts USING fts5(title, content, tokenize='trigram')`,
    ).run();
    db.prepare(
      `CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)`,
    ).run();

    const insertDoc = db.prepare(
      'INSERT INTO documents (root, rel_path, title, content, updated_at, embedding) VALUES (?, ?, ?, ?, ?, ?)',
    );
    const insertFts = db.prepare(
      'INSERT INTO documents_fts (rowid, title, content) VALUES (?, ?, ?)',
    );
    const upsertMeta = db.prepare(
      'INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
    );

    db.transaction(() => {
      db.prepare('DELETE FROM documents_fts').run();
      db.prepare('DELETE FROM documents').run();
      docs.forEach((d, i) => {
        const vec = vectors[i];
        const info = insertDoc.run(
          d.root,
          d.relPath,
          d.title,
          d.content,
          d.updatedAt,
          vec ? JSON.stringify(vec) : null,
        );
        const rowid = info.lastInsertRowid as number;
        insertFts.run(rowid, d.title, d.content);
      });
      upsertMeta.run('built_at', String(opts.now));
      upsertMeta.run('embedding_enabled', String(opts.embedded > 0));
      upsertMeta.run('embedding_label', opts.embeddingLabel ?? '');
      upsertMeta.run('scan_roots', JSON.stringify(scanRoots));
    })();
  } finally {
    db.close();
  }
}
