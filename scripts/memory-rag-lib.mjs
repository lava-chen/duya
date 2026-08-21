#!/usr/bin/env node
/**
 * scripts/memory-rag-lib.mjs — shared core for the retrievable memory (RAG)
 * scripts (plan 428/430).
 *
 * Everything the `UserPromptSubmit` hook and the `memory-search` skill
 * script need in one dependency-free module (Node built-ins +
 * better-sqlite3 resolved via `DUYA_BETTER_SQLITE3_PATH` + native fetch):
 *
 *   - config: `[memory.rag]` from `~/.duya/config.toml` (+ secrets.json),
 *     embedding provider resolution through the provider framework config;
 *   - filtering: short / filler prompts ("继续", "你好", "ok", …) are
 *     dropped before retrieval costs anything;
 *   - retrieval: vector (cosine, best-effort) + FTS5 trigram keyword
 *     search, merged and ranked, top-N;
 *   - formatting: the `### 相关记忆` additionalContext block;
 *   - memory system log: append JSONL events mirroring
 *     packages/agent/src/memory-state/system_log.ts.
 *
 * Every function is fail-open: a missing index, a failed embed call, or a
 * log write never throws past its boundary.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

// ============================================================================
// Config
// ============================================================================

/** Config root: explicit override > DUYA_TEST namespace > ~/.duya. */
export function resolveConfigDir() {
  if (process.env.DUYA_RAG_CONFIG_DIR) {
    return path.resolve(process.env.DUYA_RAG_CONFIG_DIR);
  }
  if (process.env.DUYA_TEST === '1' && process.env.DUYA_TEST_NAMESPACE) {
    return path.join(os.homedir(), '.duya', 'test-namespaces', process.env.DUYA_TEST_NAMESPACE);
  }
  return path.join(os.homedir(), '.duya');
}

/** Minimal TOML parser covering the sections this module reads. */
export function parseToml(text) {
  const out = {};
  let section = null;
  for (const line of String(text).split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const sec = trimmed.match(/^\[([^\]]+)\]$/);
    if (sec) {
      section = sec[1].trim();
      continue;
    }
    const kv = trimmed.match(/^([A-Za-z0-9_.-]+)\s*=\s*(.+)$/);
    if (!kv) continue;
    const key = kv[1].trim();
    const value = parseTomlValue(kv[2].trim());
    if (section) {
      out[section] = out[section] ?? {};
      out[section][key] = value;
    } else {
      out[key] = value;
    }
  }
  return out;
}

function parseTomlValue(raw) {
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  if (/^-?\d+(\.\d+)?$/.test(raw)) return Number(raw);
  if (raw.startsWith('[') && raw.endsWith(']')) {
    return raw
      .slice(1, -1)
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
      .map((s) => (s.startsWith('"') ? s.slice(1, -1).replace(/\\"/g, '"') : s));
  }
  if (raw.startsWith('"') && raw.endsWith('"')) {
    return raw.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, '\\');
  }
  return raw;
}

export function readConfigToml(configDir) {
  const cfgPath = path.join(configDir, 'config.toml');
  if (!fs.existsSync(cfgPath)) return {};
  try {
    return parseToml(fs.readFileSync(cfgPath, 'utf8'));
  } catch {
    return {};
  }
}

export function readSecrets(configDir) {
  const secretsPath = path.join(configDir, 'secrets.json');
  if (!fs.existsSync(secretsPath)) return {};
  try {
    return JSON.parse(fs.readFileSync(secretsPath, 'utf8'));
  } catch {
    return {};
  }
}

export function readRagSettings(configDir) {
  const doc = readConfigToml(configDir);
  const rag = doc['memory.rag'];
  if (!rag || rag.enabled !== true) return null;
  const memory = doc.memory ?? {};
  return {
    indexPath: typeof rag.index_path === 'string' ? rag.index_path : '',
    embeddingEnabled: rag.embedding_enabled !== false,
    providerId: rag.embedding_provider || memory.provider || '',
    model: rag.embedding_model || memory.model || '',
  };
}

export function resolveIndexPath(configDir, configured) {
  if (!configured) return path.join(configDir, 'rag', 'memory-rag.db');
  const expanded = configured.startsWith('~/')
    ? path.join(os.homedir(), configured.slice(2))
    : configured;
  return path.resolve(expanded);
}

// ============================================================================
// Prompt filtering
// ============================================================================

/**
 * Short-message / filler filtering (user decision): a prompt shorter than
 * this many characters (after trimming) is not worth a retrieval pass.
 * "你好", "hi" — the hook skips them entirely. 3 keeps short CJK queries
 * ("五强溪", "调度图") retrievable while 2-char fillers stay filtered.
 */
export const MIN_PROMPT_CHARS = 3;

/** Filler phrases skipped even when they exceed the length threshold. */
const SHORT_PHRASES = new Set([
  // zh
  '继续', '继续继续', '继续吧', '继续啊', '再来', '再来一次', '你好', '你好你好',
  '好的', '好', '嗯', '哦', '哦哦', '谢谢', '谢谢您', '感谢', '辛苦', '辛苦了',
  '可以', '行', '好嘞', '收到', '了解', '知道了', '明白了', '可以了', '没问题了',
  '太好了', '厉害了', '明白', '懂了', '嗯嗯', '哦了',
  '再见', '拜拜', '没事', '没关系', '没问题', '是的', '对', '没错',
  // en
  'continue', 'go on', 'again', 'hi', 'hello', 'hey', 'ok', 'okay', 'k', 'kk',
  'yes', 'no', 'y', 'n', 'thanks', 'thank you', 'thx', 'ty', 'done', 'great',
  'bye', 'good', 'nice', 'cool', 'sure', 'got it', 'understood', 'right',
]);

/**
 * Decide whether a user prompt is worth a retrieval pass. Returns the
 * trimmed prompt (usable for retrieval) or `null` when the prompt is
 * empty, too short, or a known filler phrase.
 */
export function filterPrompt(prompt) {
  const trimmed = String(prompt ?? '').trim();
  if (trimmed.length === 0) return null;
  if (trimmed.length < MIN_PROMPT_CHARS) return null;
  const lower = trimmed.toLowerCase();
  if (SHORT_PHRASES.has(trimmed) || SHORT_PHRASES.has(lower)) return null;
  return trimmed;
}

// ============================================================================
// Embedding provider (provider framework config)
// ============================================================================

export function resolveProvider(configDir, settings) {
  if (!settings.embeddingEnabled || !settings.providerId || !settings.model) return null;
  const doc = readConfigToml(configDir);
  const entry = doc[`providers.${settings.providerId}`];
  if (!entry || !entry.providerType || !entry.baseUrl) return null;
  // Anthropic exposes no embeddings endpoint — degrade to keyword search.
  if (entry.providerType === 'anthropic') return null;
  const secrets = readSecrets(configDir);
  return {
    providerType: entry.providerType,
    baseUrl: String(entry.baseUrl),
    model: settings.model,
    apiKey: secrets[`providers.${settings.providerId}.apiKey`] || '',
  };
}

async function embedQuery(text, provider) {
  let url;
  let body;
  if (provider.providerType === 'ollama') {
    const base = provider.baseUrl.replace(/\/v1$/, '').replace(/\/$/, '');
    url = `${base}/api/embed`;
    body = { model: provider.model, input: [text] };
  } else {
    const base = provider.baseUrl.replace(/\/$/, '');
    url = `${base}/embeddings`;
    body = { model: provider.model, input: [text] };
  }
  const headers = { 'Content-Type': 'application/json' };
  if (provider.apiKey) headers.Authorization = `Bearer ${provider.apiKey}`;
  const res = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body) });
  if (!res.ok) throw new Error(`embed endpoint HTTP ${res.status}`);
  const data = await res.json();
  const vec = Array.isArray(data.embeddings) ? data.embeddings[0] : data.data?.[0]?.embedding;
  if (!Array.isArray(vec) || vec.length === 0) throw new Error('embed endpoint returned an unexpected payload');
  return vec;
}

// ============================================================================
// Retrieval
// ============================================================================

export function loadSqlite() {
  const customPath = process.env.DUYA_BETTER_SQLITE3_PATH;
  if (customPath) {
    try {
      const localRequire = createRequire(path.join(customPath, 'package.json'));
      return localRequire('better-sqlite3');
    } catch (err) {
      // Fall through to plain resolution — the packaged path may be
      // stale/missing in a dev checkout. The plain-require error (if any)
      // is more actionable for the developer than the packaged-path one.
      const wrapped = new Error(
        `DUYA_BETTER_SQLITE3_PATH (${customPath}) failed to load better-sqlite3: ${err instanceof Error ? err.message : String(err)}`,
      );
      wrapped.cause = err;
      console.warn(wrapped.message);
    }
  }
  try {
    return require('better-sqlite3');
  } catch (err) {
    // NODE_MODULE_VERSION mismatch (Electron-ABI build loaded under plain
    // Node, or vice versa). Convert the bare dlopen error into an
    // actionable message; fail-open callers degrade to empty context.
    const msg = err instanceof Error ? err.message : String(err);
    if (/NODE_MODULE_VERSION|was compiled against a different Node.js version/i.test(msg)) {
      throw new Error(
        'better-sqlite3 was compiled for a different Node ABI than this process. ' +
          'Run `npm run rebuild:node` for plain-Node (CLI/tests) usage, or `npm run rebuild` ' +
          '(electron-rebuild) for the Electron runtime. Original error: ' +
          msg,
      );
    }
    throw new Error(`better-sqlite3 failed to load: ${msg}`);
  }
}

function cosine(a, b) {
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

/** CJK ranges — 2-char CJK terms get a LIKE fallback (trigram needs >=3 chars). */
const CJK_RE = /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/;

/**
 * Extract the usable search terms from a prompt (the term selection used
 * inside keywordSearch): >=3-char tokens plus 2-char CJK tokens. Shared
 * with retrieve() so vector-only rows can carry the same term set for
 * snippet windowing (buildSnippet falls back to the body head when none
 * of the terms appear literally).
 */
export function extractTerms(prompt) {
  const cleaned = String(prompt ?? '')
    .replace(/["\\]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 60);
  const terms = cleaned
    .split(/\s+/)
    .map((t) => t.trim())
    .filter((t) => t.length >= 2);
  const trigramTerms = terms.filter((t) => t.length >= 3);
  const shortCjkTerms = terms.filter((t) => t.length === 2 && CJK_RE.test(t));
  // Only usable terms count for discovery AND scoring: 2-char non-CJK
  // tokens ("go", "ok") are noise — they would only dilute the ratio.
  return [...trigramTerms, ...shortCjkTerms];
}

// ============================================================================
// Snippet construction (term-windowed previews)
// ============================================================================

/** Default snippet window length (characters of normalized body text). */
export const SNIPPET_MAX_LEN = 220;

/** Fraction of the window allocated to context before the first match. */
const SNIPPET_BEFORE_FRACTION = 0.4;

/**
 * Drop a leading YAML frontmatter block (`---` … `---` with the closing
 * delimiter on its own line) so snippet windows start at the real body
 * instead of polluting the preview with metadata. Memory docs put their
 * Summary at the top of the body, so after stripping, the file-head
 * fallback window is the Summary again.
 */
export function stripFrontmatter(raw) {
  const text = String(raw ?? '');
  if (!/^---\s*\n/.test(text)) return text;
  const lines = text.split('\n');
  const close = lines.findIndex((l, i) => i > 0 && l.trim() === '---');
  if (close === -1) return text;
  return lines.slice(close + 1).join('\n');
}

/**
 * Build a snippet around the first literal occurrence of any query term
 * instead of the fixed file-head window. Vector-only hits (no literal
 * term) fall back to the body head. The output is single-line normalized
 * (whitespace collapsed), word-aligned at both ends, bounded to
 * `maxLen`, and prefixed/suffixed with "…" whenever the window does not
 * span the whole body — so a clipped preview is never mistaken for the
 * full document.
 */
export function buildSnippet(content, terms, opts = {}) {
  const maxLen = typeof opts.maxLen === 'number' ? opts.maxLen : SNIPPET_MAX_LEN;
  const body = stripFrontmatter(content);
  const norm = body.replace(/\s+/g, ' ').trim();
  if (!norm) return '';
  if (maxLen >= norm.length) return norm;

  const usable = (terms ?? [])
    .map((t) => String(t).trim().toLowerCase())
    .filter((t) => t.length >= 2)
    .filter((t, i, a) => a.indexOf(t) === i);

  const lower = norm.toLowerCase();
  let idx = -1;
  for (const t of usable) {
    const at = lower.indexOf(t);
    if (at >= 0 && (idx === -1 || at < idx)) idx = at;
  }

  let start;
  let end;
  if (idx === -1) {
    start = 0;
    end = Math.min(norm.length, maxLen);
  } else {
    const before = Math.floor(maxLen * SNIPPET_BEFORE_FRACTION);
    start = Math.max(0, idx - before);
    end = Math.min(norm.length, start + maxLen);
  }

  // Word-aligned boundaries: never start or end mid-word. Skipping past
  // the match itself (ws + 1 > idx) would defeat the windowing, so only
  // advance when the match survives. The trailing side trims a short
  // dangling partial word back instead of overshooting maxLen.
  if (start > 0) {
    const ws = norm.indexOf(' ', start);
    if (ws !== -1 && ws < end && ws + 1 <= idx) start = ws + 1;
  }
  if (end < norm.length) {
    const lastWs = norm.lastIndexOf(' ', end);
    if (lastWs > idx && end - lastWs < 24) end = lastWs;
  }

  const slice = norm.slice(start, end).trim();
  return (start > 0 ? '…' : '') + slice + (end < norm.length ? '…' : '');
}

/**
 * FTS5 trigram match over prompt terms (OR semantics, CJK friendly) plus
 * a LIKE fallback for 2-char CJK terms (调度/钩子 — trigram cannot form a
 * 2-gram token). Rows are ranked by bm25 (not arbitrary rowid order) and
 * scored by the matched-term ratio, so keyword hits stay comparable with
 * vector cosine scores: a doc matching every term scores 1.0, a doc
 * matching one of four scores 0.25. Malformed queries return no hits.
 */
export function keywordSearch(db, prompt) {
  const usableTerms = extractTerms(prompt);
  if (usableTerms.length === 0) return [];
  const trigramTerms = usableTerms.filter((t) => t.length >= 3);
  const shortCjkTerms = usableTerms.filter((t) => t.length === 2);

  // Candidate set keyed by rowid, shared by both sources (dedupes hits).
  const candidates = new Map(); // rowid -> { row, matched: Set<string> }
  if (trigramTerms.length > 0) {
    // A bare quoted term is a phrase match (terms must appear adjacently);
    // OR them so any single term hits, which matters for trigram tokenizers.
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
        .all(matchExpr);
      for (const r of rows) candidates.set(r.rowid, { row: r, matched: new Set() });
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
      for (const r of like.all(pattern, pattern)) {
        if (!candidates.has(r.rowid)) candidates.set(r.rowid, { row: r, matched: new Set() });
      }
    }
  }

  // Count matched terms on the (small) candidate set. Case-folded so
  // ASCII terms agree with the case-insensitive FTS5 trigram tokenizer.
  const out = [];
  for (const { row, matched } of candidates.values()) {
    const haystack = `${row.title}\n${row.content}`.toLowerCase();
    for (const t of usableTerms) {
      if (haystack.includes(t.toLowerCase())) matched.add(t);
    }
    if (matched.size === 0) continue;
    out.push({
      rowid: row.rowid,
      root: row.root,
      rel_path: row.rel_path,
      title: row.title,
      content: row.content,
      score: matched.size / usableTerms.length,
      // Literal terms found in this row — snippet windowing anchors on
      // the earliest occurrence (vector-only rows carry extractTerms()).
      matched_terms: [...matched],
    });
  }
  out.sort((a, b) => b.score - a.score);
  return out;
}

/**
 * Retrieve the top memories for a prompt. Returns
 * `{ rows, mode, fallbackReason }` where `mode` is
 * 'vector' | 'hybrid' | 'keyword' and `fallbackReason` records why vector
 * retrieval degraded (empty when vector search ran or was never available).
 */
export async function retrieve(dbPath, prompt, provider, settings) {
  const Database = loadSqlite();
  const db = new Database(dbPath);
  try {
    const rows = db
      .prepare('SELECT rowid, root, rel_path, title, content, embedding FROM documents')
      .all();
    if (rows.length === 0) return { rows: [], mode: 'keyword', fallbackReason: '' };

    const scored = []; // { row, score, cos? }
    let vectorUsed = false;
    let keywordUsed = false;
    let fallbackReason = '';

    // Vector retrieval (best-effort; any failure degrades to keywords).
    if (provider) {
      try {
        const queryVec = await embedQuery(prompt, provider);
        vectorUsed = true;
        for (const r of rows) {
          if (!r.embedding) continue;
          let vec;
          try {
            vec = JSON.parse(r.embedding);
          } catch {
            continue;
          }
          const score = cosine(queryVec, vec);
          if (score > 0) {
            // Vector rows carry the prompt terms for snippet windowing;
            // buildSnippet falls back to the body head when no term
            // appears literally (semantic-only match).
            scored.push({ row: { ...r, matched_terms: extractTerms(prompt) }, score, cos: score });
          }
        }
      } catch (err) {
        // Record the degradation reason for the system log, then fall
        // through to keyword search.
        fallbackReason = err instanceof Error ? err.message : String(err);
      }
    }

    // Keyword retrieval — always available, merges with vector hits.
    for (const k of keywordSearch(db, prompt)) {
      keywordUsed = true;
      const existing = scored.find((s) => s.row.rel_path === k.rel_path && s.row.root === k.root);
      if (existing) existing.score = Math.max(existing.score, k.score);
      else scored.push({ row: k, score: k.score, cos: 0 });
    }

    // Keyword ratio ties (e.g. two docs matching every term) break on the
    // semantic cosine so rowid order never decides the ranking.
    scored.sort((a, b) => b.score - a.score || (b.cos ?? 0) - (a.cos ?? 0));
    const mode = !provider ? 'keyword' : vectorUsed ? (keywordUsed ? 'hybrid' : 'vector') : 'keyword';
    // Plan 437: cap the hit list at 3 (down from 5). Plan 430 sent up to
    // 5 full bodies which bloated the additionalContext block; the new
    // hybrid (full body for top hit, snippet for the rest) keeps the
    // top hit informative while the breadcrumb previews stay cheap.
    return { rows: scored.slice(0, 3).map((s) => s.row), mode, fallbackReason };
  } finally {
    db.close();
  }
}

// ============================================================================
// Context formatting
// ============================================================================

/**
 * Per-hit body cap (chars of the frontmatter-stripped body) used by
 * {@link formatContext} for the **top hit only**. The top hit is the
 * memory the user is most likely asking about — plan 430 ships its
 * full body so the model doesn't have to spend a tool call to read it.
 * Lower-ranked hits fall back to {@link SNIPPET_MAX_LEN}-windowed
 * snippets around the matched terms, since per plan 430 the previous
 * snippet-only design was useless for the top hit but is acceptable as
 * a breadcrumb for the rest (the path stays visible so the model can
 * `read` any of them on demand).
 */
export const FORMAT_TOP_HIT_BODY_CHARS = 4_000;

/**
 * Window length used by {@link formatContext} for non-top hits —
 * identical to {@link SNIPPET_MAX_LEN} so the breadcrumb preview keeps
 * the same readability characteristics as a free-standing snippet.
 */
export const FORMAT_OTHER_HIT_SNIPPET_CHARS = SNIPPET_MAX_LEN;

/**
 * Total additionalContext budget. The hook executor caps JSON stdout at
 * 64 KB and the model context is the bigger ceiling; we use 8 KB so the
 * rendered block stays small enough to read at a glance, and a low-
 * ranked hit can be dropped instead of the block being arbitrarily
 * clipped mid-paragraph. Plan 430 used 24 KB (top-5 full bodies) which
 * the user reported as too noisy in the chat-flow hook row (plan 437);
 * this keeps the top hit intact and snippets everything else.
 */
export const FORMAT_TOTAL_CHARS = 8_000;

/**
 * Render retrieved rows as the injected `### 相关记忆` context block.
 *
 * Hybrid (plan 437): the top hit ships its full body so the model has
 * the answer in-context (plan 430 contract — the previous snippet-only
 * output was useless because the path is rarely readable mid-session
 * and snippets miss the part of the doc the user is asking about).
 * Lower-ranked hits ship a {@link buildSnippet}-windowed preview around
 * the matched terms + path, so the model can decide which one to read
 * in full via the `read` tool. Bodies are hard-capped per-hit
 * ({@link FORMAT_TOP_HIT_BODY_CHARS} / {@link SNIPPET_MAX_LEN}) and the
 * union is hard-capped to {@link FORMAT_TOTAL_CHARS}; lower-ranked hits
 * are dropped (not clipped mid-doc) when the union would exceed the
 * total budget, so the highest-scored memories always land intact.
 *
 * @param hits  ordered rows from `retrieve()` (already relevance-ranked).
 * @param opts  perHitBody override (testing); total override (testing).
 */
export function formatContext(hits, opts = {}) {
  if (!Array.isArray(hits) || hits.length === 0) return '';
  const topBody = typeof opts.perHitBody === 'number' ? opts.perHitBody : FORMAT_TOP_HIT_BODY_CHARS;
  const total = typeof opts.total === 'number' ? opts.total : FORMAT_TOTAL_CHARS;

  const blocks = [];
  let used = '### 相关记忆'.length;
  for (let i = 0; i < hits.length; i += 1) {
    const h = hits[i];
    const body = stripFrontmatter(String(h.content ?? '')).trim();
    let bodySlice;
    let truncated = false;
    if (i === 0) {
      // Top hit: full body (plan 430 contract), hard-capped.
      bodySlice = body;
      if (bodySlice.length > topBody) {
        bodySlice = bodySlice.slice(0, topBody);
        truncated = true;
      }
    } else {
      // Non-top hit: snippet windowed around the matched terms (or the
      // body head when no term matches — vector-only rows). Snippet
      // anchors on the prompt's terms so the breadcrumb actually shows
      // the part the user asked about.
      bodySlice = buildSnippet(body, h.matched_terms ?? [], {
        maxLen: FORMAT_OTHER_HIT_SNIPPET_CHARS,
      });
      if (!bodySlice) {
        // Empty body or zero-length snippet — drop this hit whole rather
        // than emit a useless empty bullet.
        continue;
      }
    }
    const header = `- ${h.title}\n  path: ${path.join(h.root, h.rel_path)}`;
    const block = truncated
      ? `${header}\n\n${bodySlice}\n\n<!-- read-full: this hit was truncated to ${topBody} chars; the path above points at the full memory file -->`
      : `${header}\n\n${bodySlice}`;
    const blockLen = block.length + 2; // trailing "\n\n" between hits
    if (used + blockLen > total) {
      // Lower-ranked hits are dropped whole — never half-clipped.
      break;
    }
    blocks.push(block);
    used += blockLen;
  }
  if (blocks.length === 0) return '';
  return ['### 相关记忆', ...blocks].join('\n\n');
}

// ============================================================================
// Memory system log (mirror of packages/agent/src/memory-state/system_log.ts)
// ============================================================================

/** Daily JSONL path under `<configDir>/memory-system-log/YYYY/MM/DD.jsonl`. */
export function systemLogPath(ts, configDir) {
  const d = new Date(ts);
  const pad = (n) => String(n).padStart(2, '0');
  return path.join(
    configDir,
    'memory-system-log',
    String(d.getFullYear()),
    pad(d.getMonth() + 1),
    `${pad(d.getDate())}.jsonl`,
  );
}

/**
 * Append one event to the memory system log. Best-effort: never throws,
 * so a logging failure cannot break retrieval. Line format matches
 * `writeSystemLog` in packages/agent/src/memory-state/system_log.ts.
 */
export function appendSystemLog(configDir, { eventType, level = 'info', message, detail = null, sessionId = null }) {
  try {
    const ts = Date.now();
    const entry = {
      ts,
      phase: 'system',
      event_type: eventType,
      level,
      message,
      detail: detail === null || detail === undefined ? null : detail,
      rollout_id: null,
      run_id: null,
      session_id: sessionId ?? null,
    };
    const filePath = systemLogPath(ts, configDir);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.appendFileSync(filePath, JSON.stringify(entry) + '\n', 'utf8');
  } catch {
    // Best-effort logging — never break the hook on a log write failure.
  }
}
