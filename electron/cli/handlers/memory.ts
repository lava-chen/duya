/**
 * electron/cli/handlers/memory.ts
 *
 * CLI API handlers for `duya memory doctor` / `duya memory setup` /
 * `duya memory status` / `duya memory enable|disable|set` (plan 431).
 *
 * - `doctor` (read-only): machine evaluation (CPU / RAM / disk / low-power)
 *   + current `[memory.rag]` config + an embedding provider/model
 *   recommendation. Evaluation logic lives here, one place — the retrieval
 *   hook script never evaluates hardware.
 * - `setup` (write): enable `[memory.rag]` and set the embedding
 *   provider/model (explicit or `auto` → recommendation).
 * - `status` (read-only): config + index state (documents / embedding).
 * - `config` (write): single `memory.rag.<path>` value writes.
 */

import * as http from 'http';
import * as os from 'os';
import * as fs from 'fs';
import * as path from 'path';
import { getConfigStore } from '../../config/store-instance';
import { getProviderStore } from '../../services/providers/provider-store-electron';
import { defaultRagIndexPath } from '../../memory/rag_index';
import { rebuildRagIndexNow } from '../../memory/rag_refresh';
import { searchMemoryIndex } from '../../memory/rag_search';

// ---------------------------------------------------------------------------
// JSON helpers (mirror voice.ts / config.ts conventions)
// ---------------------------------------------------------------------------

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(text),
  });
  res.end(text);
}

function readBody(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise<Record<string, unknown>>((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf-8');
      if (text.length === 0) {
        resolve({});
        return;
      }
      try {
        const obj = JSON.parse(text) as unknown;
        if (obj && typeof obj === 'object' && !Array.isArray(obj)) {
          resolve(obj as Record<string, unknown>);
        } else {
          reject(new Error('request body must be a JSON object'));
        }
      } catch (err) {
        reject(new Error(`malformed JSON body: ${err instanceof Error ? err.message : String(err)}`));
      }
    });
    req.on('error', reject);
  });
}

// ---------------------------------------------------------------------------
// Machine evaluation + recommendation
// ---------------------------------------------------------------------------

export type RamTier = 'low' | 'mid' | 'high';

export function evaluateMachine(): {
  cpuCores: number;
  ramGb: number;
  ramTier: RamTier;
  diskFreeGb: number;
  lowPower: boolean;
} {
  const cpuCores = os.cpus().length;
  const ramGb = os.totalmem() / (1024 * 1024 * 1024);
  const ramTier: RamTier = ramGb < 8 ? 'low' : ramGb < 16 ? 'mid' : 'high';

  let diskFreeGb = -1;
  try {
    const memRoot = path.join(os.homedir(), '.duya', 'memory');
    if (fs.existsSync(memRoot)) {
      const stats = fs.statfsSync(memRoot);
      diskFreeGb = (stats.bavail * stats.bsize) / (1024 * 1024 * 1024);
    } else {
      // Fall back to the home volume where the memory root will be created.
      const homeStats = fs.statfsSync(os.homedir());
      diskFreeGb = (homeStats.bavail * homeStats.bsize) / (1024 * 1024 * 1024);
    }
  } catch {
    // statfs unavailable (rare) — report unknown.
  }

  const lowPower = process.env.DUYA_LOW_POWER === '1' || process.env.DUYA_LOW_POWER === 'true';
  return { cpuCores, ramGb, ramTier, diskFreeGb, lowPower };
}

interface RagConfigSnapshot {
  enabled: boolean;
  index_path: string;
  scan_paths: string[];
  embedding_enabled: boolean;
  embedding_provider: string;
  embedding_model: string;
}

function readRagConfig(): RagConfigSnapshot {
  const cfg = (getConfigStore().getByPath('memory.rag') ?? {}) as Partial<RagConfigSnapshot>;
  return {
    enabled: cfg.enabled === true,
    index_path: typeof cfg.index_path === 'string' ? cfg.index_path : '',
    scan_paths: Array.isArray(cfg.scan_paths) ? cfg.scan_paths.map(String) : [],
    embedding_enabled: cfg.embedding_enabled !== false,
    embedding_provider: typeof cfg.embedding_provider === 'string' ? cfg.embedding_provider : '',
    embedding_model: typeof cfg.embedding_model === 'string' ? cfg.embedding_model : '',
  };
}

/** Resolve the configured index db path (default `~/.duya/rag/memory-rag.db`). */
function resolveIndexPath(cfg: RagConfigSnapshot): string {
  if (cfg.index_path && cfg.index_path.trim() !== '') {
    const p = cfg.index_path.trim();
    return p.startsWith('~/') ? path.join(os.homedir(), p.slice(2)) : path.resolve(p);
  }
  return defaultRagIndexPath(os.homedir());
}

function readIndexState(cfg: RagConfigSnapshot): { exists: boolean; documents: number; embeddingActive: boolean } {
  const dbPath = resolveIndexPath(cfg);
  if (!fs.existsSync(dbPath)) return { exists: false, documents: 0, embeddingActive: false };
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const Database = require('better-sqlite3') as new (p: string) => {
      prepare(sql: string): { get(...a: unknown[]): unknown; all(...a: unknown[]): unknown[] };
      close(): void;
    };
    const db = new Database(dbPath);
    try {
      const docs = (db.prepare('SELECT COUNT(*) AS n FROM documents').get() as { n: number })?.n ?? 0;
      const meta = db.prepare("SELECT value FROM meta WHERE key = 'embedding_enabled'").get() as { value?: string } | undefined;
      return { exists: true, documents: docs, embeddingActive: meta?.value === 'true' };
    } finally {
      db.close();
    }
  } catch {
    return { exists: true, documents: 0, embeddingActive: false };
  }
}

/**
 * Recommend an embedding provider/model. Rules:
 * - Explicit `[memory.rag]` config wins → report as-is.
 * - The memory provider is usable for embeddings unless it is Anthropic
 *   (no embeddings API) — then recommend a local ollama setup or accept
 *   keyword-only degradation.
 * - Local recommendation tiers by RAM: low → nomic-embed-text, else bge-m3.
 */
export function recommendEmbedding(store: {
  getMemoryLlmProvider(): { id: string; apiFormat?: string; providerType?: string } | undefined;
}): { provider: string; model: string; rationale: string } {
  const cfg = readRagConfig();
  if (cfg.embedding_provider && cfg.embedding_model) {
    return {
      provider: cfg.embedding_provider,
      model: cfg.embedding_model,
      rationale: 'already configured — keeping the explicit [memory.rag] choice',
    };
  }
  const memProvider = store.getMemoryLlmProvider();
  if (memProvider) {
    const isAnthropic =
      memProvider.apiFormat === 'anthropic' || memProvider.providerType === 'anthropic';
    if (!isAnthropic) {
      return {
        provider: memProvider.id,
        model: '',
        rationale: 'the memory provider supports embeddings — model falls back to the memory model',
      };
    }
  }
  const machine = evaluateMachine();
  if (machine.ramTier === 'low') {
    return {
      provider: 'ollama',
      model: 'nomic-embed-text',
      rationale: 'low-RAM machine — local ollama with a small embedding model keeps memory overhead minimal',
    };
  }
  return {
    provider: 'ollama',
    model: 'bge-m3',
    rationale: 'local ollama embedding model; the default memory provider is Anthropic (no embeddings API) or unset',
  };
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

/** GET /v1/memory/doctor — machine evaluation + current config + recommendation. */
export function handleMemoryDoctor(req: http.IncomingMessage, res: http.ServerResponse): void {
  try {
    const machine = evaluateMachine();
    const cfg = readRagConfig();
    const index = readIndexState(cfg);
    const recommendation = recommendEmbedding(getProviderStore());
    sendJson(res, 200, {
      ok: true,
      machine,
      current: {
        enabled: cfg.enabled,
        embeddingProvider: cfg.embedding_provider,
        embeddingModel: cfg.embedding_model,
        scanPaths: cfg.scan_paths,
        indexExists: index.exists,
      },
      recommendation,
    });
  } catch (err) {
    sendJson(res, 500, { ok: false, error: err instanceof Error ? err.message : String(err) });
  }
}

/**
 * POST /v1/memory/setup — enable `[memory.rag]` and set the embedding
 * provider/model. `auto: true` uses the backend recommendation; explicit
 * `provider` / `model` override it. An Anthropic provider is rejected.
 */
export async function handleMemorySetup(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  try {
    const body = await readBody(req);
    const providerStore = getProviderStore();

    let provider: string | undefined;
    let model: string | undefined;
    if (body.auto === true) {
      const rec = recommendEmbedding(providerStore);
      provider = rec.provider;
      model = rec.model;
    } else {
      provider = typeof body.provider === 'string' && body.provider ? body.provider : undefined;
      model = typeof body.model === 'string' && body.model ? body.model : undefined;
    }
    if (!provider) {
      sendJson(res, 400, { ok: false, error: 'provider is required (use --auto or pass --provider)' });
      return;
    }

    // Validate the provider exists in the provider framework.
    const llm = providerStore.getLlmProvider(provider);
    if (!llm) {
      sendJson(res, 400, {
        ok: false,
        error: `provider "${provider}" not found in the provider framework`,
      });
      return;
    }
    const isAnthropic = llm.apiFormat === 'anthropic' || (llm as { providerType?: string }).providerType === 'anthropic';
    if (isAnthropic) {
      sendJson(res, 400, {
        ok: false,
        error: 'Anthropic has no embeddings API — pick an OpenAI-compatible or ollama provider for memory RAG',
      });
      return;
    }

    const current = readRagConfig();
    getConfigStore().set('memory.rag', {
      enabled: true,
      index_path: current.index_path,
      scan_paths: current.scan_paths,
      embedding_enabled: current.embedding_enabled,
      embedding_provider: provider,
      embedding_model: model ?? '',
    });
    sendJson(res, 200, { ok: true, enabled: true, provider, model: model ?? '' });
  } catch (err) {
    sendJson(res, 500, { ok: false, error: err instanceof Error ? err.message : String(err) });
  }
}

/** GET /v1/memory/status — config + index state. */
export function handleMemoryStatus(req: http.IncomingMessage, res: http.ServerResponse): void {
  try {
    const cfg = readRagConfig();
    const index = readIndexState(cfg);
    sendJson(res, 200, {
      ok: true,
      enabled: cfg.enabled,
      embeddingProvider: cfg.embedding_provider,
      embeddingModel: cfg.embedding_model,
      indexPath: resolveIndexPath(cfg),
      scanPaths: cfg.scan_paths,
      indexExists: index.exists,
      documents: index.documents,
      embeddingActive: index.embeddingActive,
    });
  } catch (err) {
    sendJson(res, 500, { ok: false, error: err instanceof Error ? err.message : String(err) });
  }
}

/** POST /v1/memory/rebuild — rebuild the retrievable memory index now. */
export async function handleMemoryRebuild(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  try {
    const result = await rebuildRagIndexNow();
    if (!result.ok) {
      sendJson(res, 400, result);
      return;
    }
    sendJson(res, 200, result);
  } catch (err) {
    sendJson(res, 500, { ok: false, error: err instanceof Error ? err.message : String(err) });
  }
}

/** POST /v1/memory/search — search the retrievable memory index. */
export async function handleMemorySearch(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  try {
    const body = await readBody(req);
    const query = typeof body.query === 'string' ? body.query.trim() : '';
    if (!query) {
      sendJson(res, 400, { ok: false, error: 'query is required' });
      return;
    }
    const limit =
      typeof body.limit === 'number' && Number.isFinite(body.limit)
        ? Math.min(Math.max(Math.floor(body.limit), 1), 20)
        : undefined;
    const result = await searchMemoryIndex(query, { limit });
    if (!result.ok) {
      sendJson(res, 400, result);
      return;
    }
    sendJson(res, 200, result);
  } catch (err) {
    sendJson(res, 500, { ok: false, error: err instanceof Error ? err.message : String(err) });
  }
}

/** POST /v1/memory/config — write a single `memory.rag.<path>` value. */
export async function handleMemoryConfig(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  try {
    const body = await readBody(req);
    const key = typeof body.path === 'string' ? body.path.trim() : '';
    if (!key) {
      sendJson(res, 400, { ok: false, error: 'path is required (e.g. enabled, embedding_provider, scan_paths)' });
      return;
    }
    if (!Object.prototype.hasOwnProperty.call(body, 'value')) {
      sendJson(res, 400, { ok: false, error: 'value is required' });
      return;
    }
    const allowed = new Set(['enabled', 'index_path', 'scan_paths', 'embedding_enabled', 'embedding_provider', 'embedding_model']);
    if (!allowed.has(key)) {
      sendJson(res, 400, { ok: false, error: `unknown memory.rag key: ${key}` });
      return;
    }
    // `scan_paths` must stay an array. A JSON-array string (e.g. from
    // `duya memory set scan_paths '["~/notes"]'`) is normalized here so a
    // bad client can never persist a string that readRagConfig() then
    // silently drops (bug report 2026-08-19 #5).
    if (key === 'scan_paths') {
      let value = body.value;
      if (typeof value === 'string') {
        const trimmed = value.trim();
        if (trimmed === '') {
          value = [];
        } else if (trimmed.startsWith('[')) {
          try {
            const parsed = JSON.parse(trimmed) as unknown;
            if (Array.isArray(parsed)) {
              value = parsed.map(String);
            } else {
              sendJson(res, 400, { ok: false, error: 'scan_paths must be a JSON array of strings' });
              return;
            }
          } catch {
            sendJson(res, 400, { ok: false, error: 'scan_paths must be a JSON array of strings' });
            return;
          }
        } else {
          // Single path shorthand.
          value = [value];
        }
      } else if (Array.isArray(value)) {
        value = value.map(String);
      } else {
        sendJson(res, 400, { ok: false, error: 'scan_paths must be a JSON array of strings' });
        return;
      }
      getConfigStore().set('memory.rag.scan_paths', value);
      sendJson(res, 200, { ok: true, path: key, value });
      return;
    }
    getConfigStore().set(`memory.rag.${key}`, body.value);
    sendJson(res, 200, { ok: true, path: key, value: body.value });
  } catch (err) {
    sendJson(res, 500, { ok: false, error: err instanceof Error ? err.message : String(err) });
  }
}
