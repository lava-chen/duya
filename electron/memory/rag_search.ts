/**
 * electron/memory/rag_search.ts — direct search over the retrievable
 * memory index (plan 428/430 follow-up).
 *
 * Backs the CLI `duya memory search <query>` (POST /v1/memory/search).
 * Same retrieval semantics as `scripts/memory-rag-lib.mjs` (the hook
 * core): vector cosine ranking when an embedding provider is configured,
 * FTS5 trigram keyword fallback, merged and ranked, top-N.
 *
 * TS-side query gate is intentionally lighter than the hook's
 * `filterPrompt`: the CLI is an explicit search, so only a minimum length
 * applies (the hook additionally skips filler phrases like "继续"/"ok").
 */

import * as os from 'os';
import * as path from 'path';
import type { Database } from 'better-sqlite3';
import { getConfigStore } from '../config/store-instance';
import { getProviderStore } from '../services/providers/provider-store-electron';
import { defaultRagIndexPath, type EmbeddingClient } from './rag_index';
import { createEmbeddingClient } from './rag_embedding_client';
import { loadBetterSqlite3Ctor } from '../memory-state/db';
import { buildSnippet, extractTerms } from './rag_snippet';

/** CLI-side minimum query length (mirrors MIN_PROMPT_CHARS in the hook). */
export const MIN_QUERY_CHARS = 3;

export interface RagSearchHit {
  title: string;
  /** Path relative to the scan root. */
  path: string;
  snippet: string;
  score: number;
}

export interface RagSearchOk {
  ok: true;
  mode: 'vector' | 'hybrid' | 'keyword';
  skipped: boolean;
  hits: RagSearchHit[];
}

export interface RagSearchErr {
  ok: false;
  error: string;
}

export type RagSearchResult = RagSearchOk | RagSearchErr;

interface RagSearchConfig {
  enabled: boolean;
  dbPath: string;
  embeddingEnabled: boolean;
  providerId: string;
  modelId: string;
}

function readRagConfig(): RagSearchConfig {
  const cfg = (getConfigStore().getByPath('memory.rag') ?? {}) as Partial<{
    enabled?: boolean;
    index_path?: string;
    embedding_enabled?: boolean;
    embedding_provider?: string;
    embedding_model?: string;
  }>;
  const homeDir = os.homedir();
  const configured = typeof cfg.index_path === 'string' && cfg.index_path.trim() !== '';
  return {
    enabled: cfg.enabled === true,
    dbPath: configured
      ? path.resolve(cfg.index_path!.trim())
      : defaultRagIndexPath(homeDir),
    embeddingEnabled: cfg.embedding_enabled !== false,
    providerId: typeof cfg.embedding_provider === 'string' ? cfg.embedding_provider : '',
    modelId: typeof cfg.embedding_model === 'string' ? cfg.embedding_model : '',
  };
}

function cosine(a: number[], b: number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  const len = Math.min(a.length, b.length);
  for (let i = 0; i < len; i += 1) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  const denom = Math.sqrt(na) * Math.sqrt(nb);
  return denom === 0 ? 0 : dot / denom;
}

interface ScoredRow {
  root: string;
  relPath: string;
  title: string;
  content: string;
  score: number;
  /** Semantic cosine, kept for tie-breaking keyword-ratio ties. */
  cos?: number;
  /** Query terms to anchor the snippet window on (may be empty for vector-only hits). */
  matchedTerms?: string[];
}

/**
 * FTS5 trigram OR-semantics keyword search (mirrors the hook core) plus a
 * LIKE fallback for 2-char CJK terms. Rows are ranked by bm25 and scored
 * by the matched-term ratio so keyword hits stay comparable with vector
 * cosine scores instead of flooding the merge with a constant 1.0.
 */
function keywordSearch(db: Database, query: string): ScoredRow[] {
  const usableTerms = extractTerms(query);
  if (usableTerms.length === 0) return [];
  const trigramTerms = usableTerms.filter((t) => t.length >= 3);
  const shortCjkTerms = usableTerms.filter((t) => t.length === 2);

  // Candidate set keyed by rowid, shared by both sources (dedupes hits).
  const candidates = new Map<number, { row: ScoredRow; matched: Set<string> }>();
  if (trigramTerms.length > 0) {
    const matchExpr = trigramTerms.map((t) => `"${t}"`).join(' OR ');
    try {
      const rows = db
        .prepare(
          `SELECT d.rowid, d.root, d.rel_path, d.title, d.content,
                  bm25(documents_fts) AS rank
           FROM documents_fts JOIN documents d ON d.rowid = documents_fts.rowid
           WHERE documents_fts MATCH ?
           ORDER BY rank LIMIT 20`,
        )
        .all(matchExpr) as Array<{
        rowid: number;
        root: string;
        rel_path: string;
        title: string;
        content: string;
      }>;
      for (const r of rows) {
        candidates.set(r.rowid, {
          row: { root: r.root, relPath: r.rel_path, title: r.title, content: r.content, score: 0 },
          matched: new Set<string>(),
        });
      }
    } catch {
      // Malformed MATCH expression — no trigram candidates.
    }
  }
  if (shortCjkTerms.length > 0) {
    const like = db.prepare(
      `SELECT rowid, root, rel_path, title, content FROM documents
       WHERE title LIKE ? OR content LIKE ?`,
    );
    for (const t of shortCjkTerms) {
      const pattern = `%${t}%`;
      for (const r of like.all(pattern, pattern) as Array<{
        rowid: number;
        root: string;
        rel_path: string;
        title: string;
        content: string;
      }>) {
        if (!candidates.has(r.rowid)) {
          candidates.set(r.rowid, {
            row: { root: r.root, relPath: r.rel_path, title: r.title, content: r.content, score: 0 },
            matched: new Set<string>(),
          });
        }
      }
    }
  }

  // Count matched terms on the (small) candidate set. Case-folded so
  // ASCII terms agree with the case-insensitive FTS5 trigram tokenizer.
  const out: ScoredRow[] = [];
  for (const { row, matched } of candidates.values()) {
    const haystack = `${row.title}\n${row.content}`.toLowerCase();
    for (const t of usableTerms) {
      if (haystack.includes(t.toLowerCase())) matched.add(t);
    }
    if (matched.size === 0) continue;
    out.push({ ...row, score: matched.size / usableTerms.length, matchedTerms: [...matched] });
  }
  out.sort((a, b) => b.score - a.score);
  return out;
}

/**
 * Search the retrievable memory index. Vector-first (best-effort; a
 * provider without an embeddings endpoint, or a failed embed call,
 * degrades to keyword), merged with FTS5 keyword hits, ranked by score.
 */
export async function searchMemoryIndex(
  query: string,
  opts?: { limit?: number },
): Promise<RagSearchResult> {
  const trimmed = query.trim();
  if (trimmed.length === 0 || trimmed.length < MIN_QUERY_CHARS) {
    return { ok: true, mode: 'keyword', skipped: true, hits: [] };
  }

  const cfg = readRagConfig();
  if (!cfg.enabled) {
    return {
      ok: false,
      error:
        'RAG is not enabled — enable [memory.rag] first (duya memory setup, or Settings → Memory → Retrieval)',
    };
  }

  let embeddingClient: EmbeddingClient | null = null;
  try {
    if (cfg.embeddingEnabled) {
      embeddingClient = createEmbeddingClient(getProviderStore(), {
        providerId: cfg.providerId || undefined,
        modelId: cfg.modelId || undefined,
      });
    }
  } catch {
    // Degrade to keyword-only.
  }

  const Database = loadBetterSqlite3Ctor();
  let db: Database;
  try {
    db = new Database(cfg.dbPath);
  } catch {
    return {
      ok: false,
      error: `RAG index not found at ${cfg.dbPath} — run 'duya memory rebuild' first`,
    };
  }

  try {
    const rows = db
      .prepare('SELECT rowid, root, rel_path, title, content, embedding FROM documents')
      .all() as Array<{
      rowid: number;
      root: string;
      rel_path: string;
      title: string;
      content: string;
      embedding: string | null;
    }>;
    if (rows.length === 0) return { ok: true, mode: 'keyword', skipped: false, hits: [] };

    const scored: ScoredRow[] = [];
    let vectorUsed = false;
    let keywordUsed = false;

    if (embeddingClient) {
      try {
        const [queryVec] = await embeddingClient.embed([trimmed]);
        if (queryVec && queryVec.length > 0) {
          vectorUsed = true;
          for (const r of rows) {
            if (!r.embedding) continue;
            let vec: number[];
            try {
              vec = JSON.parse(r.embedding) as number[];
            } catch {
              continue;
            }
            const score = cosine(queryVec, vec);
            if (score > 0) {
              scored.push({
                root: r.root,
                relPath: r.rel_path,
                title: r.title,
                content: r.content,
                score,
                cos: score,
                matchedTerms: extractTerms(trimmed),
              });
            }
          }
        }
      } catch {
        // Embedding call failed — fall through to keyword search.
      }
    }

    for (const k of keywordSearch(db, trimmed)) {
      keywordUsed = true;
      const existing = scored.find((s) => s.relPath === k.relPath && s.root === k.root);
      if (existing) existing.score = Math.max(existing.score, k.score);
      else scored.push({ ...k, cos: 0 });
    }

    // Keyword ratio ties (e.g. two docs matching every term) break on the
    // semantic cosine so rowid order never decides the ranking.
    scored.sort((a, b) => b.score - a.score || (b.cos ?? 0) - (a.cos ?? 0));
    const mode = !embeddingClient ? 'keyword' : vectorUsed ? (keywordUsed ? 'hybrid' : 'vector') : 'keyword';
    const limit = Math.min(Math.max(opts?.limit ?? 5, 1), 20);
    const hits: RagSearchHit[] = scored.slice(0, limit).map((s) => ({
      title: s.title,
      path: path.join(s.root, s.relPath),
      snippet: buildSnippet(s.content, s.matchedTerms),
      score: s.score,
    }));
    return { ok: true, mode, skipped: false, hits };
  } finally {
    db.close();
  }
}
