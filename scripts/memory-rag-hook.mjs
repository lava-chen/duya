#!/usr/bin/env node
/**
 * scripts/memory-rag-hook.mjs — UserPromptSubmit hook for the retrievable
 * memory index (plan 428).
 *
 * Reads the plan-428 index built by the memory worker
 * (`~/.duya/rag/memory-rag.db`), retrieves the top memories for the user's
 * prompt, and emits them as `{"additionalContext": "..."}` on stdout so the
 * agent's UserPromptSubmit hook injection surfaces them in the first turn.
 *
 * Contract (plan 87 hooks):
 *   - stdin: JSON { session_id, cwd, hook_event_name, prompt }
 *   - stdout: JSON { additionalContext } (or empty — fail-open)
 *   - exit code: always 0; a failure degrades to empty context.
 *
 * Dependencies: Node built-ins + better-sqlite3 (resolved via
 * `DUYA_BETTER_SQLITE3_PATH` like the agent subprocess) + native fetch.
 * The embedding provider resolves through the provider framework config
 * (`[providers.<id>]` in `~/.duya/config.toml` + `~/.duya/secrets.json`),
 * mirroring `electron/memory/rag_embedding_client.ts`.
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
function resolveConfigDir() {
  if (process.env.DUYA_RAG_CONFIG_DIR) {
    return path.resolve(process.env.DUYA_RAG_CONFIG_DIR);
  }
  if (process.env.DUYA_TEST === '1' && process.env.DUYA_TEST_NAMESPACE) {
    return path.join(os.homedir(), '.duya', 'test-namespaces', process.env.DUYA_TEST_NAMESPACE);
  }
  return path.join(os.homedir(), '.duya');
}

/** Minimal TOML parser covering the sections this hook reads. */
function parseToml(text) {
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

function readConfigToml(configDir) {
  const cfgPath = path.join(configDir, 'config.toml');
  if (!fs.existsSync(cfgPath)) return {};
  try {
    return parseToml(fs.readFileSync(cfgPath, 'utf8'));
  } catch {
    return {};
  }
}

function readSecrets(configDir) {
  const secretsPath = path.join(configDir, 'secrets.json');
  if (!fs.existsSync(secretsPath)) return {};
  try {
    return JSON.parse(fs.readFileSync(secretsPath, 'utf8'));
  } catch {
    return {};
  }
}

function readRagSettings(configDir) {
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

function resolveIndexPath(configDir, configured) {
  if (!configured) return path.join(configDir, 'rag', 'memory-rag.db');
  const expanded = configured.startsWith('~/')
    ? path.join(os.homedir(), configured.slice(2))
    : configured;
  return path.resolve(expanded);
}

// ============================================================================
// Embedding provider (provider framework config)
// ============================================================================

function resolveProvider(configDir, settings) {
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

function loadSqlite() {
  const customPath = process.env.DUYA_BETTER_SQLITE3_PATH;
  if (customPath) {
    const localRequire = createRequire(path.join(customPath, 'package.json'));
    return localRequire('better-sqlite3');
  }
  return require('better-sqlite3');
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

/** FTS5 trigram substring match; malformed queries return no hits. */
function keywordSearch(db, prompt) {
  const cleaned = prompt.replace(/["\\]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 30);
  if (cleaned.length < 3) return [];
  try {
    return db
      .prepare(
        `SELECT d.rowid, d.root, d.rel_path, d.title, d.content, 1 AS score
         FROM documents_fts f JOIN documents d ON d.rowid = f.rowid
         WHERE documents_fts MATCH ? LIMIT 8`,
      )
      .all(JSON.stringify(cleaned));
  } catch {
    return [];
  }
}

async function retrieve(dbPath, prompt, provider, settings) {
  const Database = loadSqlite();
  const db = new Database(dbPath);
  try {
    const rows = db
      .prepare('SELECT rowid, root, rel_path, title, content, embedding FROM documents')
      .all();
    if (rows.length === 0) return [];

    const scored = [];

    // Vector retrieval (best-effort; any failure degrades to keywords).
    if (provider) {
      try {
        const queryVec = await embedQuery(prompt, provider);
        for (const r of rows) {
          if (!r.embedding) continue;
          let vec;
          try {
            vec = JSON.parse(r.embedding);
          } catch {
            continue;
          }
          const score = cosine(queryVec, vec);
          if (score > 0) scored.push({ row: r, score });
        }
      } catch {
        // fall through to keyword search
      }
    }

    // Keyword retrieval — always available, merges with vector hits.
    for (const k of keywordSearch(db, prompt)) {
      const existing = scored.find((s) => s.row.rel_path === k.rel_path && s.row.root === k.root);
      if (existing) existing.score = Math.max(existing.score, k.score);
      else scored.push({ row: k, score: k.score });
    }

    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, 5).map((s) => s.row);
  } finally {
    db.close();
  }
}

function formatContext(hits) {
  if (hits.length === 0) return '';
  const lines = ['### 相关记忆'];
  for (const h of hits) {
    const summary = String(h.content ?? '').replace(/\s+/g, ' ').trim().slice(0, 160);
    lines.push(`- ${h.title}`);
    if (summary) lines.push(`  ${summary}`);
    lines.push(`  path: ${path.join(h.root, h.rel_path)}`);
  }
  return lines.join('\n');
}

// ============================================================================
// Entry
// ============================================================================

function readStdin() {
  try {
    const raw = fs.readFileSync(0, 'utf8');
    if (!raw.trim()) return {};
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

async function main() {
  const input = readStdin();
  const prompt = typeof input.prompt === 'string' ? input.prompt : '';
  if (!prompt) {
    process.exit(0);
  }

  const configDir = resolveConfigDir();
  const settings = readRagSettings(configDir);
  if (!settings) {
    process.exit(0);
  }

  const dbPath = resolveIndexPath(configDir, settings.indexPath);
  if (!fs.existsSync(dbPath)) {
    process.exit(0);
  }

  const provider = resolveProvider(configDir, settings);

  try {
    const hits = await retrieve(dbPath, prompt, provider, settings);
    const context = formatContext(hits);
    if (!context) {
      process.exit(0);
    }
    process.stdout.write(JSON.stringify({ additionalContext: context }));
    process.exit(0);
  } catch (err) {
    process.stderr.write(`memory-rag-hook: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(0);
  }
}

main();
